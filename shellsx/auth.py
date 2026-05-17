"""Password-gated login screen.

Emitted as a PHP block that runs before the main shell renders: SHA256
of the password is checked against an embedded hash; on success the
browser-side AES key is derived from the same password (via Web Crypto
in the login form's submit handler) and stashed in sessionStorage.

The login markup lives in ``src/frontend/html/login.html`` — this
module just substitutes the palette-derived placeholders and wraps the
result in the PHP auth gate.
"""

import hashlib

from .config import read_file
from .paths import LOGIN_HTML_PATH
from .theme import lighten_hex


# Default palette used when the operator builds with --password but no
# theme — keeps the login page legible even without a custom palette.
_LOGIN_DEFAULTS = {
    '--bg': '#0d1117', '--panel': '#161b22', '--border': '#30363d',
    '--text': '#c9d1d9', '--muted': '#8b949e', '--accent': '#58a6ff',
    '--red': '#f85149',
}


def _resolve_login_palette(palette):
    """Layer the operator palette over safe defaults and derive the two
    helper colors the login HTML needs alongside the raw vars."""
    colors = dict(_LOGIN_DEFAULTS)
    if palette:
        colors.update({k: v for k, v in palette.items() if k in colors})
    return {
        'root_vars':    ';'.join(f'{k}:{v}' for k, v in colors.items()),
        'input_bg':     colors['--bg'],
        'accent_hover': lighten_hex(colors['--accent'], 15),
    }


def _render_login_html(palette):
    """Read the login template and substitute the three palette
    placeholders. Returned string is raw HTML — not yet PHP-escaped."""
    parts = _resolve_login_palette(palette)
    html = read_file(LOGIN_HTML_PATH)
    return (
        html
        .replace('{{ROOT_VARS}}',    parts['root_vars'])
        .replace('{{INPUT_BG}}',     parts['input_bg'])
        .replace('{{ACCENT_HOVER}}', parts['accent_hover'])
    )


def _php_single_quote_escape(s):
    """Escape a string for embedding in a PHP single-quoted literal.
    Only ``\\`` and ``'`` are special inside single quotes; everything
    else (including newlines) is preserved verbatim."""
    return s.replace('\\', '\\\\').replace("'", "\\'")


def build_auth_block(password, palette=None):
    """Generate the PHP session-based auth block (runs before main shell).

    The login form's JavaScript hashes the password client-side and
    stores the hex digest in ``sessionStorage['__enc_key']`` so subsequent
    AES-encrypted XHRs can use it without re-prompting.
    """
    pw_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()
    login_html = _php_single_quote_escape(_render_login_html(palette))

    return f"""$__AUTH_HASH = '{pw_hash}';
session_start();
if (isset($_POST['__auth_pass'])) {{
    if (hash_equals($__AUTH_HASH, hash('sha256', $_POST['__auth_pass']))) {{
        $_SESSION['__authed'] = true;
        header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
        exit;
    }}
}}
if (isset($_GET['logout'])) {{
    session_destroy();
    header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
    exit;
}}
if (empty($_SESSION['__authed'])) {{
    ob_end_clean();
    header('Content-Type: text/html; charset=UTF-8');
    echo '{login_html}';
    exit;
}}"""
