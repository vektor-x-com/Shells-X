// ==================== CONSOLE ====================
function insertCode(code) {
  document.getElementById('console-input').value = code;
  document.getElementById('console-input').focus();
}

document.getElementById('console-input').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') runCode();
});

function runCode() {
  const code = document.getElementById('console-input').value.trim();
  if (!code) return;

  const outCard = document.getElementById('output-card');
  const outEl = document.getElementById('console-output');
  outCard.style.display = 'block';
  outEl.innerHTML = '<span class="spinner"></span>Running...';

  const fd = new FormData();
  fd.append('action', 'eval');
  fd.append('code', code);

  fetchJSON(fd)
    .then(data => {
      const out = data.output || '(no output)';
      outEl.textContent = out;
      dbPut('history', { cmd: code, out, ts: new Date().toISOString() });
    })
    .catch(err => { outEl.textContent = 'Request error: ' + err; });
}

function copyOutput() {
  const text = document.getElementById('console-output').textContent;
  navigator.clipboard.writeText(text).then(() => alert('Copied!'));
}

function downloadOutput() {
  const text = document.getElementById('console-output').textContent;
  const blob = new Blob([text], {type: 'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'output_' + Date.now() + '.txt';
  a.click();
}
