"""Module registry, file I/O helpers, and --exclude module-stripping logic."""

import json
import os
import re

from .paths import BACKEND_DIR, CONFIG_PATH

# Language → source/output extension (backend files and dist filename).
SCRIPT_EXTENSIONS = {'php': '.php', 'aspx': '.aspx', 'jsp': '.jsp', 'py': '.py'}

# Module → file mapping for --exclude. The tunnel module's PHP is not listed
# because it's injected from an external path via --tunnel, not from
# src/backend/php/.
MODULE_BACKEND = {
    'scanner':     ['scanner.php'],
    'files':       ['filebrowser.php', 'fileops.php'],
    'diagnostics': ['diagnostics.php'],
    'console':     ['eval.php', 'snippets.php'],
}

MODULE_JS = {
    'tunnel':      ['tunnel.js'],
    'scanner':     ['scanner.js'],
    'files':       ['filebrowser.js'],
    'diagnostics': ['diagnostics.js'],
    'history':     ['history.js'],
    'console':     ['terminal_php.js'],   # PHP-specific adapter; engine stays
    'shell':       ['terminal_shell.js'], # OS Shell adapter; engine stays
    'faraday':     ['faraday.js'],
    # terminal_engine.js is intentionally absent — always loaded so either
    # adapter (console/shell, or future python/etc.) can call Terminal.bind().
}


def load_config():
    """Load src/config/defaults.json — the module registry (which modules
    are required vs optional)."""
    with open(CONFIG_PATH, 'r') as f:
        return json.load(f)


def read_file(path):
    with open(path, 'r') as f:
        return f.read()


def backend_auth_path(lang):
    """Path to the language-specific auth gate source (e.g. ``auth.php``)."""
    ext = SCRIPT_EXTENSIONS.get(lang, f'.{lang}')
    return os.path.join(BACKEND_DIR(lang), f'auth{ext}')


def load_ordered_filepaths(directory, extension, order_file='_order.json'):
    """Return file paths in the order specified by _order.json, or
    alphabetical (excluding underscore-prefixed files) as fallback."""
    order_path = os.path.join(directory, order_file)
    if os.path.exists(order_path):
        with open(order_path, 'r') as f:
            order = json.load(f)
        return [os.path.join(directory, name + extension) for name in order]
    
    else:
        exit("order file is missing, or at wrong directory")
    
    return [os.path.join(directory, f) for f in files]


def get_excluded_filepaths(exclude_modules):
    """Map a set of module names to the concrete backend + JS files to
    skip during assembly. Unknown modules quietly contribute nothing —
    the CLI layer is responsible for rejecting --exclude on required
    modules (see :func:`shellsx.cli.parse_excludes`)."""
    excluded_backend = set()
    excluded_js = set()
    for mod in exclude_modules:
        for f in MODULE_BACKEND.get(mod, []):
            excluded_backend.add(f)
        for f in MODULE_JS.get(mod, []):
            excluded_js.add(f)
    return excluded_backend, excluded_js


def strip_module_blocks(html, exclude_modules):
    """Remove ``<!-- MODULE:name -->...<!-- /MODULE:name -->`` blocks for
    excluded modules. Surviving module markers (for included modules) are
    stripped at the end so the rendered HTML has no leftover comments."""
    for mod in exclude_modules:
        pattern = r'<!-- MODULE:' + re.escape(mod) + r' -->.*?<!-- /MODULE:' + re.escape(mod) + r' -->'
        html = re.sub(pattern, '', html, flags=re.DOTALL)
    html = re.sub(r'<!-- /?MODULE:\w+ -->\n?', '', html)
    return html
