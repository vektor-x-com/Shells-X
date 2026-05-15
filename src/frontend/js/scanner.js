// ==================== PORT SCANNER ====================
const SCAN_POLL_MS = 1500;
const _scanPollers = {}; // scanId -> { running, timer }
let _scanRendering = false;

// Port presets — each one is a careful merge of Nmap's frequency-ranked set
// (2008 public-internet survey, https://github.com/nmap/nmap/blob/master/nmap-services)
// with the modern cloud/container/DevOps stack (docker, k8s, etcd, redis,
// mongo, ES, brokers, observability, WinRM, WireGuard, etc).
const SCAN_PORT_PRESETS = {
  tcp_small:  { proto: 'tcp', ports: '21,22,23,25,53,80,110,111,135,139,143,443,445,993,995,1723,2222,3000,3306,3389,5432,5900,5985,5986,6379,6443,8080,8443,9200,27017' },
  tcp_common: { proto: 'tcp', ports: '7,9,13,21,22,23,25,26,37,53,79,80,81,88,106,110,111,113,119,135,139,143,144,179,199,389,427,443,444,445,465,513,514,515,543,544,548,554,587,631,646,873,990,993,995,1025,1026,1027,1028,1029,1110,1433,1720,1723,1755,1883,1900,1935,2000,2001,2049,2121,2222,2375,2376,2379,2380,2717,3000,3128,3306,3389,3986,4222,4443,4899,5000,5001,5009,5044,5051,5060,5101,5190,5357,5432,5601,5631,5666,5672,5800,5900,5985,5986,6000,6001,6379,6443,6646,7070,7474,7687,8000,8001,8008,8009,8080,8081,8086,8443,8554,8883,8888,9000,9090,9092,9100,9200,9300,9443,9870,9999,10000,10250,10255,11211,15672,27017,27018,32768,49152,49153,49154,49155,49156,49157' },
  tcp_all:    { proto: 'tcp', ports: '1-65535' },
  udp_small:  { proto: 'udp', ports: '53,67,68,123,135,137,138,139,161,445,500,520,631,1434,1900,4500,5353,51820' },
  udp_common: { proto: 'udp', ports: '7,53,67,68,69,80,111,123,135,136,137,138,139,161,162,445,500,514,518,520,593,626,631,996,997,998,999,1025,1026,1027,1433,1434,1645,1646,1701,1812,1900,2048,2049,2222,3283,3456,4500,5060,5353,20031,32768,49152,49153,49154,51820' },
  udp_all:    { proto: 'udp', ports: '1-1024' },
};

function scanFillPorts(preset) {
  const p = SCAN_PORT_PRESETS[preset];
  if (!p) return;
  document.getElementById('scan-ports').value = p.ports;
  document.getElementById('scan-proto').value = p.proto;
}

function scanStart() {
  const targets = document.getElementById('scan-targets').value.trim();
  const ports   = document.getElementById('scan-ports').value.trim();
  if (!targets || !ports) { alert('Targets and ports are required.'); return; }
  const proto = document.getElementById('scan-proto').value;
  const concurrency = parseInt(document.getElementById('scan-concurrency').value, 10) || 64;
  const timeout_ms  = parseInt(document.getElementById('scan-timeout').value, 10) || 800;
  const batch_ms    = parseInt(document.getElementById('scan-batch').value, 10) || 1500;
  const fingerprint = document.getElementById('scan-fingerprint').checked ? '1' : '';

  const btn = document.getElementById('scan-start-btn');
  btn.disabled = true; btn.textContent = 'Starting...';

  const fd = new FormData();
  fd.append('action', 'scan_start');
  fd.append('targets', targets);
  fd.append('ports', ports);
  fd.append('proto', proto);
  fd.append('concurrency', concurrency);
  fd.append('timeout_ms', timeout_ms);
  fd.append('batch_ms', batch_ms);
  if (fingerprint) fd.append('fingerprint', '1');

  fetchJSON(fd).then(d => {
    btn.disabled = false; btn.textContent = '▶ Start Scan';
    if (d.error) { alert('Start failed: ' + d.error); return; }
    const scan = {
      id: d.id,
      status: 'running',
      started_at: Math.floor(Date.now() / 1000),
      finished_at: null,
      total: d.total,
      cursor: 0,
      summary: { open: 0, closed: 0, filtered: 0 },
      next_offset: 0,
      opts: { targets_str: targets, ports_str: ports, proto, concurrency, timeout_ms, batch_ms, fingerprint: !!fingerprint },
      host_count: d.host_count,
      port_count: d.port_count,
    };
    dbPut('scans', scan).then(() => {
      renderScans();
      scanStartPoller(scan.id);
    });
  }).catch(err => {
    btn.disabled = false; btn.textContent = '▶ Start Scan';
    alert('Network error: ' + err);
  });
}

