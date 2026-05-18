// ==================== TERMINAL STREAM ====================
// Shared append-only stream used by both PHP Console and OS Shell.
// Each entry is a <div> tagged with a class (.stream-cmd / .stream-out /
// .stream-err) so the same monospace stream visually separates what you
// typed, what came back, and what blew up — without the brittle
// `textContent +=` pattern that loses styling per entry.
const STREAM_MAX_ENTRIES = 2000;
const STREAM_BOTTOM_THRESHOLD = 24;   // px tolerance for "user is at bottom"

// True when the user is scrolled to (or very near) the bottom of the stream.
// We only auto-scroll on append when this is true — otherwise a long phpinfo()
// arriving while the operator is scrolled up reading old output would yank
// them back to the bottom.
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
  // Visual-only divider — no text in the DOM (would render as a blank line
  // because the stream uses white-space:pre-wrap). Copy/download inserts
  // its own newline between entries by walking children below.
  el.appendChild(sep);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

// Walk children, emitting one entry per line and an extra blank line at each
// stream-sep so copy/download produces something human-readable instead of
// a wall of mashed-together text.
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

// ==================== PHP CONSOLE ====================
function insertCode(code) {
  const ta = document.getElementById('console-input');
  ta.value = code;
  ta.focus();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-code]');
  if (btn) insertCode(btn.dataset.code);
});

const snippets = [
  ['scandir',     "print_r(scandir('.'));"],
  ['/etc/passwd', "echo file_get_contents('/etc/passwd');"],
  ['phpinfo',     "phpinfo();"],
  ['uname',       "echo php_uname();"],
  ['traceroute',  `// Edit IP_HERE and the port, then run. Returns hop count to that service —
// compare two ports on the same IP: same TTL = service on host, higher TTL = DNAT/port-forward.
$ip='IP_HERE'; $port=80; $max=30; $timeout=2;
if (!extension_loaded('sockets')) { echo "needs PHP sockets extension\\n"; return; }
// Accept hostname or IP; bail clean on garbage so we don't misreport TTL=1.
if (!filter_var($ip, FILTER_VALIDATE_IP)) {
  $r = gethostbyname($ip);
  if ($r === $ip || !filter_var($r, FILTER_VALIDATE_IP)) { echo "can't resolve '$ip'\\n"; return; }
  $ip = $r;
}
// PHP sockets ext doesn't expose IP_TTL as a named constant; 2 = Linux, 4 = BSD.
$IP_TTL = defined('IP_TTL') ? IP_TTL : (PHP_OS_FAMILY==='BSD'||PHP_OS_FAMILY==='Darwin' ? 4 : 2);
$socks=[];
for ($t=1; $t<=$max; $t++) {
  $s=@socket_create(AF_INET,SOCK_STREAM,SOL_TCP);
  if ($s===false) continue;
  socket_set_option($s,IPPROTO_IP,$IP_TTL,$t);
  socket_set_nonblock($s);
  @socket_connect($s,$ip,$port);
  $socks[$t]=$s;
}
$w=$socks; $r=$e=null;
socket_select($r,$w,$e,$timeout);
// Only sockets in $w (writable after select) actually had a connect transition.
// SO_ERROR on sockets that never made it into $w is 0 by default — would falsely
// read as TTL=1 if iterated over $socks.
$hops=null;
foreach ($w as $ttl=>$s) {
  $err=socket_get_option($s,SOL_SOCKET,SO_ERROR);
  if (($err===0||$err===111) && ($hops===null||$ttl<$hops)) $hops=$ttl;
}
foreach ($socks as $s) socket_close($s);
echo $hops===null ? "no answer in $max hops\\n" : "TTL to $ip:$port = $hops\\n";`],
];

// Guarded — if the layout was trimmed or the element renamed, we don't want
// a top-level `.append` on null to abort the entire bundle and TDZ-cascade
// every module below console.js (db's `_db` survives because db.js is above,
// but scanner/tunnel/faraday/destruct top-level init would all silently die).
(function () {
  const container = document.getElementById('snippet-buttons');
  if (!container) return;
  container.append(...snippets.map(([label, code]) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm btn-secondary';
    b.textContent = label;
    b.dataset.code = code;
    return b;
  }));
})();

