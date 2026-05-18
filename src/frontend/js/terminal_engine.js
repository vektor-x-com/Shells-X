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
// An adapter with marker='' (legacy PHP) reads "everything that doesn't
// start with any OTHER known marker" — so registering a shell adapter with
// '$ ' automatically excludes those rows from the PHP adapter's view.
function _cmdMatchesAdapter(cmd, adapterId) {
  const adapter = _adapters[adapterId];
  if (!adapter) return false;
  if (adapter.historyMarker) return cmd.startsWith(adapter.historyMarker);
  // Empty marker: claim everything not claimed by another adapter.
  for (const other of Object.values(_adapters)) {
    if (other === adapter) continue;
    if (other.historyMarker && cmd.startsWith(other.historyMarker)) return false;
  }
  return true;
}

function _stripMarker(cmd, marker) {
  return marker && cmd.startsWith(marker) ? cmd.slice(marker.length) : cmd;
}

function _initSnippets(adapter) {
  const container = document.getElementById(adapter.snippetEl);
  if (!container) return;
  container.append(...adapter.snippets.map(([label, code]) => {
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
      adapter.history = rows
        .filter(r => r && r.cmd && _cmdMatchesAdapter(r.cmd, adapter.id))
        .map(r => _stripMarker(r.cmd, adapter.historyMarker))
        .reverse();
      adapter.histIdx = adapter.history.length;
    })
    .catch(() => { /* IDB unavailable — history stays empty, no functional break */ });
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

  // Track local history (dedupe consecutive identical entries).
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

  adapter.inFlight = true;
  const fd = new FormData();
  fd.append('action', adapter.runAction);
  fd.append(adapter.codeField, code);
  if (adapter.timeoutField) fd.append(adapter.timeoutField, adapter.timeoutValue);
  if (adapter.beforeRun) adapter.beforeRun(fd, code);

  fetchJSON(fd)
    .then(data => {
      if (data.error) streamAppend(adapter.outputEl, 'err', '[err] ' + data.error);
      const out = (data.output || '').replace(/\n+$/, '');
      if (out) streamAppend(adapter.outputEl, 'out', out);
      else if (!data.error) streamAppend(adapter.outputEl, 'out', '(no output)');
      if (adapter.afterRun) adapter.afterRun(data);
      streamSep(adapter.outputEl);
      dbPut('history', {
        cmd: (adapter.historyMarker || '') + code,
        out: data.output || data.error || '',
        error: data.error || null,
        ts: new Date().toISOString(),
      });
    })
    .catch(err => {
      streamAppend(adapter.outputEl, 'err', '[err] Request error: ' + String(err));
      streamSep(adapter.outputEl);
    })
    .finally(() => { adapter.inFlight = false; });
}

function bind(config) {
  const adapter = Object.assign({ history: [], histIdx: -1, inFlight: false }, config);
  _adapters[adapter.id] = adapter;
  _initSnippets(adapter);
  _initHistory(adapter);
  _initKeydown(adapter);
}

window.Terminal = { bind, streamAppend, streamSep, streamClear, streamCopy, streamDownload };

// Inline `onclick="streamClear(...)"` handlers in card headers expect these
// as globals. Re-export so the header buttons keep working without HTML edits.
window.streamAppend   = streamAppend;
window.streamSep      = streamSep;
window.streamClear    = streamClear;
window.streamCopy     = streamCopy;
window.streamDownload = streamDownload;
