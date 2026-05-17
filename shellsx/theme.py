"""Color palette math + theme presets.

Everything descends from a single HSL hue via :func:`palette_from_hue`,
which is also what produces the "beautiful random" build aesthetic.
Named presets just pick a fixed hue so the build is reproducible; six
legacy hand-crafted palettes are kept for backward compatibility.
"""

import colorsys


# ---------------------------------------------------------------------------
# Hex / HSL / RGBA conversions
# ---------------------------------------------------------------------------

def hsl_to_hex(h, s, l):
    """HSL (h: 0-360, s: 0-100, l: 0-100) → #rrggbb."""
    r, g, b = colorsys.hls_to_rgb(h / 360.0, l / 100.0, s / 100.0)
    return '#{:02x}{:02x}{:02x}'.format(int(r * 255), int(g * 255), int(b * 255))


def hex_to_hsl(hex_color):
    """#rrggbb → (h: 0-360, s: 0-100, l: 0-100)."""
    hex_color = hex_color.lstrip('#')
    r, g, b = int(hex_color[0:2], 16) / 255.0, int(hex_color[2:4], 16) / 255.0, int(hex_color[4:6], 16) / 255.0
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return h * 360, s * 100, l * 100


def lighten_hex(hex_color, amount=15):
    """Lighten a hex color by increasing its HSL lightness."""
    h, s, l = hex_to_hsl(hex_color)
    return hsl_to_hex(h, s, min(100, l + amount))


def hex_to_rgba(hex_color, alpha=0.1):
    """#rrggbb → ``rgba(r,g,b,alpha)`` string."""
    hex_color = hex_color.lstrip('#')
    r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
    return f'rgba({r},{g},{b},{alpha})'


# ---------------------------------------------------------------------------
# Palette construction
# ---------------------------------------------------------------------------

def palette_from_hue(hue):
    """Derive a full harmonious palette from a single HSL hue.

    Carefully tuned saturation/lightness pairs keep backgrounds dark-but-
    tinted, text bright-but-soft, and the accent prominent. Same recipe
    used for both named presets and the random hue picker.
    """
    accent = hsl_to_hex(hue, 70, 65)
    return {
        '--bg':           hsl_to_hex(hue, 15, 7),
        '--panel':        hsl_to_hex(hue, 12, 10),
        '--border':       hsl_to_hex(hue, 10, 20),
        '--text':         hsl_to_hex(hue, 10, 82),
        '--muted':        hsl_to_hex(hue, 8, 55),
        '--accent':       accent,
        '--purple':       hsl_to_hex((hue + 60) % 360, 60, 72),
        '--accent-hover': lighten_hex(accent, 15),
        '--accent-10':    hex_to_rgba(accent, 0.1),
    }


def generate_random_palette(rng):
    """Pick a random hue (using the provided RNG) and build its palette."""
    return palette_from_hue(rng.randint(0, 359))


def generate_custom_css(palette):
    """Emit a ``:root{ ... }`` CSS block from a palette dict."""
    if not palette:
        return ''
    lines = [f'{k}:{v}' for k, v in palette.items()]
    return ':root{' + ';'.join(lines) + '}'


# ---------------------------------------------------------------------------
# Named presets — every entry built from the same recipe so they share the
# random builds' aesthetic DNA. The hue next to each name defines its
# character; legacy presets keep their hand-crafted values verbatim.
# ---------------------------------------------------------------------------

THEME_PRESETS = {
    # — Hue-derived (harmonious recipe). New, recommended set —
    'cyber':    palette_from_hue(180),   # terminal cyan
    'matrix':   palette_from_hue(130),   # Matrix-style green
    'amber':    palette_from_hue(35),    # vintage CRT amber
    'synth':    palette_from_hue(310),   # synthwave magenta
    'arctic':   palette_from_hue(200),   # icy operator blue
    'sodium':   palette_from_hue(50),    # sodium-lamp yellow
    'viridian': palette_from_hue(165),   # teal-green
    'rust':     palette_from_hue(15),    # warm rust-orange
    'ultra':    palette_from_hue(265),   # ultraviolet
    'plasma':   palette_from_hue(335),   # plasma pink

    # — Original hand-crafted presets, kept for backward compatibility —
    'ocean': {
        '--bg': '#0a1628', '--panel': '#0f1f35', '--border': '#1a3a5c',
        '--text': '#b8d4e8', '--muted': '#6a8fa8', '--accent': '#4fc3f7',
        '--purple': '#80cbc4', '--accent-hover': '#81d4fa', '--accent-10': 'rgba(79,195,247,.1)',
    },
    'crimson': {
        '--bg': '#1a0a0a', '--panel': '#241010', '--border': '#4a1c1c',
        '--text': '#e8c8c8', '--muted': '#a07070', '--accent': '#ff5252',
        '--purple': '#ff80ab', '--accent-hover': '#ff8a80', '--accent-10': 'rgba(255,82,82,.1)',
    },
    'forest': {
        '--bg': '#0a1a0a', '--panel': '#102410', '--border': '#1c4a1c',
        '--text': '#c8e8c8', '--muted': '#70a070', '--accent': '#69f0ae',
        '--purple': '#a5d6a7', '--accent-hover': '#b9f6ca', '--accent-10': 'rgba(105,240,174,.1)',
    },
    'purple': {
        '--bg': '#140a28', '--panel': '#1c1035', '--border': '#2e1a5c',
        '--text': '#d8c8e8', '--muted': '#8a70a8', '--accent': '#b388ff',
        '--purple': '#ea80fc', '--accent-hover': '#d1b3ff', '--accent-10': 'rgba(179,136,255,.1)',
    },
    'mono': {
        '--bg': '#111111', '--panel': '#1a1a1a', '--border': '#333333',
        '--text': '#cccccc', '--muted': '#777777', '--accent': '#ffffff',
        '--purple': '#aaaaaa', '--accent-hover': '#e0e0e0', '--accent-10': 'rgba(255,255,255,.1)',
    },
    'solar': {
        '--bg': '#002b36', '--panel': '#073642', '--border': '#586e75',
        '--text': '#93a1a1', '--muted': '#657b83', '--accent': '#268bd2',
        '--purple': '#6c71c4', '--accent-hover': '#5eaae3', '--accent-10': 'rgba(38,139,210,.1)',
    },
}
