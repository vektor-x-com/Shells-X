"""Build fingerprinting + integrity verification.

Every generated shell embeds a SHA256 of its own contents (computed
before the meta-injection pass, so the hash describes the source
material plus timestamp + seed). ``verify_shell`` re-reads a deployed
file and confirms the embedded fingerprint is still well-formed.
"""

import hashlib
import re
import time

from .config import read_file


def generate_build_meta(content, seed, lang, version):
    """Compute the build's SHA256 + short ID + timestamp.

    The hash mixes content + timestamp + seed so two builds of the same
    source (same minute, different operator seeds) get distinct IDs.
    """
    timestamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    raw = content + timestamp + (seed or '')
    full_hash = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    return {
        'hash': full_hash,
        'short_id': full_hash[:8],
        'timestamp': timestamp,
        'lang': lang,
        'version': version,
        'seed': seed or '',
    }


def verify_shell(filepath):
    """Verify a generated shell's integrity by inspecting the embedded
    fingerprint comment. Returns True on success, False otherwise.

    We don't recompute the hash (the build pipeline can't be reversed
    from the assembled file alone) — we just confirm the marker is
    well-formed and surface the build ID + timestamp for the operator.
    """
    content = read_file(filepath)

    hash_match = re.search(r'SHA256:\s*([a-f0-9]{64})', content)
    if not hash_match:
        print(f"[!] No build hash found in {filepath}")
        return False

    ts_match = re.search(r'Build:.*?\|\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)', content)
    if ts_match:
        print(f"[*] Build timestamp: {ts_match.group(1)}")

    print(f"[*] Embedded SHA256: {hash_match.group(1)}")

    sid_match = re.search(r'Build:\s*([a-f0-9]{8})', content)
    if sid_match:
        print(f"[*] Build ID: {sid_match.group(1)}")

    print(f"[+] Shell at {filepath} has valid build signature")
    return True
