#!/usr/bin/env python3
"""Bake the print colours mapping into a 3D lookup table for the shader.

Evaluates preview.py's exact mapping (the gamut table from printgamut.py,
moved in OKLab) on a SIZE³ grid of sRGB colours and writes it as a PNG laid
out like Mutter's own 3D LUTs: red along x, green + blue × SIZE along y.
The shader reads it with two linear lookups and a mix between the blue
slices. Prints the accuracy against the exact mapping.
"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

import preview

SIZE = 65


def bake(size, gamut):
    g = np.linspace(0, 1, size, dtype=np.float32)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    grid = np.stack([r, gg, b], -1).reshape(size * size, size, 3)
    mapped = preview.print_colours(grid, gamut, 1.0)
    return (np.clip(mapped, 0, 1) * 255 + 0.5).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--output", type=Path, default=preview.LUT)
    ap.add_argument("--gamut", type=Path, default=preview.GAMUT)
    args = ap.parse_args()

    lut = bake(SIZE, args.gamut)
    Image.fromarray(lut, "RGB").save(args.output, optimize=True)

    rng = np.random.default_rng(1)
    c = rng.random((1, 200000, 3), dtype=np.float32)
    exact = preview.print_colours(c, args.gamut, 1.0)[0]
    looked_up = preview.lookup(lut.astype(np.float32) / 255, c)[0]
    err = np.abs(looked_up - exact).max(-1) * 255
    print(f"{args.output}: {SIZE}³, error against the exact mapping: mean {err.mean():.2f}, "
          f"99.9 % {np.percentile(err, 99.9):.2f}, max {err.max():.1f} levels")


if __name__ == "__main__":
    main()
