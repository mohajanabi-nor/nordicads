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

# --- slider reel (many SKUs in ONE reel, paged) ---
# A category reel shows at most 3 heroes at a readable size, so a drop with 12
# ice creams used to ship 3 of them. The slider keeps the same 3-up beat but
# SLIDES through page after page, so every SKU is shown. Timings are per page:
# the first page keeps the standard entrance (pop-in + gloss), the rest slide.
SLIDER_PER_PAGE = 3     # heroes per page (3 = the proven fan layout)
SLIDER_INTRO = 84       # frames page 1 holds (entrance + gloss + a beat) = 3.5s
SLIDER_HOLD = 42        # frames every later page holds = 1.75s
SLIDER_TRANS = 14       # frames of horizontal slide between pages ~0.6s
SLIDER_TAIL = 26        # extra frames on the last page so the CTA lands
# Hard cap on products per slider reel: 24 = 8 pages ≈ 21s. Beyond this a reel
# stops being an ad and nobody watches to the end; the caller reports the rest.
SLIDER_MAX_ITEMS = 24
SLIDER_DOTS_Y = 1526    # page-dot row, between the products and the CTA

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
