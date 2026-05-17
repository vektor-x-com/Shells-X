"""Basic CSS/JS minification.

Intentionally naive — strips comments and collapses whitespace. Not a
real parser, so it won't catch every edge case (e.g. JS regex literals
with ``//`` inside strings). Fine for the conservative shell payloads
we generate.
"""

import re


def minify_css(css):
    """Strip /* comments */ and collapse whitespace around CSS punctuation."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.DOTALL)
    css = re.sub(r'\s+', ' ', css)
    css = re.sub(r'\s*([{}:;,>+~])\s*', r'\1', css)
    css = re.sub(r';\s*}', '}', css)
    return css.strip()


def minify_js(js):
    """Drop full-line // comments and collapse blank lines.

    Preserves indentation-bearing strings only by virtue of stripping
    whole lines, not by parsing — don't rely on it for complex JS.
    """
    lines = []
    for line in js.split('\n'):
        stripped = line.strip()
        if stripped.startswith('//'):
            continue
        lines.append(stripped)
    result = '\n'.join(lines)
    return re.sub(r'\n{2,}', '\n', result).strip()
