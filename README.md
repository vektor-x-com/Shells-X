# Webshells

A modular, single-file web shell framework with a build generator. Development happens in clean, separated source modules — deployment is always a single file. Every build gets a unique SHA256 fingerprint.

> **Disclaimer:** This tool is intended for authorized penetration testing, red team operations, CTF competitions, and security research only. Unauthorized access to computer systems is illegal. Always obtain proper authorization before use.

## Features

- **PHP Console** — execute PHP code with output capture
- **OS Shell** — auto-detected system command execution (probes `system`, `exec`, `shell_exec`, `passthru`, `popen`, `proc_open`) with persistent CWD and command history
- **Network Scanner** — CIDR-based port scanning with non-blocking sockets
- **File Browser** — navigate, download, upload, and delete files
- **System Diagnostics** — full recon: identity, SUID binaries, writable dirs, ARP table, open ports, routing, installed panels, DB credentials, process list
- **Pivot Map** — visual network topology from scan results
- **Command History** — persistent history with re-run and export
- **IndexedDB Storage** — all client data persists in the browser with full export/import

## Quick Start

```bash
# Default build — full featured, no auth
python generate.py

# Password-protected, minified, with operator fingerprint
python generate.py --password s3cret --minify --seed "op-nighthawk"

# Minimal build — exclude optional modules
python generate.py --exclude scanner,pivot,diagnostics

# Verify a shell's integrity
python generate.py --verify dist/shell_a3f8c1e2.php
```

Output lands in `dist/`. Deploy the single `.php` file to a web server.

## Generator Options

| Flag | Description |
|------|-------------|
| `--lang php` | Target language (default: `php`) |
| `--password SECRET` | Bake in password protection (SHA256 hash embedded) |
| `--seed STRING` | Operator seed for unique fingerprinting |
| `--minify` | Strip comments and collapse whitespace |
| `--exclude MODULES` | Comma-separated modules to exclude |
| `--output NAME` | Custom output filename |
| `--verify FILE` | Check integrity of a generated shell |

## Modules

| Module | Required | Description |
|--------|----------|-------------|
| `console` | Yes | PHP eval + OS shell |
| `files` | Yes | File browser, upload, delete, download |
| `scanner` | No | CIDR port scanner with async sockets |
| `diagnostics` | No | System recon, privesc hints, network info |
| `history` | No | Command history viewer |
| `pivot` | No | Visual network map from scan data |

Exclude optional modules with `--exclude scanner,pivot,history,diagnostics` for a smaller footprint.

## Build Fingerprint

Every generated shell embeds a unique `__BUILD` object:

```json
{
  "hash": "a3f8c1e2...",
  "short_id": "a3f8c1e2",
  "timestamp": "2026-03-27T15:40:29Z",
  "lang": "php",
  "version": "1.0.0",
  "seed": "op-nighthawk"
}
```

- Visible in the **Diagnostics** tab under "Build Info"
- `--verify` mode checks the embedded hash
- Useful for operational deconfliction and attribution

## Password Protection

When built with `--password`, the shell shows a login page. The password is stored as a SHA256 hash — the plaintext is never in the file.

```bash
python generate.py --password "hunter2"
```

Logout via `?logout` query parameter.

## Project Structure

```
Webshells/
├── generate.py                     # Build tool (Python 3, zero dependencies)
├── templates/
│   └── php.tpl                     # PHP single-file template
├── src/
│   ├── backend/php/
│   │   ├── _order.json             # Assembly order
│   │   ├── auth.php                # Session auth (injected by generator)
│   │   ├── download.php            # GET file download handler
│   │   ├── scanner.php             # CIDR port scanner
│   │   ├── filebrowser.php         # Directory listing
│   │   ├── fileops.php             # Delete + upload
│   │   ├── eval.php                # PHP code execution
│   │   ├── shell.php               # OS command execution
│   │   └── diagnostics.php         # System recon
│   ├── frontend/
│   │   ├── css/shell.css           # Dark theme styles
│   │   ├── js/
│   │   │   ├── _order.json         # Assembly order
│   │   │   ├── core.js             # Fetch, escaping, tab navigation
│   │   │   ├── db.js               # IndexedDB CRUD + export/import
│   │   │   ├── console.js          # PHP console UI
│   │   │   ├── shell.js            # OS shell UI + auto-probe
│   │   │   ├── scanner.js          # Scanner UI
│   │   │   ├── diagnostics.js      # Diagnostics renderer
│   │   │   ├── history.js          # History viewer
│   │   │   ├── filebrowser.js      # File browser UI
│   │   │   └── pivotmap.js         # Pivot map visualization
│   │   └── html/layout.html        # HTML layout with module markers
│   └── config/defaults.json        # Version + module definitions
├── dist/                           # Generated shells (gitignored)
└── .gitignore
```

## Adding a New Backend Language

The frontend (HTML/CSS/JS) is language-agnostic — it communicates via `fetch()` with JSON responses. Only the backend changes per language.

To add a new language:

1. Create `templates/{lang}.tpl` with placeholders: `{{AUTH_BLOCK}}`, `{{BACKEND}}`, `{{CSS}}`, `{{JS}}`, `{{HTML_BODY}}`, `{{BUILD_META_JSON}}`
2. Create `src/backend/{lang}/` with handler modules implementing the action contract
3. Add the language to `generate.py`'s `--lang` choices

### Backend Action Contract

| Action | POST Params | Response |
|--------|-------------|----------|
| `scan` | `cidr`, `port` | `{"open": ["ip:port", ...], "total": N}` |
| `ls` | `dir` | `{"dir": "/path", "entries": [...]}` |
| `delete` | `path` | `{"ok": true}` or `{"error": "msg"}` |
| `upload` | `dir`, `file` | `{"ok": true, "path": "..."}` or `{"error": "msg"}` |
| `eval` | `code` | `{"output": "..."}` |
| `shell` | `cmd`, `cwd` | `{"output": "...", "cwd": "/new/path", "method": "system", "available": true}` |
| `diag` | — | `{"php_version": "...", "os": "...", ...}` |
| GET `?download=` | path in query | Raw file stream |

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+Enter` | PHP Console | Execute code |
| `Enter` | OS Shell | Execute command |
| `Arrow Up/Down` | OS Shell | Navigate command history |
| `Ctrl+L` | OS Shell | Clear terminal output |

## Requirements

- **Generator:** Python 3.6+ (stdlib only, zero dependencies)
- **Runtime:** PHP 5.6+ with `sockets` extension (for scanner)
- **Browser:** Any modern browser with IndexedDB support

## License

MIT
