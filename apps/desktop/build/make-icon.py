#!/usr/bin/env python3
"""Generate build/icon.png (1024x1024) — the Render app icon.

A deep-space rounded square with an aperture ring and a bold "R": pages are
rendered on demand, the ring is the lens the agent looks through. Pure Pillow,
no external assets beyond a system font. Re-run to regenerate deterministically:

    python3 build/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024
SS = 4  # supersample for clean edges
W = S * SS

# macOS-style: content inset from the canvas edge, rounded rect baked in.
MARGIN = int(W * 0.08)
RADIUS = int(W * 0.185)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- background: vertical indigo→violet gradient inside a rounded rect ---
top = (17, 19, 40)      # #111328 deep space
bottom = (76, 56, 172)  # #4C38AC violet
grad = Image.new("RGBA", (W, W))
gd = ImageDraw.Draw(grad)
for y in range(W):
    t = y / (W - 1)
    gd.line(
        [(0, y), (W, y)],
        fill=(
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t),
            255,
        ),
    )
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [MARGIN, MARGIN, W - MARGIN, W - MARGIN], radius=RADIUS, fill=255
)
img.paste(grad, (0, 0), mask)

# --- aperture ring: a luminous arc, brighter at the top-right ---
ring = Image.new("RGBA", (W, W), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
cx = cy = W // 2
r = int(W * 0.30)
width = int(W * 0.030)
rd.arc([cx - r, cy - r, cx + r, cy + r], start=300, end=210, fill=(140, 190, 255, 90), width=width)
rd.arc([cx - r, cy - r, cx + r, cy + r], start=310, end=80, fill=(170, 220, 255, 220), width=width)
ring = ring.filter(ImageFilter.GaussianBlur(SS * 1.5))
img.alpha_composite(ring)

# --- the "R" glyph ---
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(W * 0.42))
bbox = draw.textbbox((0, 0), "R", font=font)
gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
gx, gy = (W - gw) // 2 - bbox[0], (W - gh) // 2 - bbox[1]

glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(glow).text((gx, gy), "R", font=font, fill=(150, 200, 255, 160))
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(SS * 6)))
draw = ImageDraw.Draw(img)
draw.text((gx, gy), "R", font=font, fill=(245, 248, 255, 255))

img = img.resize((S, S), Image.LANCZOS)
out = Path(__file__).parent / "icon.png"
img.save(out)
print(f"wrote {out} ({S}x{S})")
