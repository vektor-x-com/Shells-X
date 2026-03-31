// ==================== OS SHELL ====================
let shellAvailable = false;
let shellMethod = '';
let shellCwd = '';
let shellHistory = [];
let shellHistIdx = -1;

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

function runShellCmd() {
  const input = document.getElementById('os-shell-input');
  const output = document.getElementById('os-shell-output');
  const cmd = input.value.trim();
  if (!cmd || !shellAvailable) return;

  // Track history
  shellHistory.push(cmd);
  shellHistIdx = shellHistory.length;

  // Append command to output
  const promptText = shellCwd + ' $ ' + cmd;
  output.textContent += (output.textContent ? '\n' : '') + promptText + '\n';
  output.scrollTop = output.scrollHeight;
  input.value = '';

  const fd = new FormData();
  fd.append('action', 'shell');
  fd.append('cmd', cmd);
  fd.append('cwd', shellCwd);
  fd.append('timeout', '30');

  fetchJSON(fd)
    .then(data => {
      if (data.error) {
        output.textContent += 'Error: ' + data.error + '\n';
      } else {
        if (data.output) output.textContent += data.output + '\n';
        if (data.truncated) output.textContent += '[output truncated — exceeded 5MB limit]\n';
        shellCwd = data.cwd || shellCwd;
        document.getElementById('os-shell-prompt').textContent = shellCwd + ' $';
      }
      output.scrollTop = output.scrollHeight;
      // Save to history DB
      dbPut('history', { cmd: '$ ' + cmd, out: data.output || data.error || '', ts: new Date().toISOString() });
    })
    .catch(err => {
      output.textContent += 'Request error: ' + err + '\n';
      output.scrollTop = output.scrollHeight;
    });
}

// Shell input key handling
document.getElementById('os-shell-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runShellCmd();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (shellHistIdx > 0) {
      shellHistIdx--;
      e.target.value = shellHistory[shellHistIdx];
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (shellHistIdx < shellHistory.length - 1) {
      shellHistIdx++;
      e.target.value = shellHistory[shellHistIdx];
    } else {
      shellHistIdx = shellHistory.length;
      e.target.value = '';
    }
  } else if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    document.getElementById('os-shell-output').textContent = '';
  }
});

// Probe on load
probeShell();