function scanControl(id, action) {
  const fd = new FormData();
  fd.append('action', 'scan_' + action);
  fd.append('id', id);
  return fetchJSON(fd).then(d => {
    if (d.error) { alert(action + ' failed: ' + d.error); return; }
    return dbOpen().then(db => new Promise(res => {
      const tx = db.transaction('scans', 'readwrite');
      const os = tx.objectStore('scans');
      const g = os.get(id);
      g.onsuccess = () => {
        const s = g.result;
        if (s) {
          s.status = d.status || s.status;
          if (s.status === 'stopped' || s.status === 'done') s.finished_at = Math.floor(Date.now() / 1000);
          os.put(s);
        }
        res();
      };
    })).then(() => {
      if (action === 'pause' || action === 'stop') scanStopPoller(id);
      if (action === 'resume') scanStartPoller(id);
      updateScanCard(id);
    });
  });
}

function scanDestroy(id) {
  if (!confirm('Delete this scan and all its results?')) return;
  scanStopPoller(id);
  const fd = new FormData();
  fd.append('action', 'scan_destroy');
  fd.append('id', id);
  fetchJSON(fd).finally(() => {
    Promise.all([
      dbDelete('scans', id),
      dbDeleteByIndex('scan_results', 'by_scan', id),
    ]).then(renderScans);
  });
}

function scanStartPoller(id) {
  if (_scanPollers[id]) return;
  const p = { running: true, timer: null };
  _scanPollers[id] = p;
  const tick = () => {
    if (!p.running) return;
    scanPollOnce(id).catch(() => {}).then(() => {
      // Self-reschedule only after the previous poll's IDB writes have committed.
      // Using setInterval here would let polls overlap on slow batches and
      // re-fetch the same byte range with stale next_offset, duplicating events.
      if (p.running) p.timer = setTimeout(tick, SCAN_POLL_MS);
    });
  };
  tick();
}

function scanStopPoller(id) {
  const p = _scanPollers[id];
  if (!p) return;
  p.running = false;
  if (p.timer) clearTimeout(p.timer);
  delete _scanPollers[id];
}

function scanPollOnce(id) {
  return dbOpen().then(db => new Promise(res => {
    const g = db.transaction('scans', 'readonly').objectStore('scans').get(id);
    g.onsuccess = () => res(g.result);
  })).then(scan => {
    if (!scan) { scanStopPoller(id); return; }
    const fd = new FormData();
    fd.append('action', 'scan_poll');
    fd.append('id', id);
    fd.append('since', scan.next_offset || 0);
    return fetchJSON(fd).then(d => {
      if (d.error) {
        // Scan vanished server-side (e.g. /tmp GC) — stop polling
        scanStopPoller(id);
        return;
      }
      const events = d.events || [];
      const rows = events.map(ev => Object.assign({ scan_id: id }, ev));
      const putResults = rows.length ? dbPutMany('scan_results', rows) : Promise.resolve();
      return putResults.then(() => dbOpen()).then(db => new Promise(res2 => {
        const tx = db.transaction('scans', 'readwrite');
        const os = tx.objectStore('scans');
        const g2 = os.get(id);
        g2.onsuccess = () => {
          const s = g2.result;
          if (s) {
            s.status      = d.state.status;
            s.cursor      = d.state.cursor;
            s.total       = d.state.total;
            s.summary     = d.state.summary;
            s.finished_at = d.state.finished_at;
            s.next_offset = d.next_offset;
            os.put(s);
          }
          tx.oncomplete = () => res2(s);
        };
      })).then(s => {
        if (s && (s.status === 'done' || s.status === 'stopped')) scanStopPoller(id);
        updateScanCard(id);
      });
    }).catch(() => { /* transient network error — keep polling */ });
  });
}

