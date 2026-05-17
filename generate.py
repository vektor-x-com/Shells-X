#!/usr/bin/env python3
"""Shells-X generator — entry point.

The actual implementation lives in the ``shellsx/`` package; this file
exists so the documented invocation (``python3 generate.py ...``) keeps
working from the repo root. See ``shellsx/__init__.py`` for the module
map.
"""

from shellsx.cli import main

if __name__ == '__main__':
    main()
