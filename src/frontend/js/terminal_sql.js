// ==================== SQL SHELL ADAPTER ====================
// MySQL and PostgreSQL interactive shell using mysqli / PDO.
// Connection params (host, port, db, user, password) are collected from the
// settings panel and injected per-request via beforeRun — no server-side
// session needed.

var sqlAvailable    = {};   // { mysqli, pdo_mysql, pdo_pgsql } from probe
var sqlConnected    = false;
var sqlCurrentLabel = '';   // shown in the dynamic prompt

function probeSQL() {
  var fd = new FormData();
  fd.append('action', 'sql_probe');
  fetchJSON(fd)
    .then(function(data) {
      sqlAvailable = data;
      var hasMysql  = data.mysqli || data.pdo_mysql;
      var hasPgsql  = data.pdo_pgsql;
      var status    = document.getElementById('sql-status');
      if (!hasMysql && !hasPgsql) {
        if (status) status.innerHTML = '<span class="badge badge-no">&#x2716; No SQL driver (mysqli/pdo_mysql/pdo_pgsql)</span>';
        var inp = document.getElementById('sql-input');
        if (inp) { inp.disabled = true; inp.placeholder = 'No SQL extension available'; }
      } else {
        var parts = [];
        if (hasMysql)  parts.push('MySQL');
        if (hasPgsql)  parts.push('PostgreSQL');
        if (status) status.innerHTML = '<span class="badge badge-warn">&#x25CB; ' + escHtml(parts.join(', ')) + ' — not connected</span>';
        _bindSQLTerminal();
      }
    })
    .catch(function() {
      var status = document.getElementById('sql-status');
      if (status) status.innerHTML = '<span class="badge badge-no">&#x2716; Probe failed</span>';
    });
}

function sqlToggleSettings() {
  var panel = document.getElementById('sql-settings-panel');
  var btn   = document.querySelector('[aria-controls="sql-settings-panel"]');
  if (!panel) return;
  var hidden = panel.hasAttribute('hidden');
  if (hidden) { panel.removeAttribute('hidden'); } else { panel.setAttribute('hidden', ''); }
  if (btn) btn.setAttribute('aria-expanded', hidden ? 'true' : 'false');
}

// Update port default when driver type changes
function sqlDriverChange() {
  var driver = document.getElementById('sql-driver');
  var port   = document.getElementById('sql-port');
  if (!driver || !port) return;
  var defaults = { mysql: '3306', pgsql: '5432' };
  var current  = port.value.trim();
  // Only auto-fill if field is empty or holds a known default
  if (current === '' || current === '3306' || current === '5432') {
    port.value = defaults[driver.value] || '';
  }
}

