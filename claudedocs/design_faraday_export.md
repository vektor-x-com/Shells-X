# Design: Webshell → Faraday CE export

**Date:** 2026-05-16
**Target:** A downloadable JSON file compatible with Faraday's `faraday_json` plugin (and with the `bulk_create` REST endpoint, by virtue of having the same schema).
**Transport:** **Export-only.** The operator downloads a file and uploads it via `faraday-cli tool report` or the Faraday web UI. No direct HTTP from the browser to Faraday, no PHP-backend involvement.
**Status:** Design only — no code in this document.

---

## 0. Goals & non-goals

**Goals**
- Push everything the webshell collects (scans, scan results, diagnostics blob, captured access) into a Faraday workspace as proper Hosts / Services / Vulnerabilities / Credentials / Notes.
- Idempotent re-import: re-uploading the same file doesn't duplicate entities (Faraday dedupes server-side).
- Zero network traffic from operator browser to anywhere except the shell host. No CORS surface. No tokens stored anywhere. No leaks even under hostile network monitoring at the operator's site.

**Non-goals**
- Direct HTTP push to Faraday. **Explicitly rejected** — keeps the code surface tiny and removes any chance of accidental cross-origin traffic.
- Auto-export on scan completion. Always manual.
- Pull-from-Faraday — this is one-directional export.
- Report generation — Faraday handles that.

**Why export-only and not direct push**
- Smallest code surface: no fetch, no error paths, no fallback logic.
- Zero CORS configuration burden on the operator's Faraday.
- Zero token storage in the browser → nothing to leak under XSS.
- Faraday's `faraday_json` plugin is the canonical input path for batched offline data; we're using the tool the way its plugin system expects.
- One-click is a marginal win; an extra `faraday-cli tool report file.json` is muscle memory after the first time.

---

## 1. Data mapping