function scanReattach() {
  // On load: find scans in IDB with status=running, restart their pollers.
  // Also sync with server to catch scans started in another tab / from import.
  dbGetAll('scans')
    .then(scans => { scans.forEach(s => { if (s.status === 'running') scanStartPoller(s.id); }); })
    .catch(err => console.warn('scan reattach (local) failed:', err))
    .then(renderScans);
  const fd = new FormData();
  fd.append('action', 'scan_list');
  fetchJSON(fd).then(d => {
    if (!d || !d.scans) return;
    return dbGetAll('scans').then(local => {
      const known = new Set(local.map(s => s.id));
      const toAdd = d.scans.filter(s => !known.has(s.id)).map(s => Object.assign({}, s, { next_offset: 0 }));
      if (toAdd.length) {
        return dbPutMany('scans', toAdd).then(() => {
          toAdd.forEach(s => { if (s.status === 'running') scanStartPoller(s.id); });
          renderScans();
        });
      }
    });
  }).catch(err => console.warn('scan reattach (server) failed:', err));
}

function renderScans() {
  if (_scanRendering) return;
  _scanRendering = true;
  const body = document.getElementById('scans-body');
  if (!body) { _scanRendering = false; return; }
  dbGetAll('scans').then(scans => {
    scans.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    if (scans.length === 0) {
      body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px">No scans yet.</div>';
      return;
    }
    body.innerHTML = scans.map(s => renderScanCard(s)).join('');
  }).catch(err => {
    body.innerHTML = '<div style="color:var(--red);font-size:13px;padding:12px">Error loading scans: ' + escHtml(String(err && err.message || err)) + '</div>';
  }).then(() => { _scanRendering = false; });
}

function _scanStatusColor(status) {
  return ({
    running: 'var(--accent)', paused: 'var(--yellow)', stopped: 'var(--red)',
    done: 'var(--green)', idle: 'var(--muted)',
  })[status] || 'var(--muted)';
}

function renderScanHeader(s) {
  const opts = s.opts || {};
  let ctrls = '';
  if (s.status === 'running') {
    ctrls += '<button class="btn btn-sm btn-secondary" data-id="' + escHtml(s.id) + '" onclick="scanControl(this.dataset.id,\'pause\')">⏸ Pause</button>';
    ctrls += '<button class="btn btn-sm btn-danger" data-id="' + escHtml(s.id) + '" onclick="scanControl(this.dataset.id,\'stop\')">■ Stop</button>';
  } else if (s.status === 'paused') {
    ctrls += '<button class="btn btn-sm btn-primary" data-id="' + escHtml(s.id) + '" onclick="scanControl(this.dataset.id,\'resume\')">▶ Resume</button>';
    ctrls += '<button class="btn btn-sm btn-danger" data-id="' + escHtml(s.id) + '" onclick="scanControl(this.dataset.id,\'stop\')">■ Stop</button>';
  }
  ctrls += '<button class="btn btn-sm btn-secondary" data-id="' + escHtml(s.id) + '" onclick="scanExportResults(this.dataset.id)">⬇ Export</button>';
  ctrls += '<button class="btn btn-sm btn-danger" data-id="' + escHtml(s.id) + '" onclick="scanDestroy(this.dataset.id)">✖ Delete</button>';

  let h = '';
  h += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">';
  h += '<span style="color:' + _scanStatusColor(s.status) + ';font-weight:600;text-transform:uppercase;font-size:11px">' + escHtml(s.status) + '</span>';
  h += '<span style="font-family:monospace;font-size:12px;color:var(--muted)">' + escHtml(s.id) + '</span>';
  h += '<span style="font-size:12px;color:var(--text)">' + escHtml(opts.targets_str || '') + '</span>';
  h += '<span style="font-size:11px;color:var(--muted)">ports: ' + escHtml(opts.ports_str || '') + ' · ' + escHtml(opts.proto || 'tcp') + '</span>';
  h += '</div>';
  h += '<div class="btn-group">' + ctrls + '</div>';
  return h;
}

