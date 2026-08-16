"""Basic CSS/JS minification.

Intentionally naive — strips comments and collapses whitespace. Not a
real parser, so it won't catch every edge case (e.g. JS regex literals
with ``//`` inside strings). Fine for the conservative shell payloads
we generate.

The JS block-comment stripper adds one hard constraint: frontend JS must
never contain the two-character sequences ``/*`` or ``*/`` inside string
or regex literals (a regex cannot tell them apart from real comments).
Build such output via concatenation — see history.js exportHistory():
``'/' + '* OUTPUT:'``.
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
    """Drop // line comments, /* */ block comments, and blank lines.

    Preserves indentation-bearing strings only by virtue of stripping
    whole lines, not by parsing — don't rely on it for complex JS. See the
    module docstring for the string-literal constraint this relies on.
    """
    lines = []
    for line in js.split('\n'):
        stripped = line.strip()
        if stripped.startswith('//'):
            continue
        lines.append(stripped)
    result = '\n'.join(lines)
    result = re.sub(r'/\*.*?\*/', '', result, flags=re.DOTALL)
    return re.sub(r'\n{2,}', '\n', result).strip()
