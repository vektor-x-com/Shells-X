"""Password-gated login — language-specific auth gate + shared login HTML.

Each backend language ships ``src/backend/<lang>/auth.<ext>`` with
``@@AUTH_HASH@@`` and ``/*@@LOGIN_ECHO@@*/`` placeholders. This module
renders the login page (shared frontend) and substitutes into the
language template at build time.
"""

import hashlib
import os
import re
import sys

from .config import backend_auth_path, read_file
from .paths import JS_DIR, LOGIN_CSS_PATH, LOGIN_HTML_PATH
from .theme import generate_custom_css


def _render_login_html(palette):
    """Login markup + sha256 shim; styles from login.css + optional theme override."""
    login_css = read_file(LOGIN_CSS_PATH)
    theme_css = generate_custom_css(palette)
    styles = '<style>\n' + login_css
    if theme_css:
        styles += '\n' + theme_css
    styles += '\n</style>'

    html = read_file(LOGIN_HTML_PATH)
    sha256_js = read_file(os.path.join(JS_DIR, 'sha256.js'))
    shim = f'<script>\n{sha256_js}\n</script>'
    return (
        html
        .replace('<!-- LOGIN_STYLES -->', styles)
        .replace('<!-- CRYPTO_SHIM -->', shim)
    )


def _strip_php_tags(code):
    code = re.sub(r'^<\?php\s*', '', code)
    return re.sub(r'\?>\s*$', '', code.strip())


def _php_nowdoc_echo(html: str) -> str:
    """Emit login HTML via nowdoc so auth.php stays pure PHP (no ?>…<?php)."""
    delim = '__SX_LOGIN__'
    while delim in html:
        delim = f'__SX_LOGIN_{os.urandom(4).hex()}__'
    return f"echo <<<'{delim}'\n{html}\n{delim};"


def build_auth_block(lang, password, palette=None):
    """Load ``auth.<ext>`` for *lang*, inject hash + login HTML."""
    auth_path = backend_auth_path(lang)
    if not os.path.exists(auth_path):
        print(f'[!] Auth template not found for --lang {lang}: {auth_path}')
        sys.exit(1)

    pw_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()
    login_html = _render_login_html(palette)
    block = _strip_php_tags(read_file(auth_path))
    return (
        block
        .replace('@@AUTH_HASH@@', pw_hash)
        .replace('/*@@LOGIN_ECHO@@*/', _php_nowdoc_echo(login_html))
    )
