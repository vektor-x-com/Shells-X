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

// In-memory fingerprint cache: { "ip:port": {service, version, info[], tls, banner} }
const fpCache = {};

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

function fingerprintPort(ip, port) {
  const key = ip + ':' + port;
  if (fpCache[key]) return Promise.resolve(fpCache[key]);
  const fd = new FormData();
  fd.append('action', 'fingerprint');
  fd.append('host', ip);
  fd.append('port', port);
  return fetchJSON(fd).then(data => {
    fpCache[key] = data;
    return data;
  });
}

function fingerprintHost(ip, ports, card) {
  const btn = card.querySelector('.fp-btn');
  const detail = card.querySelector('.fp-detail');
  if (btn) btn.disabled = true;
  if (btn) btn.textContent = 'Probing...';
  detail.innerHTML = '<span class="spinner"></span> Fingerprinting ' + ports.length + ' port(s)...';

  let done = 0;
  const results = [];

  function next(idx) {
    if (idx >= ports.length) {
      renderFpDetail(ip, results, detail);
      if (btn) { btn.textContent = '\u21BB Re-probe'; btn.disabled = false; }
      return;
    }
    const p = ports[idx];
    fingerprintPort(ip, p).then(data => {
      results.push(data);
      done++;
      detail.innerHTML = '<span class="spinner"></span> Probing ' + (done) + '/' + ports.length + '...';
      next(idx + 1);
    }).catch(() => {
      results.push({ port: parseInt(p), service: '?', version: '', info: [], banner: '' });
      done++;
      next(idx + 1);
    });
  }
  next(0);
}

function renderFpDetail(ip, results, el) {
  let html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
  html += '<thead><tr style="border-bottom:1px solid var(--border)">' +
    '<th style="text-align:left;padding:4px 8px;color:var(--muted)">Port</th>' +
    '<th style="text-align:left;padding:4px 8px;color:var(--muted)">Service</th>' +
    '<th style="text-align:left;padding:4px 8px;color:var(--muted)">Version / Banner</th>' +
    '</tr></thead><tbody>';

  results.forEach(r => {
    const p = r.port;
    const svc = r.service || svcLabel(p).split(' ')[1] || '?';
    const ver = r.version || '';
    const cls = svcClass(p);

    html += '<tr style="border-bottom:1px solid var(--border)">';
    html += '<td style="padding:4px 8px"><span class="port-badge ' + cls + '">' + p + '</span></td>';
    html += '<td style="padding:4px 8px;color:var(--text);font-weight:600">' + escHtml(svc) + '</td>';
    html += '<td style="padding:4px 8px;font-family:monospace;color:var(--muted)">' + escHtml(ver) + '</td>';
    html += '</tr>';

    // Info tags
    if (r.info && r.info.length > 0) {
      html += '<tr><td></td><td colspan="2" style="padding:2px 8px 6px">';
      r.info.forEach(tag => {
        let tagClass = 'badge-ok';
        if (tag.startsWith('OS:')) tagClass = 'badge-no';
        else if (tag.startsWith('Framework:') || tag.startsWith('Powered:')) tagClass = 'badge-ok';
        html += '<span class="badge ' + tagClass + '" style="margin-right:4px;margin-bottom:2px">' + escHtml(tag) + '</span>';
      });
      html += '</td></tr>';
    }

    // TLS info
    if (r.tls) {
      html += '<tr><td></td><td colspan="2" style="padding:2px 8px 6px">';
      html += '<span class="badge svc-https" style="margin-right:4px">CN: ' + escHtml(r.tls.subject_cn) + '</span>';
      if (r.tls.issuer_org) html += '<span class="badge svc-http" style="margin-right:4px">CA: ' + escHtml(r.tls.issuer_org || r.tls.issuer_cn) + '</span>';
      if (r.tls.self_signed) html += '<span class="badge badge-no" style="margin-right:4px">Self-signed</span>';
      if (r.tls.sans && r.tls.sans.length > 1) {
        html += '<span class="badge svc-other" style="margin-right:4px">SANs: ' + r.tls.sans.length + '</span>';
      }
      html += '<span class="badge svc-other">' + escHtml(r.tls.valid_from) + ' \u2192 ' + escHtml(r.tls.valid_to) + '</span>';
      html += '</td></tr>';

      // Expandable SANs
      if (r.tls.sans && r.tls.sans.length > 0) {
        html += '<tr><td></td><td colspan="2" style="padding:0 8px 6px;font-size:11px;color:var(--muted);font-family:monospace">';
        html += r.tls.sans.map(escHtml).join(', ');
        html += '</td></tr>';
      }
    }

    // Raw banner (collapsed)
    if (r.banner && r.banner.length > 0) {
      const bid = 'ban-' + ip.replace(/\./g, '-') + '-' + p;
      html += '<tr><td></td><td colspan="2" style="padding:2px 8px 6px">';
      html += '<a href="#" style="font-size:11px" onclick="event.preventDefault();var e=document.getElementById(\'' + bid + '\');e.style.display=e.style.display===\'none\'?\'block\':\'none\'">Toggle raw banner</a>';
      html += '<pre id="' + bid + '" style="display:none;margin-top:4px;padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-all;max-height:150px;overflow-y:auto">' + escHtml(r.banner.substring(0, 512)) + '</pre>';
      html += '</td></tr>';
    }
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function fingerprintAllHosts() {
  document.querySelectorAll('.host-card').forEach(card => {
    const btn = card.querySelector('.fp-btn');
    if (btn) btn.click();
  });
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
      if (idx < 1) return;
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

  summary.innerHTML = '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;align-items:center">' +
    '<span>&#x1F5A5; <b>' + hosts.length + '</b> hosts</span>' +
    '<span>&#x1F6AA; <b>' + totalPorts + '</b> open ports</span>' +
    Object.entries(svcCounts).map(([s, c]) =>
      '<span class="badge port-badge svc-' + s + '">' + s.toUpperCase() + ': ' + c + '</span>'
    ).join('') +
    '<button class="btn btn-sm btn-primary" onclick="fingerprintAllHosts()" style="margin-left:auto">&#x1F50D; Fingerprint All</button>' +
    '</div>';

  const grid = document.createElement('div');
  grid.className = 'pivot-grid';
  hosts.forEach(ip => {
    const ports = [...hostMap[ip]].sort((a, b) => parseInt(a) - parseInt(b));
    const card = document.createElement('div');
    card.className = 'host-card';
    card.dataset.ip = ip;
    card.style.minWidth = '320px';
    card.style.flex = '1';
    card.innerHTML =
      '<div class="host-ip">&#x25CF; ' + escHtml(ip) + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">' +
        ports.map(p => '<span class="port-badge ' + svcClass(p) + '">' + svcLabel(p) + '</span>').join('') +
      '</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<button class="btn btn-sm btn-primary fp-btn" data-ip="' + escHtml(ip) + '">&#x1F50D; Fingerprint</button>' +
        '<button class="btn btn-sm btn-secondary scan-more-btn" data-ip="' + escHtml(ip) + '">Scan More</button>' +
      '</div>' +
      '<div class="fp-detail" style="font-size:12px"></div>';

    card.querySelector('.fp-btn').addEventListener('click', e => {
      e.stopPropagation();
      // Clear cache for re-probe
      ports.forEach(p => delete fpCache[ip + ':' + p]);
      fingerprintHost(ip, ports, card);
    });
    card.addEventListener('click', e => {
      if (e.target.closest('.fp-btn') || e.target.closest('.scan-more-btn')) return;
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
