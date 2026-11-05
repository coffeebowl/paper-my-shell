#!/usr/bin/env python3
"""Composite a paper texture over a screenshot (or a test card).

Mirrors the shaders in extension.js: ink spread and print colours, then a
multiply for shadows and paper light, then an OVER for highlights, ink
mottle and flare (in one blend on the GPU).
"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from printgamut import oklab_to_srgb, srgb_to_oklab

GAMUT = Path(__file__).resolve().parent.parent / "extension" / "print-gamut.png"

# As in papergen.js and extension.js.
TONE_SCALE = 8
PAPER_BLACK = 0.1
MID_GREY = 0.46
MOTTLE_STRETCH = 2
INK_SHARE = 0.3
INK_STRENGTH = 0.6
INK_FEATHER = 0.6
TINT_MIN_MATTE = 1 / (255 * 0.12)

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


def matte_lift(matte):
    """Black lift of the straight line closest to paper, as matteLift()."""
    black = PAPER_BLACK * matte
    d = np.linspace(0, 1, 65)
    paper = (black + (1 - black) * d ** 2.2) ** (1 / 2.2)
    lifts = np.linspace(0, paper[0], 1001)[:, None]
    error = np.abs(lifts + (1 - lifts) * d - paper).max(axis=1)
    return lifts[error.argmin(), 0]


def matte_level(lift):
    """Overall level that keeps mid grey, as matteLevel()."""
    return MID_GREY / (lift + (1 - lift) * MID_GREY)


def sample(table, x, y):
    """Bilinear lookup at texel coordinates, clamped like the GPU does."""
    x = np.clip(x, 0, table.shape[1] - 1)
    y = np.clip(y, 0, table.shape[0] - 1)
    x0 = np.minimum(x.astype(int), table.shape[1] - 2)
    y0 = np.minimum(y.astype(int), table.shape[0] - 2)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    top = table[y0, x0] * (1 - fx) + table[y0, x0 + 1] * fx
    bottom = table[y0 + 1, x0] * (1 - fx) + table[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bottom * fy


def print_colours(b, gamut, strength):
    """Move colours print can't reach into its gamut, as PRINT_SHADER."""
    table = np.asarray(Image.open(gamut).convert("RGB"), np.float32) / 255
    lab = srgb_to_oklab(b)
    chroma = np.hypot(lab[..., 1], lab[..., 2])
    hue = np.arctan2(lab[..., 2], lab[..., 1]) / (2 * np.pi) % 1
    column = hue * (table.shape[1] - 1)
    cusp = sample(table, column, np.zeros_like(column))[..., 1]
    p = np.stack([lab[..., 0] - cusp, chroma], -1)
    r = np.maximum(np.hypot(*np.moveaxis(p, -1, 0)), 1e-6)
    angle = np.arctan2(p[..., 1], p[..., 0])
    limit = sample(table, column, angle / np.pi * (table.shape[0] - 1))[..., 0]
    x = r / np.maximum(limit, 1e-4)
    knee = 1 - 0.2 * chroma / r
    y = (x - knee) / np.maximum(1 - knee, 1e-4)
    squeezed = np.where(x > knee, knee + (1 - knee) * y / np.sqrt(1 + y * y), x)
    p = p * (1 + strength * (squeezed / np.maximum(x, 1e-6) - 1))[..., None]
    hue_dir = lab[..., 1:] / np.maximum(chroma, 1e-6)[..., None]
    lab = np.concatenate([(cusp + p[..., 0])[..., None], hue_dir * p[..., 1:]], -1)
    return np.clip(oklab_to_srgb(lab), 0, 1)


