// ==================== OS SHELL ====================
let shellAvailable = false;
let shellMethod = '';
let shellCwd = '';
let shellHistory = [];
let shellHistIdx = -1;

// Populate history from IndexedDB on init so Ctrl+↑ steps through prior
// sessions immediately, not just commands run this page-load. We filter to
// OS-shell entries (PHP eval entries don't start with "$ ").
if (typeof dbGetAll === 'function') {
  dbGetAll('history')
    .then(rows => {
      shellHistory = rows
        .filter(r => r && r.cmd && r.cmd.startsWith('$ '))
        .map(r => r.cmd.slice(2))
        .reverse();
      shellHistIdx = shellHistory.length;
    })
    .catch(() => { /* IDB unavailable — history stays empty */ });
}

function probeShell() {
  const card = document.getElementById('os-shell-card');
  const status = document.getElementById('os-shell-status');
  const fd = new FormData();
  fd.append('action', 'shell');
  fd.append('cmd', '');

  fetchJSON(fd)
    .then(data => {
      if (data.available) {
        shellAvailable = true;
        shellMethod = data.method;
        shellCwd = data.cwd;
        card.style.display = 'block';
        status.innerHTML = '<span class="badge badge-ok">&#x2714; OS shell via <b>' + escHtml(shellMethod) + '()</b></span>';
        document.getElementById('os-shell-prompt').textContent = shellCwd + ' $';
        document.getElementById('os-shell-input').placeholder = 'shell command  ·  Enter runs  ·  Shift+Enter newline  ·  Ctrl+↑/↓ history  ·  Ctrl+L clear';
      } else {
        card.style.display = 'block';
        status.innerHTML = '<span class="badge badge-no">&#x2716; No exec function available</span>';
        document.getElementById('os-shell-input').disabled = true;
        document.getElementById('os-shell-input').placeholder = 'OS shell unavailable — all exec functions are disabled';
      }
    })
    .catch(() => {
      card.style.display = 'block';
      status.innerHTML = '<span class="badge badge-no">&#x2716; Probe failed</span>';
    });
}

let _shellInFlight = false;

function runShellCmd() {
  if (_shellInFlight) return;   // serialise to keep output ordered (see console.js note)
  const input = document.getElementById('os-shell-input');
  const cmd = input.value.trim();
  if (!cmd || !shellAvailable) return;

  // Track history (dedupe consecutive identical entries).
  if (shellHistory[shellHistory.length - 1] !== cmd) shellHistory.push(cmd);
  shellHistIdx = shellHistory.length;

  // Echo command into the shared terminal stream so we get coloring +
  // scrollback parity with the PHP Console — same look, same Clear/Copy/
  // Download header actions, same overflow trimming.
  streamAppend('os-shell-output', 'cmd', shellCwd + ' $ ' + cmd);
  input.value = '';

  _shellInFlight = true;
  const fd = new FormData();
  fd.append('action', 'shell');
  fd.append('cmd', cmd);
  fd.append('cwd', shellCwd);
  fd.append('timeout', '30');

  fetchJSON(fd)
    .then(data => {
      if (data.error) {
        streamAppend('os-shell-output', 'err', '[err] ' + data.error);
      } else {
        const out = (data.output || '').replace(/\n+$/, '');
        if (out) streamAppend('os-shell-output', 'out', out);
        if (data.truncated) streamAppend('os-shell-output', 'err', '[output truncated — exceeded 5MB limit]');
        shellCwd = data.cwd || shellCwd;
        document.getElementById('os-shell-prompt').textContent = shellCwd + ' $';
      }
      streamSep('os-shell-output');
      dbPut('history', { cmd: '$ ' + cmd, out: data.output || data.error || '', ts: new Date().toISOString() });
    })
    .catch(err => {
      streamAppend('os-shell-output', 'err', '[err] Request error: ' + String(err));
      streamSep('os-shell-output');
    })
    .finally(() => { _shellInFlight = false; });
}

// Shell input key handling. Guarded against missing element so a module-trim
// build (or DOM-shape change in layout) can't take down the rest of the bundle
// at script load time — that would leave `let _db = null` in db.js stuck in
// TDZ for everything below, breaking the scanner / file browser / history.
(function() {
  const input = document.getElementById('os-shell-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    // Enter (alone) submits, Shift+Enter keeps the newline. Same shape as
    // the PHP Console composer — both behave identically as terminal-style
    // textareas where multi-line is opt-in via Shift.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      runShellCmd();
      return;
    }
    // History: Ctrl modifier so plain arrows still navigate within the
    // multi-line textarea naturally (matches PHP Console behavior).
    if (e.ctrlKey && e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shellHistory.length) return;
      if (shellHistIdx > 0) shellHistIdx--;
      else shellHistIdx = 0;
      e.target.value = shellHistory[shellHistIdx] || '';
      return;
    }
    if (e.ctrlKey && e.key === 'ArrowDown') {
      e.preventDefault();
      if (shellHistIdx < shellHistory.length - 1) {
        shellHistIdx++;
        e.target.value = shellHistory[shellHistIdx];
      } else {
        shellHistIdx = shellHistory.length;
        e.target.value = '';
      }
      return;
    }
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      streamClear('os-shell-output');
    }
  });
})();

// Probe on load — wrap so a malformed probe response can't abort the bundle.
try { probeShell(); } catch (e) { console.warn('probeShell failed:', e); }
