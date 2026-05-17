"""Filesystem paths used everywhere in the generator.

Anchored to the repo root (one level above this file) so the generator
works regardless of the operator's current working directory.
"""

import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, 'src')
TPL_DIR = os.path.join(BASE_DIR, 'templates')
DIST_DIR = os.path.join(BASE_DIR, 'dist')

CONFIG_PATH = os.path.join(SRC_DIR, 'config', 'defaults.json')
BACKEND_DIR = lambda lang: os.path.join(SRC_DIR, 'backend', lang)
JS_DIR = os.path.join(SRC_DIR, 'frontend', 'js')
CSS_PATH = os.path.join(SRC_DIR, 'frontend', 'css', 'shell.css')
HTML_PATH = os.path.join(SRC_DIR, 'frontend', 'html', 'layout.html')
LOGIN_HTML_PATH = os.path.join(SRC_DIR, 'frontend', 'html', 'login.html')