def ink_spread(b, soak, amount):
    """Strokes grow where the paper takes ink, and along fibres, as PRINT_SHADER."""
    h, w = b.shape[:2]
    y, x = np.mgrid[0:h, 0:w]

    def at(dy, dx):
        # Clamped to the image like the shader clamps to the monitor.
        return b[np.clip(y + dy, 0, h - 1), np.clip(x + dx, 0, w - 1)]

    near = np.minimum.reduce([at(1, 0), at(-1, 0), at(0, 1), at(0, -1)])
    take = (soak[..., 2] >= 1 - INK_SHARE * amount)[..., None]
    spread = b + (near - b) * take * INK_STRENGTH * amount
    along = soak[..., :2] * 2 - 1
    fibre = (np.hypot(along[..., 0], along[..., 1]) >= 0.5)[..., None]
    angle = 0.5 * np.arctan2(along[..., 1], along[..., 0])
    for distance in (1, 2):
        dx = np.floor(distance * np.cos(angle) + 0.5).astype(int)
        dy = np.floor(distance * np.sin(angle) + 0.5).astype(int)
        far = np.minimum(at(dy, dx), at(-dy, -dx))
        weight = fibre * INK_FEATHER * amount / distance**2
        spread = np.minimum(spread, b + (far - b) * weight)
    return np.minimum(b, spread)


def tiled(path, w, h):
    t = np.asarray(Image.open(path).convert("RGB"), np.float32) / 255
    return np.tile(t, (h // t.shape[0] + 1, w // t.shape[1] + 1, 1))[:h, :w]


def composite(base, texdir, intensity, balance=0.4, matte=0.0, brightness=1.0,
              print_colors=0.0, grain=0.0, mottle=0.0, ink=0.0):
    b = np.asarray(base.convert("RGB"), np.float32) / 255
    h, w = b.shape[:2]
    gs, gl = relief(texdir / "grain.png", w, h)

    if ink > 0:
        b = ink_spread(b, tiled(texdir / "ink.png", w, h), ink)
    if print_colors > 0:
        b = print_colours(b, GAMUT, print_colors)
    ds, dl = relief(texdir / "detail.png", w, h)
    ts, tl = relief(texdir / "tone.png", w, h, TONE_SCALE)
    shadow = 1 - (1 - ds) * (1 - ts) * (1 - grain * gs)
    light = 1 - (1 - dl) * (1 - tl) * (1 - grain * gl)
    ms, ml = relief(texdir / "tone.png", w, h, MOTTLE_STRETCH)
    cloud = (mottle * (0.5 + 0.5 * (ml - ms)))[..., None]

    flare = matte_lift(matte)
    brightness = brightness * matte_level(flare)

    # Multiply: paper light and shadows. The overlay leaves out a tint too
    # faint to see, the print effect always has it.
    paper = brightness * np.ones(3)
    if matte >= TINT_MIN_MATTE or print_colors > 0 or ink > 0:
        paper *= np.array([1, 1 - 0.04 * matte, 1 - 0.12 * matte])
    b = b * paper * (1 - intensity * shadow)[..., None]

    # OVER: highlights over ink mottle over the light paper reflects
    # from black.
    hl = (intensity * balance * light)[..., None]
    color = np.array([1, 0.97, 0.92]) * flare
    c = hl + (cloud + color * (1 - cloud)) * (1 - hl)
    a = hl + (cloud + flare * (1 - cloud)) * (1 - hl)
    b = b * (1 - a) + c * brightness
    return Image.fromarray((np.clip(b, 0, 1) * 255 + 0.5).astype(np.uint8))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("texture", type=Path, help="texture directory from extension/generate.js")
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("-b", "--base", type=Path, help="screenshot, default: test card")
    ap.add_argument("-i", "--intensity", type=float, default=0.25)
    ap.add_argument("-d", "--dark-balance", type=float, default=0.4)
    ap.add_argument("-m", "--matte", type=float, default=0.0)
    ap.add_argument("--brightness", type=float, default=1.0)
    ap.add_argument("-p", "--print-colors", type=float, default=0.0)
    ap.add_argument("-g", "--grain", type=float, default=0.0)
    ap.add_argument("--mottle", type=float, default=0.0)
    ap.add_argument("--ink", type=float, default=0.0)
    ap.add_argument("--size", default="1600x1000")
    args = ap.parse_args()

    if args.base:
        base = Image.open(args.base)
    else:
        base = test_card(*map(int, args.size.split("x")))
    composite(base, args.texture, args.intensity, args.dark_balance,
              args.matte, args.brightness, args.print_colors, args.grain,
              args.mottle, args.ink).save(args.output)


if __name__ == "__main__":
    main()
