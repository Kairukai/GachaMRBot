"""
Generates the rank 1-10 badge emojis.

OFFLINE TOOLING — not part of the bot. Nothing in src/ imports this, and Pillow
is deliberately NOT a project dependency: the output PNGs are committed and
uploaded to Discord once, so the runtime never needs an image library. The bot
runs at ~75 MB RSS on a free tier and hotlinks card art rather than processing
it; that stays true.

    python -m pip install Pillow
    python scripts/make-rank-badges.py

Writes assets/rank/rank-NN.png plus a contact sheet for eyeballing.

Design constraints, all driven by where these actually appear:
  * Discord renders an emoji at roughly 22px inline. Detail is wasted; only
    silhouette, colour and one glyph survive. Drawn at 4x and downsampled so
    the edges stay clean at that size.
  * They must read on BOTH the light and dark themes, so every badge carries a
    dark rim and a light inner bevel — never relying on the background.
  * Ten must be distinguishable at a glance, so colour moves in tiers of three
    and the numeral does the fine detail.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SUPERSAMPLE = 4
SIZE = 128
S = SIZE * SUPERSAMPLE

OUT = Path(__file__).resolve().parent.parent / "assets" / "rank"

# Bronze / silver / gold / apex. Tiers of three so the jump at 4, 7 and 10 is
# visible without reading the number.
TIERS = [
    (range(1, 4), (0xC1, 0x84, 0x53), (0x6B, 0x3F, 0x1E)),
    (range(4, 7), (0xDA, 0xE3, 0xEC), (0x77, 0x88, 0x9B)),
    (range(7, 10), (0xFF, 0xD3, 0x5C), (0xB0, 0x7A, 0x0A)),
    (range(10, 11), (0xFF, 0x5C, 0x8A), (0x6E, 0x12, 0x3C)),
]


def tier_colours(rank: int):
    for ranks, light, dark in TIERS:
        if rank in ranks:
            return light, dark
    raise ValueError(rank)


def hexagon(cx: float, cy: float, r: float):
    """Flat-top hexagon — a crest silhouette that stays readable when tiny."""
    import math

    return [
        (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
        for a in range(0, 360, 60)
    ]


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize((size, size), Image.NEAREST)


def load_font(px: int) -> ImageFont.FreeTypeFont:
    # Impact is heavily condensed, which is what makes a two-digit "10" legible
    # at emoji scale. Arial Bold is the fallback.
    for name in ("impact.ttf", "arialbd.ttf", "seguisb.ttf"):
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), px)
    return ImageFont.load_default()


def badge(rank: int) -> Image.Image:
    light, dark = tier_colours(rank)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = S / 2
    outer = S * 0.495

    # Dark rim first, so the badge has an edge against a light background.
    draw.polygon(hexagon(cx, cy, outer), fill=(0x14, 0x16, 0x1A, 255))

    # Gradient body, masked to the hexagon.
    body = hexagon(cx, cy, outer * 0.90)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(body, fill=255)
    img.paste(vertical_gradient(S, light, dark).convert("RGBA"), (0, 0), mask)

    # Inner bevel: a light top edge reads as raised metal and lifts the badge
    # off a dark background.
    draw.line(body[4:] + body[:1], fill=(255, 255, 255, 90), width=int(S * 0.018))

    # Numeral, centred optically rather than by bounding box.
    label = str(rank)
    font = load_font(int(S * (0.78 if rank < 10 else 0.60)))
    l, t, r, b = draw.textbbox((0, 0), label, font=font)
    tx = cx - (r + l) / 2
    ty = cy - (b + t) / 2

    # Dark halo so white type survives on the pale silver tier.
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx or dy:
                draw.text(
                    (tx + dx * S * 0.02, ty + dy * S * 0.02),
                    label,
                    font=font,
                    fill=(0x10, 0x12, 0x16, 220),
                )
    draw.text((tx, ty), label, font=font, fill=(255, 255, 255, 255))

    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    badges = []
    for rank in range(1, 11):
        img = badge(rank)
        path = OUT / f"rank-{rank:02d}.png"
        img.save(path, optimize=True)
        badges.append(img)
        print(f"{path.relative_to(OUT.parent.parent)}  {path.stat().st_size / 1024:.1f} KB")

    # Contact sheet at true inline size next to the full-size art, so the
    # 22px legibility claim can actually be checked rather than assumed.
    pad = 8
    sheet = Image.new("RGBA", (10 * (SIZE + pad) + pad, SIZE + 22 + 3 * pad), (0x2B, 0x2D, 0x31, 255))
    for i, img in enumerate(badges):
        sheet.paste(img, (pad + i * (SIZE + pad), pad), img)
        small = img.resize((22, 22), Image.LANCZOS)
        sheet.paste(small, (pad + i * (SIZE + pad) + (SIZE - 22) // 2, SIZE + 2 * pad), small)
    sheet.save(OUT / "_preview.png")
    print(f"contact sheet -> {(OUT / '_preview.png').relative_to(OUT.parent.parent)}")


if __name__ == "__main__":
    main()
