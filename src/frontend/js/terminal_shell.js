// ==================== OS SHELL ADAPTER ====================
// Wraps the engine for a host-OS-shell card. Today: bash via probed exec
// function. Future: PowerShell on Windows targets, /bin/sh on macOS, etc.
// — would extend probeShell + adapter config rather than duplicate this file.

let shellAvailable = false;
let shellMethod = '';
let shellCwd = '';

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
        card.classList.remove('is-hidden');
        status.innerHTML = '<span class="badge badge-ok">&#x2714; OS shell via <b>' + escHtml(shellMethod) + '()</b></span>';
        document.getElementById('os-shell-prompt').textContent = shellCwd + ' $';
        document.getElementById('os-shell-input').placeholder = 'shell command  ·  Enter runs  ·  Shift+Enter newline  ·  ↑/↓ history  ·  Ctrl+L clear';

        // Wire the engine only after the probe confirms the shell is usable.
        // Otherwise we'd bind keydown/history to an input the operator can't
        // type into, and ↑/↓ would silently swallow keys.
        Terminal.bind({
          id:             'shell',
          displayName:    'Shell',
          prompt:         '$',                  // overridden by echoPrefix per-call
          contPrompt:     ' ',
          hintsLabel:     null,                 // no shell snippets today
          snippets:       [],
          outputEl:       'os-shell-output',
          inputEl:        'os-shell-input',
          snippetEl:      'shell-snippet-buttons',
          downloadPrefix: 'os-shell',
          historyMarker:  '$ ',                 // legacy: shell entries prefixed in shared history store
          runAction:      'shell',
          codeField:      'cmd',
          timeoutField:   'timeout',
          timeoutValue:   '30',
          gate:           () => shellAvailable,
          echoPrefix:     () => shellCwd + ' $',
          beforeRun:      (fd) => fd.append('cwd', shellCwd),
          afterRun:       (data) => {
            if (data.cwd) {
              shellCwd = data.cwd;
              document.getElementById('os-shell-prompt').textContent = shellCwd + ' $';
            }
            if (data.truncated) {
              Terminal.streamAppend('os-shell-output', 'err', '[output truncated — exceeded 5MB limit]');
            }
          },
        });
      } else {
        card.classList.remove('is-hidden');
        if (window.Bypass) {
          // Exec is disabled but the FastCGI takeover module is present —
          // offer the exploit panel instead of a dead input.
          status.innerHTML = '<span class="badge badge-no">&#x2716; exec disabled</span> <span class="badge badge-ok">FastCGI takeover available</span>';
          Bypass.show();
        } else {
          status.innerHTML = '<span class="badge badge-no">&#x2716; No exec function available</span>';
        }
        document.getElementById('os-shell-input').disabled = true;
        document.getElementById('os-shell-input').placeholder = window.Bypass
          ? 'OS shell disabled — run a FastCGI takeover exploit below to enable it'
          : 'OS shell unavailable — all exec functions are disabled';
      }
    })
    .catch(() => {
      card.classList.remove('is-hidden');
      status.innerHTML = '<span class="badge badge-no">&#x2716; Probe failed</span>';
      // Without bind() we'd leave a live-looking input that silently swallows
      // every key — disable it and tell the operator how to recover.
      document.getElementById('os-shell-input').disabled = true;
      document.getElementById('os-shell-input').placeholder = 'OS shell probe failed — reload the page to retry';
    });
}

// Probe on load — wrap so a malformed probe response can't abort the bundle.
try { probeShell(); } catch (e) { console.warn('probeShell failed:', e); }
