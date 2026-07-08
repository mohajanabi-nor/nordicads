"""Canvas, palette, type scale and animation constants for the social system.

Values lifted verbatim from the prototype scripts so output matches 1:1.
All `.no` web text from the prototypes is replaced with `.com` (final brand
decision). Brand domain: nordicengros.com.
"""
from __future__ import annotations

# --- canvas (9:16) ---
W, H = 1080, 1920
FPS = 24
N_FRAMES = 120          # standard reel: 5s
N_FRAMES_MONTAGE = 192  # montage reel: 8s

# --- palette (RGB) ---
CREAM = (247, 240, 222)       # background
ORANGE = (239, 120, 28)       # primary accent / CTA
PEACH = (247, 201, 158)       # outer circle
AMBER_DEEP = (224, 149, 31)   # frame stroke, prices
AMBER = (254, 189, 89)        # kampanje variant
YELLOW = (253, 234, 43)       # kampanje variant
INK = (45, 45, 52)            # headings / body
MUTE = (150, 140, 120)        # secondary text
WHITE = (255, 255, 255)

# --- shadow ---
SHADOW_RGBA = (60, 40, 25, 80)
SHADOW_BLUR = 18
SHADOW_W_COEF = 0.86
SHADOW_H_COEF = 0.14

# --- frame border ---
FRAME_MARGIN = 44
FRAME_STROKE = 5
FRAME_RADII = (70, 34, 70, 34)  # TL, TR, BR, BL

# --- copy / brand strings (.com) ---
CTA_PRIMARY = "BESTILL I NETTBUTIKKEN"
CTA_WEB = "nordicengros.com"
SUBLINE_DEFAULT = "Nye varer på lager hver uke"

# --- header geometry ---
LOGO_W = 120
LOGO_Y = 158
NORDIC_Y = 300
ENGROS_Y = 366
HEADING_Y = 478
UNDERLINE_Y = (564, 572)

# --- CTA geometry ---
CTA_Y = 1560
CTA_H = 120
CTA_RADIUS = 24
SUBLINE_Y = 1744