function renderScanMeta(s) {
  const sum = s.summary || {};
  const pct = s.total ? Math.floor((s.cursor / s.total) * 100) : 0;
  const elapsed = (s.finished_at || Math.floor(Date.now()/1000)) - (s.started_at || 0);
  let h = '';
  h += '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-bottom:10px">';
  h += '<span><span style="color:var(--muted)">progress:</span> ' + s.cursor + '/' + s.total + ' (' + pct + '%)</span>';
  h += '<span style="color:var(--green)">open: ' + (sum.open || 0) + '</span>';
  h += '<span style="color:var(--muted)">closed: ' + (sum.closed || 0) + '</span>';
  h += '<span style="color:var(--muted)">filtered: ' + (sum.filtered || 0) + '</span>';
  h += '<span style="color:var(--muted)">elapsed: ' + elapsed + 's</span>';
  h += '</div>';
  h += '<div style="height:6px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden;margin-bottom:10px">';
  h += '<div style="height:100%;width:' + pct + '%;background:' + _scanStatusColor(s.status) + ';transition:width .3s"></div>';
  h += '</div>';
  return h;
}

function renderScanCard(s) {
  let h = '';
  h += '<div class="card" id="scan-card-' + s.id + '" style="margin-bottom:12px">';
  h += '<div class="card-header" id="scan-header-' + s.id + '" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">';
  h +=   renderScanHeader(s);
  h += '</div>';
  h += '<div class="card-body">';
  h +=   '<div id="scan-meta-' + s.id + '">' + renderScanMeta(s) + '</div>';
  // results region — toggle persists across polls, content refreshed in place
  h += '<div style="font-size:12px">';
  h += '<a href="#" data-id="' + escHtml(s.id) + '" onclick="event.preventDefault();scanToggleResults(this.dataset.id)" style="color:var(--accent);text-decoration:none">Show open ports ▼</a>';
  h += '</div>';
  h += '<div id="scan-results-' + s.id + '" style="display:none;margin-top:10px" data-rendered-count="0"></div>';
  h += '</div></div>';
  return h;
}

// Surgical in-place update of one scan card. Called after every poll so the
// expanded results panel (if open) is NOT torn down — only header + meta
// re-render. If the panel is open and the result count grew, we silently
// re-render the panel content; otherwise we leave it alone (no flicker).
function updateScanCard(id) {
  return dbOpen().then(db => new Promise(res => {
    const g = db.transaction('scans', 'readonly').objectStore('scans').get(id);
    g.onsuccess = () => res(g.result);
  })).then(s => {
    if (!s) return;
    const card = document.getElementById('scan-card-' + id);
    if (!card) { renderScans(); return; }
    const header = document.getElementById('scan-header-' + id);
    const meta   = document.getElementById('scan-meta-' + id);
    if (header) header.innerHTML = renderScanHeader(s);
    if (meta)   meta.innerHTML   = renderScanMeta(s);
    const results = document.getElementById('scan-results-' + id);
    if (results && results.style.display !== 'none') {
      const seen = parseInt(results.getAttribute('data-rendered-count') || '0', 10);
      if ((s.summary && (s.summary.open || 0)) > seen) {
        scanLoadResults(id, results);
      }
    }
  });
}

