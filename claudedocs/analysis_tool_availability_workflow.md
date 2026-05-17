# Analysis — tool availability + workflow bugs

**Date:** 2026-05-17
**Scope:** backend PHP function dependencies (what breaks when which function is disabled) and frontend workflow / state bugs accumulated through the recent refactors (console unification, icon swap, click-to-copy).

---

## A. Tool availability — backend PHP function dependencies

The shell targets locked-down hosts where any of `exec`, `proc_open`, `openssl_*`, `posix_*`, `stream_socket_client` may be disabled. Inventory of what each handler **hard-requires** vs **degrades gracefully**:

| Handler | Hard-required functions | If missing → |
|---|---|---|
| `crypto.php` | `openssl_decrypt`, `openssl_encrypt`, `hex2bin`, `random_bytes` | Guard on `function_exists('openssl_decrypt')` at entry (✓). If missing, falls through cleanly — encryption is silently bypassed. **Severity: low** (graceful). |
| `shell.php` | `system OR exec OR shell_exec OR passthru OR popen OR proc_open` | Iterates the list, picks the first available (✓). If all six are disabled, returns `{available: false}` and frontend shows the "OS shell unavailable" placeholder. **Severity: low** (graceful). |
| `scanner.php` | `stream_socket_client`, `stream_select`, `stream_set_blocking`, `random_bytes`, `flock` | Only one guard exists (`function_exists('stream_socket_client')` at line 340) — inside the TLS cert grab. The **main TCP/UDP batch paths and the bulk_create file write call these unguarded** at lines 152/160/177. If `stream_socket_client` is disabled, every scan_start succeeds but every scan_poll returns batch errors silently as "filtered". `flock` is essentially universal but worth noting. **Severity: medium** — degraded experience, no clear error to the operator. |
| `diagnostics.php` | `posix_*`, many optional functions | 8 `function_exists` guards (✓). When posix is missing, identity fields show `?` instead of crashing. Some sections (cron, NFS, kernel info) silently produce empty results. **Severity: low**. |
| `filebrowser.php` | `scandir`, `stat`, `posix_*` | `posix` guarded (✓). `scandir` could fail under `open_basedir` — currently `@scandir() ?: []` returns empty entries with no error message. **Severity: low** but operator sees an empty directory and may misdiagnose. |
| `fileops.php` | `unlink`, `rmdir`, `file_put_contents`, `move_uploaded_file` | No guards. These are core PHP functions present everywhere — `disable_functions` rarely touches them. **Severity: low**. |
| `eval.php` | `eval` (language construct, always present) | Cannot be disabled. **Severity: none**. |
| `destruct.php` | `unlink` | No guard. If unlink is disabled or file isn't writable, returns `{ok: false, error: ...}`. Frontend keeps the IDB intact. **Severity: low** (graceful failure path exists). |
| `download.php` | `readfile`/`fpassthru` | Standard. **Severity: none**. |

### Actionable gaps

1. **`scanner.php` lacks a startup probe for `stream_socket_client`.** Add a check in `scan_start` that returns `{error: 'stream_socket_client unavailable — scan disabled'}` if the function is missing. Right now scans appear to run but produce 100% filtered results, indistinguishable from a totally-firewalled target. ~3 lines.

2. **`filebrowser.php` silently swallows `open_basedir` violations.** A `@scandir(...)` that returns false under open_basedir yields an empty entries list. Add an `error` field when `scandir` returned false vs. genuinely empty directory. ~5 lines.

3. **No global "exec is gone" banner.** Operator should see at-a-glance which backend capabilities are available before clicking into a tab that will silently 404. The Diagnostics tab already reveals this, but at-a-glance status in the topbar would prevent a lot of "I clicked X and got nothing" confusion.

---

## B. Frontend workflow bugs

### B1. `console.js` line 73 — null-guard regression risk (HIGH)

```js
const container = document.getElementById('snippet-buttons');
container.append(...);
```

If `snippet-buttons` element is missing (e.g., layout edit, module exclusion you write later), this throws at script-load time and **cascades the same TDZ failure we already fixed in shell.js and filebrowser.js**: every script below `console.js` in the bundle (db.js's `_db` is above so it's fine, but scanner.js's `scanReattach`, tunnel.js's IIFE, faraday.js's `_faradayInit`, destruct.js's wipe handler) silently doesn't run. Half-broken UI, no console error visible to the operator.

Same pattern, lines 86 & 122: `document.getElementById('console-input').addEventListener(...)` — if `console-input` is missing, crash.

**Fix (5 lines):** wrap each in the same defensive pattern we used for shell.js:
```js
const container = document.getElementById('snippet-buttons');
if (container) container.append(...);

const input = document.getElementById('console-input');
if (input) input.addEventListener('keydown', ...);
```

### B2. Stream auto-scroll fights user scroll (MEDIUM UX)

`streamAppend` in console.js always calls `el.scrollTop = el.scrollHeight`. If the operator scrolled up to read a previous output, a new command jumps them back to the bottom — losing their reading position.