| Webshell source | Faraday entity | Field mapping | Severity |
|---|---|---|---|
| `scan_results` row, `state==='open'` | **Service** on Host(host) | `port`, `protocol=proto`, `name=service`, `version=version`, `description=banner[:1024]`, `status="open"` | n/a |
| Implicit host from `scan_results.host` or `arp_hosts.ip` | **Host** | `ip`, `mac` (joined from ARP if known), `hostnames=[]` | n/a |
| `scan_result.tls.self_signed` | **Vulnerability** on Service | `name="Self-signed TLS certificate"`, `desc=<cert fields>` | info |
| `scan_result.tls.valid_to` < now+30d | **Vulnerability** on Service | `name="Expiring/expired TLS certificate"` | low |
| `diagnostics.arp_hosts[]` | **Host** | `ip`, `mac`, `hostnames=[]` (ARP has no names) | n/a |
| `diagnostics.open_ports[]` (target's listening ports) | **Service** on the *target host* | `protocol="tcp"`, `port=N`, `status="open"`, `description="seen in /proc/net/tcp{,6}"` | n/a |
| `diagnostics.uid===0` (shell as root) | **Vulnerability** on target | `name="Webshell executes as root"` | critical |
| Webshell installed at all | **Vulnerability** on target | `name="Webshell installed"`, `desc=<path, build_id, php_version>` | critical |
| `diagnostics.passwd_users[]` (uid 0 or shell !nologin) | **Vulnerability** on target | `name="Login user: <name> uid=<uid>"`, `desc=<passwd row>` | info |
| `diagnostics.group_memberships{}` for {sudo,wheel,docker,lxd,adm,shadow,disk} | **Vulnerability** per `(group, member)` on target | `name="<user> in privileged group: <group>"` | high (sudo/wheel/docker/lxd) ; medium (adm/shadow/disk) |
| `diagnostics.readable_files[]` matching `/etc/shadow`, `id_rsa`, `authorized_keys` | **Vulnerability** on target (one per file) | `name="Sensitive file readable: <path>"` | critical |
| `diagnostics.readable_files[]` matching `.bash_history`, `.env` | **Vulnerability** on target | `name="Operator-relevant file readable: <path>"` | high |
| `diagnostics.env_files{path: content}` | **Vulnerability** on target (one per file) + **Credentials** parsed from content | vuln `name="Application secrets exposed: <path>"`, `desc=<content, with passwords redacted in default mode>` ; for each `DB_PASSWORD=` / `API_KEY=` / etc., one Credential | critical |
| `diagnostics.writable_dirs[]` for system paths (`/var/www`, `/etc`, `/usr/local`) | **Vulnerability** on target | `name="System path writable: <path>"` | medium |
| `diagnostics.bin_dirs[].writable===true` | **Vulnerability** on target | `name="Binary directory writable: <path>"` | high |
| `diagnostics.panels[]` | **Note** on target | `name="Detected hosting/control panels"`, `text=<list>` | n/a |
| `diagnostics.container.detected===true` | **Note** on target | `name="Container detected: <type>"`, `text=<hints>` | n/a |
| `diagnostics.routes[]` | **Note** on target | `name="Routing table"`, `text=<table>` (helps map adjacent networks) | n/a |
| `diagnostics.disable_functions === 'none'` or permissive | **Note** on target | `name="PHP disable_functions: none/permissive"` | n/a |
| `history` rows (operator commands) | per-export **Command** entity | one Command per export summarising what was collected; full per-command log is too noisy | n/a |
| Every export | **Command** entity | `tool="vektor-x-webshell"`, `command="export"`, `params=<scan_id|"diagnostics">`, `import_source="report"`, `start_date`, `end_date` | n/a |

### Decisions worth calling out

- **The target itself becomes a first-class Host.** It needs an IP — captured from `$_SERVER['SERVER_ADDR']` in `diagnostics.php` (added as `target_ip`/`target_host`). If unavailable, operator types it once.
- **Webshell presence is itself a critical Vulnerability**, not just a Note. This is the "we own this box" record that pentest engagements care about.
- **Banner goes to `Service.description`, not `Service.banner`.** Faraday's `banner` field is short; `description` is rich and renders nicely.
- **No auto-vuln on banner-revealed software versions.** That's nuclei's job. Pushing "nginx/1.18.0 has CVE-XXXX" speculatively creates noise.
- **`.env` parsing extracts proper Faraday Credentials**, not just a text dump. Patterns: `DB_PASSWORD=`, `DB_USER=`, `MYSQL_*=`, `REDIS_PASSWORD=`, `*_API_KEY=`, `*_SECRET=`, `JWT_SECRET=`, `STRIPE_*_KEY=`, `AWS_SECRET_ACCESS_KEY=`. The vuln carries the redacted file content; the Credential carries the actual value.
- **Default REDACTED mode for secrets in vuln descriptions.** Toggleable per export ("include raw secrets"). Off by default — even on operator's own Faraday, you don't want raw API keys in a shared engagement workspace by accident. The proper Credential entities still carry the raw value either way.

---

## 2. File format

The downloaded file is plain JSON, suffix `.json`. Filename pattern:

```
vektor-x-export-<workspace_or_engagement>-<unix_timestamp>.json
```

e.g. `vektor-x-export-acme-2026q2-1779036000.json`.

The structure matches Faraday's `faraday_json` plugin (which is also what the `bulk_create` endpoint accepts — same schema, different transport):

```json
{
  "command": {
    "tool": "vektor-x-webshell",
    "command": "scan_export",
    "user": "<operator-tag>",
    "hostname": "<source-host>",
    "params": "scan_id=89ab12cd build_id=8f75eb04",
    "import_source": "report",
    "start_date": "2026-05-16T10:00:00",
    "end_date":   "2026-05-16T10:00:05"
  },
  "hosts": [
    {
      "ip": "192.168.1.10",
      "description": "Target of webshell engagement (build 8f75eb04)",
      "hostnames": ["www.target.lan"],
      "mac": "aa:bb:cc:dd:ee:ff",
      "os": "Linux (php_uname)",
      "owned": true,
      "services": [
        {
          "name": "http",
          "port": 80,
          "protocol": "tcp",
          "status": "open",
          "version": "nginx/1.18.0",
          "description": "HTTP/1.1 200 OK\nServer: nginx/1.18.0\nContent-Type: text/html",
          "owned": false,
          "vulnerabilities": [
            {
              "name": "Self-signed TLS certificate",
              "severity": "info",
              "desc": "CN=target.lan\nIssuer=CN=target.lan\nValid: 2024-01-01 → 2025-01-01\nSANs: target.lan",
              "type": "Vulnerability",
              "refs": []
            }
          ]
        }
      ],
      "vulnerabilities": [
        {
          "name": "Webshell installed",
          "severity": "critical",
          "desc": "vektor-x webshell at /var/www/html/shell_8f75eb04.php\nphp 8.5.5, uid=33(www-data), cwd=/var/www/html",
          "type": "Vulnerability",
          "refs": ["build:8f75eb04"]
        },
        {
          "name": "Sensitive file readable: /etc/shadow",
          "severity": "critical",
          "desc": "File readable by webshell uid (33).",
          "type": "Vulnerability",
          "refs": []
        },
        {
          "name": "www-data in privileged group: docker",
          "severity": "high",
          "desc": "Docker group membership grants root-equivalent access via `docker run -v /:/host`.",
          "type": "Vulnerability",
          "refs": []
        },
        {
          "name": "Application secrets exposed: /var/www/html/.env",
          "severity": "critical",
          "desc": "Found .env at /var/www/html/.env\n\nDB_HOST=db.internal\nDB_PORT=3306\nDB_USER=appuser\nDB_PASSWORD=<REDACTED:24>\nSTRIPE_SECRET_KEY=<REDACTED:64>\n",
          "type": "Vulnerability",
          "refs": ["file:/var/www/html/.env"]
        }
      ],
      "credentials": [
        {
          "name": "DB_PASSWORD from .env",
          "username": "appuser",
          "password": "actual-password-here",
          "endpoint": "/var/www/html/.env"
        },
        {
          "name": "STRIPE_SECRET_KEY from .env",
          "username": "",
          "password": "sk_live_actualkeyhere",
          "endpoint": "/var/www/html/.env"
        }
      ]
    },
    {
      "ip": "192.168.1.1",
      "hostnames": [],
      "mac": "ee:ee:ee:ee:ee:ee",
      "os": "",
      "owned": false,
      "services": [
        { "name": "http", "port": 80, "protocol": "tcp", "status": "open",
          "version": "ZyXEL Keenetic Viva",
          "description": "Digest auth realm=\"ZyXEL Keenetic Viva\"" }
      ],
      "vulnerabilities": [],
      "credentials": []
    }
  ]
}
```

Constants:
- `command.tool = "vektor-x-webshell"`
- `command.import_source = "report"`
- `command.user` = operator-provided tag from Settings (defaults to `"operator"`)
- `command.hostname` = the webshell origin (descriptive — Faraday uses this as a provenance display string)

---

## 3. Export pipeline

```
                ┌──────────────────────────────────────────────┐
                │  Operator clicks "↑ Faraday export"          │
                │  (per-scan, per-diagnostics, or "export all")│
                └────────────────────┬─────────────────────────┘
                                     │
                ┌────────────────────▼─────────────────────────┐
                │  Read config from localStorage               │
                │   faraday.workspace, faraday.user            │
                │   faraday.revealSecrets (bool, default false)│
                │  Missing workspace → open Settings card      │
                └────────────────────┬─────────────────────────┘
                                     │
                ┌────────────────────▼─────────────────────────┐
                │  faradayBuildPayload({                       │
                │     scanIds?, includeDiag?, includeAll?,     │
                │     revealSecrets })                         │
                │  - read IDB scans + scan_results             │
                │  - read last cached diag blob                │
                │  - merge ARP MACs into hosts                 │
                │  - extract creds from env_files              │
                │  - map severities (table §1)                 │
                │  - normalize vuln names/descs (dedup §6)     │
                └────────────────────┬─────────────────────────┘
                                     │
                ┌────────────────────▼─────────────────────────┐
                │  Blob → URL.createObjectURL → <a download>   │
                │  Filename: vektor-x-export-<ws>-<ts>.json    │
                └────────────────────┬─────────────────────────┘
                                     │
                ┌────────────────────▼─────────────────────────┐
                │  Toast: "Exported N hosts, M services, K     │
                │  vulns. Upload via:                          │
                │    faraday-cli tool report <file>            │
                │  or drag-drop in Faraday > New Report."      │
                └──────────────────────────────────────────────┘
```

Triggers are always **explicit user clicks** — never automatic.

---

## 4. UI surfaces

Three export points + one settings surface. No transport / connection UI at all.

### 4a. Per-scan export button (Scanner tab)

Each scan card's button group gets one more button before Export:
```
⏸ Pause   ■ Stop   ↑ Faraday   ⬇ Export   ✖ Delete
```
Exports just that scan's hosts + services + TLS-cert vulns.

### 4b. Diagnostics export button

Diagnostics tab card header gains:
```
SYSTEM DIAGNOSTICS                          ↑ Faraday    🔄 Refresh
```
Exports the currently-loaded diag blob (vulns + notes + ARP hosts + listening services on the target).

### 4c. Sidebar global export

Database panel in sidebar gains:
```
DATABASE
⬇ Export DB
⬆ Import DB
↑ Faraday export       ← new
```
Exports everything in IDB plus last cached diag blob in one file.

### 4d. Settings card

A small collapsible card at the top of the Diagnostics tab:

```
┌─ FARADAY EXPORT SETTINGS ──────────────────────────────────┐
│  Workspace name   [ acme-2026q2                  ]         │
│  Operator tag     [ whitebyte                    ]         │
│                                                            │
│  [ ] Include raw secrets in vulnerability descriptions     │
│      (Credentials always carry the raw value; this only    │
│      controls whether secrets appear in vuln narrative.)   │
│                                                            │
│  Files download as vektor-x-export-<workspace>-<ts>.json.  │
│  Upload them with:                                         │
│    faraday-cli tool report <file>                          │
│  or drag-drop into Faraday → New Report.                   │
└────────────────────────────────────────────────────────────┘
```

No URL field. No token field. No Test Connection. Workspace and operator tag are used only to fill in the filename and the `command.user` provenance — they're informational.

---

## 5. Dedup & idempotency

Faraday's `faraday_json` import dedupes server-side:

| Entity | Unique key |
|---|---|
| Host | `(workspace, ip)` |
| Service | `(host, port, protocol)` |
| Vulnerability | `(host_or_service, name, desc)` |
| Credential | `(host, port, username)` |

This means: **re-uploading the same file is safe** — no duplicates. Updates flow through (e.g., updated banner → service description updates).

What we have to do on our side to keep dedup working:

1. **Normalize descriptions** so they don't include timestamps (e.g., don't append "(captured 2026-05-16T10:00:05)" to a vuln description — that defeats the `desc` half of the unique key).
2. **Stable vulnerability names** — `"Sensitive file readable: /etc/shadow"`, not `"Found shadow file at /etc/shadow"`. The path-in-name pattern is the dedup anchor.
3. **Credentials**: use stable `name` like `"DB_PASSWORD from .env"`. If two .envs both define `DB_PASSWORD` but for different users, the `(host, port, username)` tuple already distinguishes.
4. **Don't include scan_id in vuln descriptions** — that would re-create the vuln on every new scan. Scan provenance goes on the `command` entity only.