function sqlConnect() {
  var host = (document.getElementById('sql-host')     || {}).value || '';
  var port = (document.getElementById('sql-port')     || {}).value || '';
  var db   = (document.getElementById('sql-db')       || {}).value || '';
  var user = (document.getElementById('sql-user')     || {}).value || '';
  var pass = (document.getElementById('sql-password') || {}).value || '';
  var drv  = (document.getElementById('sql-driver')   || {}).value || 'mysql';
  var statusEl = document.getElementById('sql-connect-status');
  var badgeEl  = document.getElementById('sql-status');

  if (!host) { if (statusEl) statusEl.textContent = 'Host required'; return; }

  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">Connecting\u2026</span>';

  var fd = new FormData();
  fd.append('action',   'sql_query');
  fd.append('query',    'SELECT 1');
  fd.append('host',     host.trim());
  fd.append('port',     port.trim());
  fd.append('db',       db.trim());
  fd.append('user',     user.trim());
  fd.append('password', pass);
  fd.append('driver',   drv);
  fd.append('timeout',  '10');

  fetchJSON(fd)
    .then(function(data) {
      if (data.error) {
        sqlConnected = false;
        if (statusEl) statusEl.innerHTML = '<span class="badge badge-no">&#x2716; ' + escHtml(data.error) + '</span>';
        if (badgeEl)  badgeEl.innerHTML  = '<span class="badge badge-no">&#x2716; Not connected</span>';
        return;
      }
      sqlConnected    = true;
      sqlCurrentLabel = drv + '@' + host.trim() + (db.trim() ? '/' + db.trim() : '');
      if (statusEl) statusEl.innerHTML = '<span class="badge badge-ok">&#x2714; Connected</span>';
      if (badgeEl)  badgeEl.innerHTML  = '<span class="badge badge-ok">&#x2714; ' + escHtml(sqlCurrentLabel) + '</span>';
      // Close settings panel after successful connect
      var panel = document.getElementById('sql-settings-panel');
      if (panel) { panel.setAttribute('hidden', ''); }
      var btn = document.querySelector('[aria-controls="sql-settings-panel"]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      // Focus input for immediate use
      var inp = document.getElementById('sql-input');
      if (inp) inp.focus();
    })
    .catch(function(err) {
      sqlConnected = false;
      if (statusEl) statusEl.innerHTML = '<span class="badge badge-no">&#x2716; ' + escHtml(String(err)) + '</span>';
    });
}

function sqlRenderTable(streamId, columns, rows, count, truncated) {
  var el = document.getElementById(streamId);
  if (!el) return;
  var wasAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;

  var wrap = document.createElement('div');
  wrap.className = 'stream-out sql-result-wrap';

  if (!columns || columns.length === 0) {
    wrap.textContent = '(empty result)';
    el.appendChild(wrap);
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
    return;
  }

  var table = document.createElement('table');
  table.className = 'file-table';

  var thead = document.createElement('thead');
  var hrow  = document.createElement('tr');
  columns.forEach(function(col) {
    var th = document.createElement('th');
    th.textContent = col;
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  var tbody = document.createElement('tbody');
  (rows || []).forEach(function(row) {
    var tr = document.createElement('tr');
    row.forEach(function(cell) {
      var td = document.createElement('td');
      td.title = cell;
      td.textContent = cell;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  var meta = document.createElement('div');
  meta.className = 'sql-result-meta';
  meta.textContent = count + ' row' + (count !== 1 ? 's' : '') + (truncated ? ' (truncated — 500 row limit)' : '');
  wrap.appendChild(meta);

  el.appendChild(wrap);
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function _bindSQLTerminal() {
  Terminal.bind({
    id:             'sql',
    displayName:    'SQL',
    prompt:         'sql>',
    contPrompt:     '    ',
    hintsLabel:     'snippets',
    snippets: [
      ['version',    'SELECT VERSION();'],
      ['tables',     'SHOW TABLES;'],
      ['databases',  'SHOW DATABASES;'],
      ['users',      'SELECT user, host FROM mysql.user;'],
      ['processlist','SHOW PROCESSLIST;'],
    ],
    outputEl:       'sql-output',
    inputEl:        'sql-input',
    snippetEl:      'sql-snippet-buttons',
    downloadPrefix: 'sql-query',
    historyMarker:  'sql> ',
    excludeMarkers: ['$ ', ''],
    runAction:      'sql_query',
    codeField:      'query',
    timeoutField:   'timeout',
    timeoutValue:   '30',
    gate:           function() { return sqlConnected; },
    echoPrefix:     function() { return sqlCurrentLabel + '>'; },
    beforeRun: function(fd) {
      fd.append('host',     (document.getElementById('sql-host')     || {value:''}).value.trim());
      fd.append('port',     (document.getElementById('sql-port')     || {value:''}).value.trim());
      fd.append('db',       (document.getElementById('sql-db')       || {value:''}).value.trim());
      fd.append('user',     (document.getElementById('sql-user')     || {value:''}).value.trim());
      fd.append('password', (document.getElementById('sql-password') || {value:''}).value);
      fd.append('driver',   (document.getElementById('sql-driver')   || {value:'mysql'}).value);
    },
    afterRun: function(data) {
      // The engine emits "(no output)" when data.output is empty — remove it
      // before we render the actual SQL result below.
      var streamEl = document.getElementById('sql-output');
      if (streamEl) {
        var last = streamEl.lastElementChild;
        if (last && last.textContent === '(no output)') last.parentNode.removeChild(last);
      }
      if (data.columns != null) {
        sqlRenderTable('sql-output', data.columns, data.rows, data.count, data.truncated);
      } else if (data.affected != null) {
        streamAppend('sql-output', 'out', 'Query OK, ' + data.affected + ' row(s) affected');
      }
    },
  });
}

try { probeSQL(); } catch (e) { console.warn('probeSQL failed:', e); }
