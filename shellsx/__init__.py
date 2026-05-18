"""Shells-X — modular single-file web shell generator.

The package is split by concern so each module fits on a screen:

    paths        — filesystem paths (single source of truth)
    config       — module registry, file I/O, exclusion logic
    theme        — palette math, named presets, custom CSS emit
    auth         — login HTML + per-language auth gate assembly
    minify       — basic CSS/JS minifier
    fingerprint  — build hash + integrity verification
    builder      — orchestration: source → assembled shell
    cli          — argparse + entry point

Run via the project-root ``generate.py`` wrapper or
``python -m shellsx``.
"""

__version__ = "1.4.0"
