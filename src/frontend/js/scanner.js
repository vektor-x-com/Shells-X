// ==================== SCANNER ====================
// Parse port string into sorted array of numbers
function parsePorts(portStr) {
  const ports = [];
  portStr.split(',').forEach(part => {
    part = part.trim();
    if (part.includes('-')) {
      const halves = part.split('-');
      const lo = Math.max(1, parseInt(halves[0]) || 0);
      const hi = Math.min(65535, parseInt(halves[1]) || 0);
      for (let p = lo; p <= hi; p++) ports.push(p);
    } else if (part !== '') {
      const p = parseInt(part);
      if (p >= 1 && p <= 65535) ports.push(p);
    }
  });
  return [...new Set(ports)].sort((x, y) => x - y);
}

function startScan() {
  const cidr = document.getElementById('scan-cidr').value.trim();
  const port = document.getElementById('scan-port').value.trim();
  const statusEl     = document.getElementById('scan-status');
  const resultsEl    = document.getElementById('scan-results');
  const progressWrap = document.getElementById('scan-progress-wrap');
  const progressBar  = document.getElementById('scan-progress');

  const allPorts = parsePorts(port);
  if (allPorts.length === 0) { statusEl.textContent = 'No valid ports specified.'; return; }

  let allOpen   = [];
  let portsDone = 0;
  const total   = allPorts.length;
  const scanTs  = new Date().toISOString();

  resultsEl.innerHTML = '';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  function scanPort(idx) {
    if (idx >= total) {
      progressBar.style.width = '100%';
      statusEl.textContent = 'Scan complete. ' + total + ' port(s) checked. ' + allOpen.length + ' open result(s).';
      if (allOpen.length === 0)
        resultsEl.innerHTML = '<div style="color:var(--muted);font-size:13px">No open hosts found.</div>';
      dbPut('scans', { cidr, ports: port, open: allOpen, ts: scanTs });
      setTimeout(() => { progressWrap.style.display = 'none'; }, 1000);
      return;
    }

    const p = allPorts[idx];
    statusEl.innerHTML = '<span class="spinner"></span>Scanning ' + cidr +
      ' port ' + p + ' (' + (idx + 1) + '/' + total + ')' +
      (allOpen.length ? ' — ' + allOpen.length + ' open' : '') + '...';

    const fd = new FormData();
    fd.append('action', 'scan');
    fd.append('cidr',   cidr);
    fd.append('port',   p);

    fetchJSON(fd)
      .then(data => {
        if (data.error) {
          statusEl.textContent = 'Error: ' + data.error;
          progressWrap.style.display = 'none';
          return;
        }
        (data.open || []).forEach(entry => {
          if (allOpen.indexOf(entry) === -1) allOpen.push(entry);
          const idx2 = entry.lastIndexOf(':');
          const ip = entry.substring(0, idx2);
          const ep = entry.substring(idx2 + 1);
          const span = document.createElement('span');
          span.className = 'scan-host';
          span.textContent = '\u25CF ' + entry;
          span.onclick = () => connectTo(ip, ep);
          resultsEl.appendChild(span);
        });
        portsDone++;
        progressBar.style.width = Math.round((portsDone / total) * 100) + '%';
        scanPort(idx + 1);
      })
      .catch(err => {
        statusEl.textContent = 'Error: ' + err;
        progressWrap.style.display = 'none';
      });
  }

  scanPort(0);
}

function connectTo(ip, port) {
  // Switch to console and pre-fill with a scan snippet
  document.querySelectorAll('.sidebar-nav a').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
  document.querySelector('[data-tab="console"]').classList.add('active');
  document.getElementById('tab-console').classList.add('active');
  document.getElementById('console-input').value =
    '$sock = @fsockopen(\'' + ip + '\', ' + port + ', $e, $s, 2);\n' +
    'if($sock) { echo "Connected to ' + ip + ':' + port + '\\n"; fclose($sock); }\n' +
    'else echo "Failed: $s";';
}

function loadScanHistory() {
  const card = document.getElementById('saved-scans-card');
  const body = document.getElementById('saved-scans-body');
  card.style.display = 'block';
  body.innerHTML = '<span class="spinner"></span>';
  dbGetAll('scans').then(scans => {
    if (scans.length === 0) {
      body.innerHTML = '<div style="color:var(--muted);font-size:13px">No saved scans.</div>';
      return;
    }
    body.innerHTML = scans.map(s =>
      '<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<span style="font-size:12px;color:var(--muted)">' + escHtml(s.ts) + ' &mdash; ' + escHtml(s.cidr || '') + ' ports:' + escHtml(s.ports || '') + ' &mdash; ' + (s.open||[]).length + ' result(s)</span>' +
      '<button class="btn btn-sm btn-danger" data-ts="' + escHtml(s.ts) + '" onclick="deleteScan(this.dataset.ts)">Delete</button>' +
      '</div>' +
      (s.open||[]).map(entry => {
        const idx = entry.lastIndexOf(':');
        const ip = entry.substring(0, idx); const p = entry.substring(idx + 1);
        return '<span class="scan-host" onclick="connectTo(\'' + escHtml(ip) + '\', ' + parseInt(p) + ')">' + escHtml(entry) + '</span>';
      }).join('') +
      '</div>'
    ).join('');
  });
}

function deleteScan(ts) {
  dbDelete('scans', ts).then(() => loadScanHistory());
}

function clearScanHistory() {
  if (confirm('Clear all scan history?')) {
    dbClear('scans').then(() => loadScanHistory());
  }
}

function exportScanHistory() {
  dbGetAll('scans').then(scans => {
    if (scans.length === 0) { alert('No scan data to export.'); return; }
    const seen = new Set();
    const deduped = [];
    scans.forEach(s => {
      (s.open || []).forEach(entry => {
        if (!seen.has(entry)) { seen.add(entry); deduped.push(entry); }
      });
    });
    const text = deduped.sort().join('\n');
    const blob = new Blob([text], {type: 'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scan_export_' + Date.now() + '.txt';
    a.click();
  });
}
