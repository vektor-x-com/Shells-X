"""Shells-X import plugin for Pentest Collaboration Framework.

Consumes the JSON (and optionally the credentials CSV) produced by the
Shells-X webshell's Faraday export — https://github.com/vektor-x-com/Shells-X —
and writes the contained hosts, services, hostnames, descriptions and
credentials into the current PCF project.

Why this plugin exists:
    Shells-X already emits a Faraday-compatible bulk_create JSON. Faraday's
    server-side ingestion silently drops the credentials array, forcing a
    two-file dance through the UI. PCF has no equivalent gap — its plugin
    contract gives direct DB access including `db.insert_new_cred()` — so a
    one-click import is possible.

Install:
    cp -r shellsx <pcf>/routes/ui/tools_addons/import_plugins/
    restart PCF, open a project → Tools → "Shells-X".

Plugin author: @whitebyte0
"""

import csv
import datetime
import io
import ipaddress
import json
import logging
import re

from flask_wtf import FlaskForm
from wtforms import BooleanField, MultipleFileField, StringField

from system.db import Database  # noqa: F401 — referenced in type-hints only


# ---------------------------------------------------------------------------
# Plugin descriptor — auto-discovered by routes/ui/tools.py
# ---------------------------------------------------------------------------

route_name = "shellsx"

tools_description = [
    {
        "Icon file": "icon.png",
        "Icon URL": "https://raw.githubusercontent.com/vektor-x-com/Shells-X/main/integrations/pcf/shellsx/icon.png",
        "Official name": "Shells-X",
        "Short name": "shellsx",
        # Plain text — PCF renders this verbatim, no HTML.
        "Description": (
            "Import Shells-X webshell recon exports: hosts, open services with "
            "banners and TLS info, hostnames, full system posture, and parsed "
            "credentials from .env / wp-config.php / .my.cnf / .pgpass / "
            "framework configs. See: github.com/vektor-x-com/Shells-X"
        ),
        "URL": "https://github.com/vektor-x-com/Shells-X",
        "Plugin author": "@whitebyte0",
    },
]


# ---------------------------------------------------------------------------
# Form
# ---------------------------------------------------------------------------

