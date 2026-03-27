// ==================== PIVOT MAP ====================
const SVC_MAP = {
  21:'ftp', 22:'ssh', 23:'telnet',
  25:'smtp', 465:'smtp', 587:'smtp',
  80:'http', 8080:'http', 8000:'http',
  443:'https', 8443:'https',
  139:'smb', 445:'smb',
  1433:'db', 3306:'db', 5432:'db',
  6379:'redis', 27017:'db', 9200:'db',
  3389:'rdp', 5900:'vnc',
  2375:'docker', 6443:'docker',
};

function svcClass(port) {
  return 'svc-' + (SVC_MAP[parseInt(port)] || 'other');
}

function svcLabel(port) {
  const names = {
    21:'FTP', 22:'SSH', 23:'Telnet', 25:'SMTP', 80:'HTTP',
    443:'HTTPS', 445:'SMB', 139:'SMB', 1433:'MSSQL', 3306:'MySQL',
    5432:'PgSQL', 6379:'Redis', 27017:'Mongo', 9200:'ES',
    3389:'RDP', 5900:'VNC', 2375:'Docker', 6443:'K8s',
    8080:'HTTP', 8443:'HTTPS', 465:'SMTPS', 587:'SMTP', 8000:'HTTP',
  };
  const n = names[parseInt(port)];
  return n ? port + ' ' + n : String(port);
}

function renderPivotMap() {
  const summary = document.getElementById('pivot-summary');
  const body    = document.getElementById('pivot-body');
  body.innerHTML = '<span class="spinner"></span>';
  dbGetAll('scans').then(scans => { _renderPivotMap(summary, body, scans); });
}

function _renderPivotMap(summary, body, scans) {
  const hostMap = {};
  scans.forEach(s => {
    (s.open || []).forEach(entry => {
      const idx = entry.lastIndexOf(':');
      if (idx < 1) return; // skip malformed entries (no colon, or colon at start)
      const ip   = entry.substring(0, idx);
      const port = entry.substring(idx + 1);
      if (!ip || !port || isNaN(parseInt(port))) return;
      if (!hostMap[ip]) hostMap[ip] = new Set();
      hostMap[ip].add(port);
    });
  });

  const hosts = Object.keys(hostMap).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });

  if (hosts.length === 0) {
    body.innerHTML = '<div style="color:var(--muted)">No scan data yet. Run scans in the Scanner tab first.</div>';
    summary.innerHTML = '';
    return;
  }

  const totalPorts = hosts.reduce((sum, ip) => sum + hostMap[ip].size, 0);
  const svcCounts  = {};
  hosts.forEach(ip => {
    hostMap[ip].forEach(p => {
      const s = SVC_MAP[parseInt(p)] || 'other';
      svcCounts[s] = (svcCounts[s] || 0) + 1;
    });
  });

  summary.innerHTML = '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px">' +
    '<span>&#x1F5A5; <b>' + hosts.length + '</b> hosts</span>' +
    '<span>&#x1F6AA; <b>' + totalPorts + '</b> open ports</span>' +
    Object.entries(svcCounts).map(([s, c]) =>
      '<span class="badge port-badge svc-' + s + '">' + s.toUpperCase() + ': ' + c + '</span>'
    ).join('') + '</div>';

  const grid = document.createElement('div');
  grid.className = 'pivot-grid';
  hosts.forEach(ip => {
    const ports = [...hostMap[ip]].sort((a, b) => parseInt(a) - parseInt(b));
    const card = document.createElement('div');
    card.className = 'host-card';
    card.dataset.ip = ip;
    card.innerHTML =
      '<div class="host-ip">&#x25CF; ' + escHtml(ip) + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">' +
        ports.map(p => '<span class="port-badge ' + svcClass(p) + '">' + svcLabel(p) + '</span>').join('') +
      '</div>' +
      '<button class="btn btn-sm btn-secondary scan-more-btn" data-ip="' + escHtml(ip) + '">Scan More</button>';
    card.addEventListener('click', e => {
      if (e.target.closest('.scan-more-btn')) return; // handled below
      document.querySelectorAll('.host-card.selected').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    card.querySelector('.scan-more-btn').addEventListener('click', e => {
      e.stopPropagation();
      pivotScan(ip);
    });
    grid.appendChild(card);
  });
  body.innerHTML = '';
  body.appendChild(grid);
}

function pivotScan(ip) {
  document.querySelectorAll('.sidebar-nav a').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
  document.querySelector('[data-tab="scanner"]').classList.add('active');
  document.getElementById('tab-scanner').classList.add('active');
  document.getElementById('scan-cidr').value = ip + '/32';
  document.getElementById('scan-port').value = '22,80,443,445,3306,3389,5432,6379,8080,8443,27017';
}

// Init file browser with current dir
browseDir(document.getElementById('files-path-input').value);