function scanToggleResults(id) {
  const el = document.getElementById('scan-results-' + id);
  if (!el) return;
  if (el.style.display === 'none') {
    el.style.display = 'block';
    scanLoadResults(id, el);
  } else {
    el.style.display = 'none';
  }
}

function scanLoadResults(id, el) {
  if (!el.innerHTML) el.innerHTML = '<span class="spinner"></span> Loading...';
  dbGetByIndex('scan_results', 'by_scan', id).then(rows => {
    const interesting = rows.filter(r => r.state === 'open');
    interesting.sort((a, b) => {
      if (a.host !== b.host) return a.host.localeCompare(b.host, undefined, { numeric: true });
      return a.port - b.port;
    });
    el.setAttribute('data-rendered-count', String(interesting.length));
    if (interesting.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px">No open ports yet.</div>';
      return;
    }
    const byHost = {};
    interesting.forEach(r => { (byHost[r.host] = byHost[r.host] || []).push(r); });
    let html = '';
    Object.entries(byHost).forEach(([host, ports]) => {
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-family:monospace;font-size:12px;color:var(--accent);margin-bottom:4px">' + escHtml(host) + ' <span style="color:var(--muted)">(' + ports.length + ' open)</span></div>';
      html += '<table class="file-table"><thead><tr><th>Port</th><th>Proto</th><th>State</th><th>Service</th><th>Version</th><th>Latency</th></tr></thead><tbody>';
      ports.forEach(p => {
        const tlsBadge = p.tls ? ' <span class="badge badge-ok" title="TLS cert">TLS</span>' : '';
        html += '<tr>';
        html += '<td>' + p.port + '</td>';
        html += '<td>' + escHtml(p.proto) + '</td>';
        html += '<td><span class="badge badge-ok">' + escHtml(p.state) + '</span></td>';
        html += '<td>' + escHtml(p.service || '') + tlsBadge + '</td>';
        html += '<td style="font-family:monospace;font-size:11px">' + escHtml((p.version || '').substring(0, 80)) + '</td>';
        html += '<td>' + (p.latency_ms || 0) + 'ms</td>';
        html += '</tr>';
        if (p.banner) {
          html += '<tr><td colspan="6" style="padding:0">';
          html += '<details style="background:rgba(0,0,0,.25);padding:6px 10px"><summary style="cursor:pointer;font-size:11px;color:var(--muted)">banner (' + p.banner.length + ' bytes)</summary>';
          html += '<pre style="margin:6px 0 0 0;font-size:11px;color:var(--text);white-space:pre-wrap;word-break:break-all">' + escHtml(p.banner) + '</pre>';
          if (p.tls) {
            html += '<div style="font-size:11px;color:var(--yellow);margin-top:6px">TLS: CN=' + escHtml(p.tls.subject_cn) +
                    ' issuer=' + escHtml(p.tls.issuer_cn) + ' valid=' + escHtml(p.tls.valid_from) + '→' + escHtml(p.tls.valid_to) +
                    (p.tls.self_signed ? ' <span style="color:var(--red)">[self-signed]</span>' : '') +
                    (p.tls.sans && p.tls.sans.length ? ' SANs=' + escHtml(p.tls.sans.join(',')) : '') + '</div>';
          }
          html += '</details></td></tr>';
        }
      });
      html += '</tbody></table></div>';
    });
    el.innerHTML = html;
  });
}

function scanExportResults(id) {
  dbGetByIndex('scan_results', 'by_scan', id).then(rows => {
    dbOpen().then(db => {
      const g = db.transaction('scans', 'readonly').objectStore('scans').get(id);
      g.onsuccess = () => {
        const data = { scan: g.result, results: rows };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'scan_' + id + '_' + Date.now() + '.json';
        a.click();
      };
    });
  });
}

// Reattach pollers on load; refresh card view when user opens the Scanner tab
document.addEventListener('DOMContentLoaded', scanReattach);
if (document.readyState !== 'loading') scanReattach();