// Per-tab history (separate from OS shell history). Ctrl+Up/Down navigates.
// Populated from IndexedDB on init so Ctrl+↑ works immediately on a fresh
// page load — otherwise the array was empty until you ran a command.
let _phpHistory = [];
let _phpHistIdx = -1;

if (typeof dbGetAll === 'function') {
  dbGetAll('history')
    .then(rows => {
      // history is sorted newest-first by db.js; reverse to oldest-first so
      // Ctrl+↑ steps backward through time naturally. Filter to PHP-shaped
      // entries (OS shell entries start with "$ ").
      _phpHistory = rows
        .filter(r => r && r.cmd && !r.cmd.startsWith('$ '))
        .map(r => r.cmd)
        .reverse();
      _phpHistIdx = _phpHistory.length;
    })
    .catch(() => { /* IDB unavailable — history stays empty, no functional break */ });
}

(function () {
  const input = document.getElementById('console-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
  // Enter (alone) submits; Shift+Enter inserts a newline. Same shape as
  // OS Shell so the two composers behave identically.
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    runCode();
    return;
  }
  // History nav: plain ↑/↓ when the caret is on the edge line of the
  // textarea (so multi-line cursor nav still works mid-buffer). Ctrl+↑/↓
  // forces history regardless of caret position.
  if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey) {
    const before = e.target.value.substring(0, e.target.selectionStart);
    if (e.ctrlKey || !before.includes('\n')) {
      e.preventDefault();
      if (!_phpHistory.length) return;
      if (_phpHistIdx <= 0) _phpHistIdx = 0;
      else _phpHistIdx--;
      e.target.value = _phpHistory[_phpHistIdx] || '';
      return;
    }
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey) {
    const after = e.target.value.substring(e.target.selectionEnd);
    if (e.ctrlKey || !after.includes('\n')) {
      e.preventDefault();
      if (_phpHistIdx < _phpHistory.length - 1) {
        _phpHistIdx++;
        e.target.value = _phpHistory[_phpHistIdx];
      } else {
        _phpHistIdx = _phpHistory.length;
        e.target.value = '';
      }
      return;
    }
  }
  if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    streamClear('console-output');
  }
});
})();

let _phpInFlight = false;

function runCode() {
  if (_phpInFlight) return;   // serialise: previous run's output must land before the next echo
  const ta = document.getElementById('console-input');
  const code = ta.value.trim();
  if (!code) return;

  // Push to local history (dedupe consecutive identical entries).
  if (_phpHistory[_phpHistory.length - 1] !== code) _phpHistory.push(code);
  _phpHistIdx = _phpHistory.length;

  // Echo the command into the stream as a multi-line block. Lines are
  // prefixed with `php>` (first) and `...` (continuation) so a 20-line
  // paste still reads naturally and you can tell where one execution
  // begins and the next ends.
  const codeLines = code.split('\n');
  codeLines.forEach((line, i) => {
    streamAppend('console-output', 'cmd', (i === 0 ? 'php> ' : '...  ') + line);
  });

  _phpInFlight = true;
  const fd = new FormData();
  fd.append('action', 'eval');
  fd.append('code', code);
  fd.append('timeout', '30');

  fetchJSON(fd)
    .then(data => {
      if (data.error) streamAppend('console-output', 'err', '[err] ' + data.error);
      const out = (data.output || '').replace(/\n+$/, '');
      if (out) streamAppend('console-output', 'out', out);
      else if (!data.error) streamAppend('console-output', 'out', '(no output)');
      streamSep('console-output');
      dbPut('history', { cmd: code, out: data.output || '', error: data.error || null, ts: new Date().toISOString() });
    })
    .catch(err => {
      streamAppend('console-output', 'err', '[err] Request error: ' + String(err));
      streamSep('console-output');
    })
    .finally(() => { _phpInFlight = false; });
  // Clear input so next command types onto a blank slate; ↑ history retrieves.
  ta.value = '';
}