---

## 6. OPSEC notes

The export-only design dramatically simplifies the OPSEC story:

1. **Zero network traffic anywhere except the shell origin.** The browser only talks to the target server (to fetch shell data). The export file is generated in the browser and saved locally via `<a download>`. The operator's Faraday endpoint, IP, hostname, port — none of it ever exists in any wire-observable form.
2. **No PHP-backend involvement.** There is no `action=faraday_export` handler. The PHP shell file genuinely cannot leak anything Faraday-related under any compromise model because it never receives anything Faraday-related.
3. **No token storage.** Nothing for XSS or a forensic browser inspection to recover. The operator's Faraday API token never enters the webshell domain.
4. **No CORS surface.** No preflight requests, no failed-to-fetch noise in DevTools, no Faraday URL appearing as `Origin` in logs anywhere.
5. **Settings cleared on Self-Destruct.** `selfDestruct()` already wipes IndexedDB and sessionStorage; extend it to wipe `localStorage` keys matching `faraday.*` and `webtun.*`.
6. **Workspace must be set per engagement.** Empty workspace blocks export with a clear error. Prevents accidentally cross-contaminating two engagements that share a browser profile.
7. **Secrets redaction is default-on** in vuln descriptions. Toggle in Settings or per-export modal to reveal. The proper Credential entities carry raw values either way (Faraday's Credential view is shorter / more locked down than rendering a vuln description with raw keys to the whole engagement team).
8. **Downloaded file contains raw secrets** (when revealSecrets is on, or always for the Credentials block). Filename pattern is `vektor-x-export-<workspace>-<timestamp>.json` so it's obvious what it is. Operator's responsibility for safe transport (don't email it; transfer over the same channel used for the engagement).
9. **No auto-export.** Always manual. Avoids accidentally exporting data captured from a target the operator didn't intend to engage (e.g., loaded the shell on a test server for debugging).

---

## 7. Implementation outline (file-level, no code)

**New files:**

- `src/frontend/js/faraday.js` (~150 LoC — smaller than the push variant)
  - `faradayConfigure()` — opens Settings card (toggle visibility)
  - `faradayBuildPayload({scanIds?, includeDiag?, includeAll?, revealSecrets})` — assembles JSON
  - `faradayExport(opts)` — build + download (replaces `faradayPush`)
  - `faradayExportScan(scanId)` / `faradayExportDiag()` / `faradayExportAll()` — entry points
  - `_extractCredsFromEnv(content)` — regex parser for known secret patterns
  - `_severityFor(...)` — mapping table from §1
  - `_downloadJson(payload, filename)` — Blob + objectURL + click

**Modified files:**

- `src/frontend/html/layout.html`
  - Settings card at top of Diagnostics tab
  - `↑ Faraday` button in Diagnostics card header
  - `↑ Faraday export` button in sidebar Database panel
- `src/frontend/js/scanner.js`
  - `renderScanHeader()`: add `↑ Faraday` button to control row
- `src/frontend/js/diagnostics.js`
  - Cache last loaded diag blob in module scope so export has fresh data
- `src/frontend/js/destruct.js`
  - Wipe `localStorage` keys matching `faraday.*`
- `src/frontend/js/_order.json`
  - Add `"faraday"` (after `db`, before `console`)
- `src/backend/php/diagnostics.php`
  - Add `target_ip` (from `$_SERVER['SERVER_ADDR']`) and `target_host` (from `$_SERVER['SERVER_NAME']`) to response. Also `webshell_path` from `$_SERVER['SCRIPT_FILENAME']` for the "Webshell installed" vuln description.
- `generate.py`
  - `MODULE_JS['faraday'] = ['faraday.js']` so the module can be excluded via `--exclude faraday`.

**Build size impact:** ~7 KB added (uncompressed) — less than the push variant since no fetch / error handling / retry logic.

---

## 8. Severity matrix (consolidated)

| Trigger | Severity |
|---|---|
| Webshell executes as root | critical |
| Sensitive file readable (/etc/shadow, id_rsa, authorized_keys) | critical |
| Application secrets exposed (.env, config.php) | critical |
| User in `sudo`/`wheel`/`docker`/`lxd` group | high |
| Binary dir writable | high |
| `.bash_history` or `.env` readable | high |
| System path writable (`/var/www`, `/etc`) | medium |
| User in `adm`/`shadow`/`disk` group | medium |
| Self-signed TLS cert | info |
| Expired/expiring TLS cert | low |
| Detected hosting panel | info |
| Container detected | info |
| Login user with shell present | info |
| Open port (alone) | n/a (Service, not Vuln) |
| Banner-revealed version | n/a (no vuln — let nuclei decide) |

---

## 9. How the operator consumes the file

After download:

**Via faraday-cli (preferred for batch / scripted workflows):**
```
faraday-cli auth -f http://faraday:5985 -u <user> -p <pass>
faraday-cli workspace -c acme-2026q2     # if not already created
faraday-cli tool report vektor-x-export-acme-2026q2-1779036000.json -w acme-2026q2
```

**Via Faraday web UI:**
- Faraday → Workspaces → `acme-2026q2` → "New report" → drag-drop the file → select plugin `faraday_json` → Import.

Both routes call the same internal import path and produce identical entities.

---

## 10. Future extensions (out of scope here)

- **Nemesis integration**: when an operator downloads a file via the webshell, also offer a parallel export to a Nemesis-compatible bundle. Same pattern, different schema.
- **Multi-engagement workspace switcher** in the UI for operators who routinely run multiple engagements from the same browser (currently they edit the workspace field manually).
- **A "preview before download" modal** that shows the entity counts (e.g., "5 hosts, 12 services, 8 vulns, 2 credentials") with checkboxes to deselect items before export.
- **Per-scan vs per-host export**: currently per-scan exports all of that scan's hosts; an alternative slicing is per-host (everything we know about 192.168.1.10) across all scans.
