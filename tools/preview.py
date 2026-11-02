#!/usr/bin/env python3
"""Composite a paper texture over a screenshot (or a test card).

Mirrors the shaders in extension.js: a multiply for shadows, then an OVER
for highlights.
"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# As in papergen.js.
TONE_SCALE = 8

LOREM = ("Paper is a thin sheet material produced by mechanically or chemically "
         "processing cellulose fibres derived from wood, rags, grasses or other "
         "vegetable sources in water, draining the water through fine mesh "
         "leaving the fibre evenly distributed on the surface, followed by "
         "pressing and drying.")


def test_card(w, h):
    img = Image.new("RGB", (w, h), (250, 250, 250))
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=17)
    big = ImageFont.load_default(size=34)

    d.text((60, 50), "Paper my Shell", font=big, fill=(25, 25, 25))
    words, line, y = LOREM.split(), "", 110
    for _ in range(3):
        for wd in words:
            if d.textlength(line + wd, font=font) > w / 2 - 120:
                d.text((60, y), line, font=font, fill=(40, 40, 40))
                line, y = "", y + 26
            line += wd + " "
        y += 14

    # Dark panel, mid grey, colour gradient.
    d.rectangle((w // 2, 0, w, h // 2), fill=(36, 36, 40))
    d.text((w // 2 + 40, 50), "Dark surface", font=big, fill=(230, 230, 230))
    d.rectangle((w // 2, h // 2, w * 3 // 4, h), fill=(128, 128, 128))
    grad = np.zeros((h - h // 2, w - w * 3 // 4, 3), np.uint8)
    t = np.linspace(0, 1, grad.shape[1])
    grad[..., 0] = (60 + 190 * t)
    grad[..., 1] = (120 + 60 * np.sin(t * 3))
    grad[..., 2] = (220 - 160 * t)
    img.paste(Image.fromarray(grad), (w * 3 // 4, h // 2))
    return img


def relief(path, w, h, scale=1):
    """Shadow and highlight amounts of a grey + alpha tile, tiled to w x h."""
    la = np.asarray(Image.open(path).convert("LA"), np.float32) / 255
    grey, alpha = la[..., 0], la[..., 1]
    maps = []
    for a in (alpha * (1 - grey), alpha * grey):
        img = Image.fromarray(a, "F")
        if scale != 1:
            img = img.resize((img.width * scale, img.height * scale), Image.BILINEAR)
        a = np.asarray(img)
        maps.append(np.tile(a, (h // a.shape[0] + 1, w // a.shape[1] + 1))[:h, :w])
    return maps


def composite(base, texdir, intensity, balance=0.4):
    b = np.asarray(base.convert("RGB"), np.float32) / 255
    h, w = b.shape[:2]
    ds, dl = relief(texdir / "detail.png", w, h)
    ts, tl = relief(texdir / "tone.png", w, h, TONE_SCALE)
    shadow = 1 - (1 - ds) * (1 - ts)
    light = 1 - (1 - dl) * (1 - tl)

    # Multiply pass: shadows.
    b = b * (1 - intensity * shadow)[..., None]

    # OVER pass: highlights.
    hl = (intensity * balance * light)[..., None]
    b = b * (1 - hl) + hl
    return Image.fromarray((np.clip(b, 0, 1) * 255 + 0.5).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("texture", type=Path, help="texture directory from extension/generate.js")
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("-b", "--base", type=Path, help="screenshot, default: test card")
    ap.add_argument("-i", "--intensity", type=float, default=0.25)
    ap.add_argument("-d", "--dark-balance", type=float, default=0.4)
    ap.add_argument("--size", default="1600x1000")
    args = ap.parse_args()

    if args.base:
        base = Image.open(args.base)
    else:
        base = test_card(*map(int, args.size.split("x")))
    composite(base, args.texture, args.intensity, args.dark_balance).save(args.output)


if __name__ == "__main__":
    main()