class ToolArguments(FlaskForm):
    json_files = MultipleFileField(
        label='json_files',
        description="Shells-X JSON export (shells-x-*.json) — one or more",
        default=None,
        validators=[],
        _meta={"display_row": 1, "display_column": 1, "file_extensions": ".json"},
    )
    csv_files = MultipleFileField(
        label='csv_files',
        description="Optional credentials CSV (shells-x-*-credentials.csv) — "
                    "only needed if the JSON isn't available; otherwise the JSON "
                    "already carries the same credentials",
        default=None,
        validators=[],
        _meta={"display_row": 1, "display_column": 2, "file_extensions": ".csv"},
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_HASH_TYPE = "plaintext"
_CSV_ENDPOINT_RE = re.compile(r"^\s*([0-9a-fA-F.:]+)\s*::\s*(.+?)(?:\s*\(([^)]+)\))?\s*$")

# Per-service description cap. TLS banners with full cert + SANs routinely hit
# 4-8KB; PCF's port-detail UI gets unwieldy past ~2KB. We truncate with an
# explicit marker so the operator knows there's more in the source export.
_MAX_DESC_CHARS = 2000


def _decode(blob):
    """Decode an uploaded bytes object — utf-8 with BOM tolerance."""
    if isinstance(blob, str):
        return blob
    return blob.decode("utf-8-sig", errors="replace")


def _truncate(text, limit=_MAX_DESC_CHARS):
    """Cap a string and append a clear truncation marker. No-op below limit."""
    if not text or len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n…(truncated, {len(text) - limit} more chars)"


def _parse_int_port(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def _service_description(service):
    """Compose a port description from banner + version + status. Capped at
    _MAX_DESC_CHARS — TLS banners with full SANs can hit 4-8 KB and make
    PCF's port-detail UI unreadable."""
    parts = []
    desc = (service.get("description") or "").strip()
    if desc:
        parts.append(desc)
    version = (service.get("version") or "").strip()
    if version:
        parts.append(f"Version: {version}")
    status = (service.get("status") or "").strip()
    if status and status != "open":
        parts.append(f"Status: {status}")
    return _truncate("\n".join(parts))


def _append_host_comment(existing, fresh, timestamp):
    """Build the new host.comment for a re-import — old + divider + fresh."""
    old = (existing or "").rstrip()
    new = (fresh or "").strip()
    if not new:
        return old or ""
    if not old:
        return new
    divider = f"\n\n--- Re-import {timestamp} ---\n"
    return old + divider + new


def _build_cred_services(endpoint, port_ids_by_key, hostname_ids):
    """Look at the credential endpoint string and try to link to a known
    service / hostname so the cred shows up under that host/service in PCF's
    Credentials view. Returns the JSON-shape dict PCF expects."""
    if not endpoint:
        return {}
    # Try host:port hint (common for db connection strings we parse upstream)
    m = re.search(r"[:@]\s*(\d{1,5})(?:[/?]|$)", endpoint)
    if m:
        port = _parse_int_port(m.group(1))
        if port:
            # Match against any known protocol for this port
            for (p, is_tcp), pid in port_ids_by_key.items():
                if p == port:
                    return {pid: list(hostname_ids.values())}
    return {}


def _extract_ip_from_csv_endpoint(endpoint):
    """CSV endpoint convention from shells-x: '<ip> :: <path> (<name>)'."""
    if not endpoint:
        return None, endpoint, ""
    m = _CSV_ENDPOINT_RE.match(endpoint)
    if not m:
        return None, endpoint, ""
    return m.group(1), m.group(2), (m.group(3) or "")


def _is_valid_ip(ip):
    try:
        ipaddress.ip_address(ip)
        return True
    except (ValueError, TypeError):
        return False


class _ProjectCache:
    """Pre-fetched view of a PCF project's hosts / ports / hostnames / creds.

    Imports of any size do at most 4 SELECT-all queries up front, then every
    dedup check is an in-memory dict/set lookup. Inserts still go to the DB
    one by one (see #3 in the dev guide for the full batch-insert refactor),
    but each insert also updates this cache so dedup stays correct as rows
    accumulate within a single run.

    Without this cache, a 100-host / 500-port / 200-cred import did
    1 + 100 + (500 * 1-2) + 200 ≈ 1200+ round-trips. With it: 4 queries plus
    one INSERT per *new* row.
    """

    def __init__(self, db, project_id):
        self.db = db
        self.project_id = project_id
        self.hosts_by_ip = {
            h['ip']: h for h in db.select_project_hosts(project_id=project_id)
        }
        self.port_ids = {
            (p['host_id'], p['port'], p['is_tcp']): p['id']
            for p in db.select_project_ports(project_id)
        }
        self.hostname_ids = {
            (h['host_id'], h['hostname']): h['id']
            for h in db.select_project_hostnames(project_id)
        }
        # Match select_creds_dublicates' WHERE clause exactly so the in-memory
        # check and a DB check would always agree.
        self.cred_keys = {
            (c['login'], c['hash'], c['cleartext'],
             c['description'], c['source'], c['hash_type'])
            for c in db.select_project_creds(project_id)
        }

    # ---- Hosts
    def find_host(self, ip):
        return self.hosts_by_ip.get(ip)

    def add_host(self, host_row):
        self.hosts_by_ip[host_row['ip']] = host_row

    # ---- Ports
    def find_port_id(self, host_id, port, is_tcp):
        return self.port_ids.get((host_id, port, int(is_tcp)))

    def add_port_id(self, host_id, port, is_tcp, port_id):
        self.port_ids[(host_id, port, int(is_tcp))] = port_id

    # ---- Hostnames
    def find_hostname_id(self, host_id, hostname):
        return self.hostname_ids.get((host_id, hostname))

    def add_hostname_id(self, host_id, hostname, hostname_id):
        self.hostname_ids[(host_id, hostname)] = hostname_id

    # ---- Credentials
    def _cred_key(self, login, cleartext, description, source):
        return (login, "", cleartext, description, source, _HASH_TYPE)

    def cred_exists(self, login, cleartext, description, source):
        return self._cred_key(login, cleartext, description, source) in self.cred_keys

    def add_cred(self, login, cleartext, description, source):
        self.cred_keys.add(self._cred_key(login, cleartext, description, source))


def _insert_credential(db, cache, counters, *, project_id, user_id, login,
                       cleartext, description, source, services):
    """Dedup-then-insert a credential. Returns True if a new row was created."""
    if not login and not cleartext:
        return False
    if cache.cred_exists(login, cleartext, description, source):
        counters['creds_dup'] += 1
        return False
    db.insert_new_cred(
        login=login,
        password_hash="",
        hash_type=_HASH_TYPE,
        cleartext_passwd=cleartext,
        description=description,
        source=source,
        services=services,
        user_id=user_id,
        project_id=project_id,
    )
    cache.add_cred(login, cleartext, description, source)
    counters['creds_new'] += 1
    return True


# ---------------------------------------------------------------------------
# Per-host import — the main work
# ---------------------------------------------------------------------------

def _import_host(db, cache, counters, host, *, project_id, user_id, import_ts):
    ip = (host.get("ip") or "").strip()
    if not _is_valid_ip(ip):
        counters['errors'].append(f"skipped host with invalid IP: {ip!r}")
        return

    fresh_comment = (host.get("description") or "").strip()
    os_name = (host.get("os") or "").strip()

    # ---- Host: dedup by (project_id, ip), append posture block on re-import.
    existing = cache.find_host(ip)
    if existing:
        host_id = existing['id']
        counters['hosts_dup'] += 1
        if fresh_comment:
            merged = _append_host_comment(
                existing.get('comment', ''), fresh_comment, import_ts,
            )
            db.update_host_description(host_id, merged)
            existing['comment'] = merged   # keep cache coherent for further re-imports in same run
        # Don't overwrite OS — analyst may have set it more specifically.
    else:
        host_id = db.insert_host(
            project_id, ip, user_id,
            comment=fresh_comment, threats=[], os=os_name,
        )
        # Add a minimal row to the cache so a duplicate IP in the SAME run
        # (rare but possible across multi-file uploads) dedupes correctly.
        cache.add_host({
            'id': host_id, 'ip': ip,
            'comment': fresh_comment, 'os': os_name,
        })
        counters['hosts_new'] += 1

    # ---- Hostnames (multiple per host allowed in PCF)
    hostname_ids = {}
    for hn in host.get("hostnames") or []:
        hn = (hn or "").strip()
        if not hn:
            continue
        existing_hn_id = cache.find_hostname_id(host_id, hn)
        if existing_hn_id:
            hostname_ids[hn] = existing_hn_id
        else:
            hn_id = db.insert_hostname(
                host_id, hn, "Imported from Shells-X", user_id,
            )
            cache.add_hostname_id(host_id, hn, hn_id)
            hostname_ids[hn] = hn_id
            counters['hostnames_new'] += 1

    # ---- Services (open ports only — shells-x only persists 'open')
    port_ids_by_key = {}  # (port, is_tcp_int) -> port_id
    for service in host.get("services") or []:
        port = _parse_int_port(service.get("port"))
        if port is None:
            counters['errors'].append(
                f"{ip}: skipped service with bad port {service.get('port')!r}"
            )
            continue
        is_tcp = (service.get("protocol") or "tcp").lower() == "tcp"
        # In-memory dedup avoids the wasteful insert→'exist'→select_ip_port
        # round-trip that the old per-row pattern paid for every duplicate port.
        existing_port_id = cache.find_port_id(host_id, port, is_tcp)
        if existing_port_id:
            counters['ports_dup'] += 1
            port_ids_by_key[(port, int(is_tcp))] = existing_port_id
            continue
        name = (service.get("name") or "").strip() or "unknown"
        desc = _service_description(service)
        ret = db.insert_host_port(
            host_id, port, is_tcp, name, desc, user_id, project_id,
        )
        if ret == 'exist':
            # Belt-and-suspenders: another process may have inserted between
            # our prefetch and now. Fall back to the slow path so we still get
            # a port_id to link credentials against.
            counters['ports_dup'] += 1
            existing_port = db.select_ip_port(host_id, port, is_tcp)
            if existing_port:
                pid = existing_port[0]['id']
                cache.add_port_id(host_id, port, is_tcp, pid)
                port_ids_by_key[(port, int(is_tcp))] = pid
        else:
            cache.add_port_id(host_id, port, is_tcp, ret)
            port_ids_by_key[(port, int(is_tcp))] = ret
            counters['ports_new'] += 1

    # ---- Credentials (preferred path — JSON carries them already)
    for cred in host.get("credentials") or []:
        username = (cred.get("username") or "").strip()
        password = cred.get("password") or ""
        # `name` in our shape is a descriptive label ("DB_PASSWORD",
        # "WordPress DB @ ..."). PCF's `description` field is the right home.
        description = (cred.get("name") or "").strip()
        source = (cred.get("endpoint") or "").strip() or "Shells-X import"
        services = _build_cred_services(
            cred.get("endpoint"), port_ids_by_key, hostname_ids,
        )
        _insert_credential(
            db, cache, counters,
            project_id=project_id, user_id=user_id,
            login=username, cleartext=password,
            description=description, source=source,
            services=services,
        )


# ---------------------------------------------------------------------------
# CSV fallback — only used for IPs the JSON didn't already cover
# ---------------------------------------------------------------------------

def _import_csv_credentials(db, cache, counters, blobs, *,
                            project_id, user_id, seen_ips):
    """Parse one or more shells-x credentials CSVs and insert any creds for
    hosts that the JSON-path didn't already cover for this run."""
    if not blobs:
        return
    for blob in blobs:
        try:
            text = _decode(blob)
            reader = csv.DictReader(io.StringIO(text))
        except Exception as e:
            counters['errors'].append(f"CSV parse failed: {e}")
            continue
        for row in reader:
            username = (row.get('username') or '').strip()
            password = row.get('password') or ''
            endpoint = (row.get('endpoint') or '').strip()
            if not username or not password:
                continue
            ip, path, descriptive = _extract_ip_from_csv_endpoint(endpoint)
            # If this IP already produced creds from the JSON pass, skip — the
            # CSV is redundant for it. Otherwise process as standalone.
            if ip and ip in seen_ips:
                counters['creds_dup'] += 1
                continue
            # Locate the host if we know its IP; otherwise insert anyway with
            # services={} (operator can link later).
            services = {}
            description = descriptive or path or "Imported from Shells-X CSV"
            source = endpoint or "Shells-X CSV"
            _insert_credential(
                db, cache, counters,
                project_id=project_id, user_id=user_id,
                login=username, cleartext=password,
                description=description, source=source,
                services=services,
            )


# ---------------------------------------------------------------------------
# Entry point — called by routes/ui/tools.py
# ---------------------------------------------------------------------------

def process_request(current_user, current_project, db, input_dict, global_config):
    """Parse JSON + optional CSV uploads, write into the current project,
    return a summary string ('' on full success)."""
    project_id = current_project['id']
    user_id = current_user['id']
    import_ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    counters = {
        'hosts_new': 0, 'hosts_dup': 0,
        'ports_new': 0, 'ports_dup': 0,
        'hostnames_new': 0,
        'creds_new': 0, 'creds_dup': 0,
        'errors': [],
    }

    json_blobs = input_dict.get('json_files') or []
    csv_blobs = input_dict.get('csv_files') or []
    if not json_blobs and not csv_blobs:
        return "No files provided — drop a Shells-X JSON (and optionally its credentials CSV)."

    # Pre-fetch the project's existing hosts/ports/hostnames/creds ONCE.
    # Every dedup check below becomes an in-memory dict/set lookup instead of a
    # per-row DB SELECT — turns a 100-host import from ~1000+ queries into 4.
    cache = _ProjectCache(db, project_id)

    # ---- JSON pass
    seen_ips_with_creds = set()
    for blob in json_blobs:
        try:
            payload = json.loads(_decode(blob))
        except Exception as e:
            counters['errors'].append(f"JSON parse failed: {e}")
            continue
        hosts = payload.get('hosts') or []
        if not isinstance(hosts, list):
            counters['errors'].append("JSON missing 'hosts' array")
            continue
        for host in hosts:
            if not isinstance(host, dict):
                continue
            try:
                _import_host(
                    db, cache, counters, host,
                    project_id=project_id, user_id=user_id, import_ts=import_ts,
                )
                if host.get('credentials'):
                    ip = (host.get('ip') or '').strip()
                    if ip:
                        seen_ips_with_creds.add(ip)
            except Exception as e:
                logging.exception("shellsx plugin: host import failed")
                counters['errors'].append(f"{host.get('ip', '?')}: {e}")

    # ---- CSV fallback pass (only for IPs the JSON didn't already cover)
    try:
        _import_csv_credentials(
            db, cache, counters, csv_blobs,
            project_id=project_id, user_id=user_id,
            seen_ips=seen_ips_with_creds,
        )
    except Exception as e:
        logging.exception("shellsx plugin: CSV import failed")
        counters['errors'].append(f"CSV: {e}")

    # ---- Summary — always log, but PCF's UI treats any non-empty return as an
    # error (tools.py:3367-3372 appends to errors[], renders red). To match the
    # convention of every other PCF importer (nmap, nessus, openvas → return ""
    # on success), we only return a string when something actually failed.
    # Operators see the count summary via:
    #   - backups/console.log (the logging.info below)
    #   - Project → Logs tab (db.insert_log entries from every insert_*)
    #   - Project → Hosts / Credentials tabs (the actual data)
    summary = (
        f"Shells-X import: "
        f"hosts +{counters['hosts_new']}/={counters['hosts_dup']}, "
        f"ports +{counters['ports_new']}/={counters['ports_dup']}, "
        f"hostnames +{counters['hostnames_new']}, "
        f"credentials +{counters['creds_new']}/={counters['creds_dup']}"
    )
    logging.info("shellsx plugin: %s", summary)
    if counters['errors']:
        for err in counters['errors']:
            logging.error("shellsx plugin: %s", err)
        # On real errors, include the count summary in the message so the
        # operator sees what DID land alongside what failed.
        return summary + f" — {len(counters['errors'])} error(s) (see server log)"
    return ""   # full success → green "Successfully uploaded!" page