**Fix:** only auto-scroll if the user was already at the bottom:
```js
const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
el.appendChild(div);
if (atBottom) el.scrollTop = el.scrollHeight;
```

### B3. Concurrent `runCode()` invocations interleave output (MEDIUM)

Run a slow `phpinfo()`, then immediately a fast `echo "hi"`. Both POST in parallel. The fast one finishes first and writes `hi` to the stream. The slow one finishes later and dumps 120KB of HTML after. Stream order becomes:

```
php> phpinfo();
php> echo "hi";
hi
<huge HTML>
```

— misleading. Two paths:
- **Serialise** — disable the input while a request is in-flight (simple, slight UX downgrade).
- **Tag entries with a sequence id** — render output in a separate `<div>` linked to the originating command so they group correctly even out-of-order (clean, ~20 lines).

### B4. PHP/OS shell history is in-memory only (LOW)

`_phpHistory` and `shellHistory` arrays die on page reload. The IndexedDB `history` store has the commands but Ctrl+↑ doesn't see them. After a reload, history navigation appears broken until the user runs at least one command.

**Fix:** in console.js (and shell.js), populate the in-memory array from `dbGetAll('history')` on init, filtered by the command prefix (`php >` vs `$ `).

### B5. Stream copy/download produces unreadable runs (LOW)

`streamCopy` and `streamDownload` use `el.textContent` which concatenates all entries without separators. A copy of a 5-execution session looks like:

```
php> echo "hi"hiphp> echo "ok"okphp> ...
```

— commands and outputs mash together because the `.stream-sep` element has no text content. Either insert a newline character into the sep div, or have `streamCopy/Download` walk children and emit `\n` between entries.

### B6. Faraday: faraday-cli's "auto-detect: No" trap (KNOWN, partly documented)

The Faraday_JSON plugin doesn't auto-detect, so `faraday-cli tool report file.json` without `--plugin-id Faraday_JSON` silently no-ops (creates a Command row, no entities). We document this in the settings help text, but operators forget. Could embed the full hint in the export filename: `vektor-x-full-acme-1779036000.use-plugin-id-Faraday_JSON.json` — ugly but self-documenting.

### B7. Stale-build 404 in the diag fetch path (LOW, mentioned earlier)

`_faradayEnsureDiag` POSTs to `location.pathname`. If the operator has a stale tab open after `python3 generate.py` regenerated to a new filename, the diag fetch 404s and the export silently lacks enrichment. The `.catch(err => console.warn(...))` is silent in the UI. Surface the failure in the export toast: "exported, but diag enrichment failed — refresh page if filename changed".

### B8. Snippet buttons replace textarea content instead of appending (LOW UX)

`insertCode(code)` overwrites `console-input.value`. If the operator has half a snippet typed and clicks "phpinfo", their work is wiped. Trivial fix: append with a newline when textarea isn't empty.

---

## C. Recent-refactor regression risks

### C1. Icon SVGs broke nothing structural, but inline width/height in `generate.py`

The login-page `<h2>` SVG I added uses inline `width:14px;height:14px` instead of the `.icon` class (because the login page is rendered before the main stylesheet). If a future build changes accent color in the login form, the SVG's color stays whatever currentColor inherits from `h2` (currently the accent — fine). **Severity: none** — flagging only.

### C2. Removed Execute button means no fallback for clipboard-disabled browsers

Per-tab `runCode` is now only reachable via Enter key. If something intercepts the keydown event (e.g., a screen reader plugin, an extension), the operator has no other way to fire the command. **Severity: low** — could add a tiny `▶` icon in the prefix area as a fallback click target.

### C3. `.copyable` click handler fires for nested clicks

The delegated handler `e.target.closest('.copyable')` will activate if a child element is clicked. If we later put a copyable around a `<button>`, clicking the button copies the surrounding text. Mostly fine, but worth a unit-test of "copyable contains button" scenarios.

---

## D. Prioritized punch list

| # | Item | Effort | Severity | Section |
|---|---|---|---|---|
| 1 | Null-guard `console.js` top-level DOM accesses (lines 73, 86, 122) | 5 lines | **HIGH** | B1 |
| 2 | Don't auto-scroll if user scrolled up | 3 lines | medium | B2 |
| 3 | Add `function_exists('stream_socket_client')` guard at top of `scan_start` | 3 lines | medium | A.1 |
| 4 | Populate history arrays from IDB on init | 10 lines | low | B4 |
| 5 | Serialise OR tag stream entries with seq | 10–25 lines | medium | B3 |
| 6 | streamCopy / streamDownload emit `\n` between entries | 8 lines | low | B5 |
| 7 | Surface diag-fetch failure in export toast | 5 lines | low | B7 |
| 8 | filebrowser.php signal `scandir` returned false (vs empty) | 5 lines | low | A.2 |
| 9 | Snippet button appends instead of overwrites | 3 lines | low | B8 |

Items 1, 2, and 3 are the highest-leverage and should land before the next deploy. The rest are quality-of-life.
