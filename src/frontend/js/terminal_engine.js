// ==================== TERMINAL ENGINE ====================
// Generic, language-agnostic terminal machinery. Adapters (terminal_php.js,
// terminal_shell.js, future terminal_python.js, …) call Terminal.bind(cfg)
// to declare a card's snippets + prompt + run-action; this file does the
// rest (streaming, composer wiring, history, snippet buttons, run lifecycle).

const STREAM_MAX_ENTRIES = 2000;
const STREAM_BOTTOM_THRESHOLD = 24;   // px tolerance for "user is at bottom"

function _streamAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STREAM_BOTTOM_THRESHOLD;
}

function streamAppend(streamId, type, text) {
  const el = document.getElementById(streamId);
  if (!el || text === undefined || text === null || text === '') return;
  const wasAtBottom = _streamAtBottom(el);
  const div = document.createElement('div');
  div.className = 'stream-' + type;   // stream-cmd | stream-out | stream-err | stream-sep
  div.textContent = text;
  el.appendChild(div);
  // Cap scrollback so a 5MB phpinfo() can't OOM the tab on long sessions.
  while (el.childElementCount > STREAM_MAX_ENTRIES) el.removeChild(el.firstChild);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function streamSep(streamId) {
  const el = document.getElementById(streamId);
  if (!el) return;
  const wasAtBottom = _streamAtBottom(el);
  const sep = document.createElement('div');
  sep.className = 'stream-sep';
  el.appendChild(sep);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function _streamText(el) {
  const parts = [];
  for (const child of el.children) {
    if (child.classList.contains('stream-sep')) parts.push('');
    else parts.push(child.textContent);
  }
  return parts.join('\n');
}

function streamClear(streamId) {
  const el = document.getElementById(streamId);
  if (el) el.textContent = '';
}

function streamCopy(streamId) {
  const el = document.getElementById(streamId);
  if (!el) return;
  clipCopy(_streamText(el));
}

function streamDownload(streamId, prefix) {
  const el = document.getElementById(streamId);
  if (!el) return;
  const blob = new Blob([_streamText(el)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (prefix || 'stream') + '_' + Date.now() + '.txt';
  a.click();
}

// ==================== ADAPTER REGISTRY ====================

const _adapters = {};

// Markers (e.g. '$ ' for shell) partition the shared `history` IDB store.
// A catch-all adapter (marker='') declares foreign markers via `excludeMarkers`
// so partitioning is deterministic regardless of bind order. (Earlier version
// peeked at other adapters at load time — that broke when PHP's history loaded
// before the async shell-probe bind, since the engine didn't yet know about
// '$ '.)
function _cmdMatchesAdapter(cmd, adapterId) {
  const adapter = _adapters[adapterId];
  if (!adapter) return false;
  if (adapter.historyMarker) return cmd.startsWith(adapter.historyMarker);
  for (const m of adapter.excludeMarkers) {
    if (cmd.startsWith(m)) return false;
  }
  return true;
}

function _stripMarker(cmd, marker) {
  return marker && cmd.startsWith(marker) ? cmd.slice(marker.length) : cmd;
}

function _initSnippets(adapter) {
  const container = document.getElementById(adapter.snippetEl);
  if (!container) return;
  container.append(...(adapter.snippets || []).map(([label, code]) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm btn-secondary';
    b.textContent = label;
    b.addEventListener('click', () => {
      const input = document.getElementById(adapter.inputEl);
      if (!input) return;
      input.value = code;
      input.focus();
    });
    return b;
  }));
}

function _initHistory(adapter) {
  if (typeof dbGetAll !== 'function') return;
  dbGetAll('history')
    .then(rows => {
      // history is sorted newest-first by db.js; reverse so ↑ steps backward
      // through time naturally.
      const fromIdb = rows
        .filter(r => r && r.cmd && _cmdMatchesAdapter(r.cmd, adapter.id))
        .map(r => _stripMarker(r.cmd, adapter.historyMarker))
        .reverse();
      // Remember the command the operator was recalling (if any) so we can
      // restore their nav position by content after dedup may have shifted
      // indices. Index-arithmetic preservation breaks once entries are
      // collapsed; content-addressing survives.
      const currentCmd = (adapter.histIdx >= 0 && adapter.histIdx < adapter.history.length)
        ? adapter.history[adapter.histIdx]
        : null;
      // Prepend prior-session history to whatever the operator pushed during
      // the IDB-load window. In-memory pushes are sync and canonical; IDB load
      // is treated as "older history" prefix data. This eliminates the race
      // where a command run during IDB load would otherwise be clobbered.
      const merged = fromIdb.concat(adapter.history);
      // Consecutive-dedup — same shape as _run's local push dedup and as
      // bash HISTIGNOREDUPS. Collapses the common "ran X last session, ran X
      // first this session" duplicate at the IDB/local boundary.
      adapter.history = merged.filter((cmd, i) => cmd !== merged[i - 1]);
      const restored = currentCmd !== null ? adapter.history.lastIndexOf(currentCmd) : -1;
      adapter.histIdx = restored >= 0 ? restored : adapter.history.length;
    })
    .catch(() => { /* IDB unavailable — in-memory history still works for this session */ });
}

function _initKeydown(adapter) {
  const input = document.getElementById(adapter.inputEl);
  if (!input) return;
  input.addEventListener('keydown', e => {
    // Enter (alone) submits; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      _run(adapter.id);
      return;
    }
    // History nav: plain ↑/↓ when caret is on the edge line of the textarea
    // (so multi-line cursor nav still works mid-buffer). Ctrl+↑/↓ forces
    // history regardless of caret position.
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey) {
      const before = e.target.value.substring(0, e.target.selectionStart);
      if (e.ctrlKey || !before.includes('\n')) {
        e.preventDefault();
        if (!adapter.history.length) return;
        if (adapter.histIdx <= 0) adapter.histIdx = 0;
        else adapter.histIdx--;
        e.target.value = adapter.history[adapter.histIdx] || '';
        return;
      }
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey) {
      const after = e.target.value.substring(e.target.selectionEnd);
      if (e.ctrlKey || !after.includes('\n')) {
        e.preventDefault();
        if (adapter.histIdx < adapter.history.length - 1) {
          adapter.histIdx++;
          e.target.value = adapter.history[adapter.histIdx];
        } else {
          adapter.histIdx = adapter.history.length;
          e.target.value = '';
        }
        return;
      }
    }
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      streamClear(adapter.outputEl);
    }
  });
}

function _run(adapterId) {
  const adapter = _adapters[adapterId];
  if (!adapter || adapter.inFlight) return;   // serialise per-adapter
  const input = document.getElementById(adapter.inputEl);
  if (!input) return;
  const code = input.value.trim();
  if (!code) return;
  if (adapter.gate && !adapter.gate()) return;   // adapter can veto (e.g. shell unavailable)

  // SYNC push to in-memory history — this is the canonical store ↑/↓ reads.
  // IDB write below is fire-and-forget; IDB load on bind prepends prior-
  // session entries. Treating in-memory as canonical (instead of letting
  // async IDB ops overwrite it) is what keeps history race-free.
  // Dedupe consecutive identical entries.
  if (adapter.history[adapter.history.length - 1] !== code) adapter.history.push(code);
  adapter.histIdx = adapter.history.length;

  // Echo into stream. Lines after the first use contPrompt so a 20-line paste
  // still reads naturally.
  const linePrefix = adapter.echoPrefix ? adapter.echoPrefix() : adapter.prompt;
  const codeLines = code.split('\n');
  codeLines.forEach((line, i) => {
    streamAppend(adapter.outputEl, 'cmd', (i === 0 ? linePrefix + ' ' : adapter.contPrompt + ' ') + line);
  });
  input.value = '';

  // Build request — guarded so a throwing adapter.beforeRun can't leave
  // inFlight=true forever (would permanently lock the adapter, silently
  // dropping every subsequent submit).
  const fd = new FormData();
  try {
    fd.append('action', adapter.runAction);
    fd.append(adapter.codeField, code);
    if (adapter.timeoutField) fd.append(adapter.timeoutField, adapter.timeoutValue);
    if (adapter.beforeRun) adapter.beforeRun(fd, code);
  } catch (err) {
    streamAppend(adapter.outputEl, 'err', '[err] Request setup failed: ' + String(err));
    streamSep(adapter.outputEl);
    return;
  }

  adapter.inFlight = true;
  fetchJSON(fd)
    .then(data => {
      if (data.error) streamAppend(adapter.outputEl, 'err', '[err] ' + data.error);
      const out = (data.output || '').replace(/\n+$/, '');
      if (out) streamAppend(adapter.outputEl, 'out', out);
      else if (!data.error) streamAppend(adapter.outputEl, 'out', '(no output)');
      if (adapter.afterRun) {
        // Same reason as beforeRun: don't let an adapter callback abort the
        // result-rendering flow (history write below) or trip the .catch.
        try { adapter.afterRun(data); }
        catch (err) { streamAppend(adapter.outputEl, 'err', '[err] afterRun failed: ' + String(err)); }
      }
      streamSep(adapter.outputEl);
      dbPut('history', {
        cmd: (adapter.historyMarker || '') + code,
        out: data.output || data.error || '',
        error: data.error || null,
        ts: new Date().toISOString() + '#' + Math.random().toString(36).slice(2, 10),
      });
    })
    .catch(err => {
      streamAppend(adapter.outputEl, 'err', '[err] Request error: ' + String(err));
      streamSep(adapter.outputEl);
    })
    .finally(() => { adapter.inFlight = false; });
}

// Write adapter-declared labels into the card header so adapters are the
// source of truth (engine API matches what the UI actually shows). The
// layout pre-seeds `.card-header-name` and `.card-header-label` spans —
// targeting those keeps us from clobbering siblings like the OS-shell
// status badge that lives inside `.card-header-left`.
function _initLabels(adapter) {
  const card = document.getElementById(adapter.outputEl)?.closest('.card');
  if (!card) return;
  const nameEl = card.querySelector('.card-header-name');
  if (nameEl && adapter.displayName) nameEl.textContent = adapter.displayName;
  const labelEl = card.querySelector('.card-header-label');
  if (labelEl) {
    if (adapter.hintsLabel) {
      labelEl.textContent = adapter.hintsLabel + ':';
      labelEl.hidden = false;
    } else {
      labelEl.hidden = true;
    }
  }
}

function bind(config) {
  const adapter = Object.assign({
    history: [],
    histIdx: -1,
    inFlight: false,
    snippets: [],
    excludeMarkers: [],
  }, config);
  _adapters[adapter.id] = adapter;
  _initLabels(adapter);
  _initSnippets(adapter);
  _initHistory(adapter);
  _initKeydown(adapter);
}

function clearTerminalHistory() {
  Object.keys(_adapters).forEach(id => {
    _adapters[id].history = [];
    _adapters[id].histIdx = -1;
  });
}

window.Terminal = {
  bind, clearTerminalHistory,
  streamAppend, streamSep, streamClear, streamCopy, streamDownload,
};

// Inline `onclick="streamClear(...)"` handlers in card headers expect these
// as globals. Re-export so the header buttons keep working without HTML edits.
window.streamAppend   = streamAppend;
window.streamSep      = streamSep;
window.streamClear    = streamClear;
window.streamCopy     = streamCopy;
window.streamDownload = streamDownload;
