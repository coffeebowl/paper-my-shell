#!/usr/bin/env python3
"""Generate the print gamut table for the print colours effect.

Reads ICC/Fogra characterisation data (CGATS text with CMYK and Lab
columns), e.g. FOGRA52.txt for offset print on uncoated paper from
https://registry.color.org/cmyk-registry/fogra52, and writes the print
gamut in OKLab as a small RGB PNG.

The data is mapped media-relative with black point compensation: paper
white becomes screen white and the deepest black screen black, so the
table only describes how colourful print is. Lifting black is the matte
setting's job.

Colours outside the gamut are moved towards the grey of the same hue's
most colourful print colour (its cusp), so light yellows and greens get a
little darker instead of washing out. The table is laid out for that, in
polar coordinates around the cusp grey:

- columns: hues 0..360° in HUE_STEP steps, both ends included, so the
  GPU can interpolate without wrapping,
- rows: angles 0..180° from the grey axis towards white, in ANGLE_STEPS,
- red: distance from the cusp grey to the gamut boundary,
- green: lightness of the cusp grey, the same in every row.
"""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

HUE_STEP = 5
ANGLE_STEPS = 33

D50 = np.array([0.9642, 1.0, 0.8249])
D65 = np.array([0.95047, 1.0, 1.08883])
BRADFORD = np.array([[0.8951, 0.2664, -0.1614],
                     [-0.7502, 1.7135, 0.0367],
                     [0.0389, -0.0685, 1.0296]])
XYZ_TO_LMS = np.array([[0.8189330101, 0.3618667424, -0.1288597137],
                       [0.0329845436, 0.9293118715, 0.0361456387],
                       [0.0482003018, 0.2643662691, 0.6338517070]])
RGB_TO_LMS = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                       [0.2119034982, 0.6806995451, 0.1073969566],
                       [0.0883024619, 0.2817188376, 0.6299787005]])
LMS_TO_LAB = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                       [1.9779984951, -2.4285922050, 0.4505937099],
                       [0.0259040371, 0.7827717662, -0.8086757660]])


def srgb_to_oklab(c):
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.cbrt(lin @ RGB_TO_LMS.T) @ LMS_TO_LAB.T


def oklab_to_srgb(lab):
    lms = (lab @ np.linalg.inv(LMS_TO_LAB).T) ** 3
    lin = lms @ np.linalg.inv(RGB_TO_LMS).T
    return np.where(lin <= 0.0031308, 12.92 * lin,
                    1.055 * np.abs(lin) ** (1 / 2.4) * np.sign(lin) - 0.055)


def read_cgats(path):
    """CMYK and Lab columns of a CGATS file."""
    lines = Path(path).read_text().splitlines()
    fields = lines[lines.index("BEGIN_DATA_FORMAT") + 1].split()
    begin, end = lines.index("BEGIN_DATA"), lines.index("END_DATA")
    rows = np.array([[float(v) for v in ln.split()] for ln in lines[begin + 1:end]])
    col = {name: i for i, name in enumerate(fields)}
    cmyk = rows[:, [col[f"CMYK_{c}"] for c in "CMYK"]]
    lab = rows[:, [col[f"LAB_{c}"] for c in "LAB"]]
    return cmyk, lab


def lab_to_xyz(lab):
    L, a, b = lab.T
    fy = (L + 16) / 116
    f = lambda t: np.where(t > 6 / 29, t ** 3, 3 * (6 / 29) ** 2 * (t - 4 / 29))
    return np.stack([f(fy + a / 500), f(fy), f(fy - b / 200)], -1) * D50


def adapt(xyz, src, dst):
    """Bradford chromatic adaptation from white src to white dst."""
    s, d = BRADFORD @ src, BRADFORD @ dst
    return xyz @ (np.linalg.inv(BRADFORD) @ np.diag(d / s) @ BRADFORD).T


def print_oklab(cmyk, lab):
    """Patches in OKLab, media-relative with black point compensation."""
    xyz = lab_to_xyz(lab)
    white = xyz[(cmyk == 0).all(1)][0]
    xyz = adapt(xyz, white, D65)
    black = xyz[xyz[:, 1].argmin()]
    xyz = (xyz - black) / (D65 - black) * D65
    return np.cbrt(xyz @ XYZ_TO_LMS.T) @ LMS_TO_LAB.T


def boundary(hull, origin, direction):
    """Distance along rays from origin to the surface of a convex hull."""
    normal, offset = hull.equations[:, :3], hull.equations[:, 3]
    towards = direction @ normal.T
    start = origin @ normal.T + offset
    hit = towards > 1e-9
    t = np.where(hit, -start / np.where(hit, towards, 1), np.inf)
    return np.clip(t.min(axis=-1), 0, None)


def gamut_table(points):
    """Cusp grey lightness per hue and boundary distance per hue and angle."""
    from scipy.spatial import ConvexHull

    hull = ConvexHull(points)
    hues = np.radians(np.arange(0, 360 + HUE_STEP, HUE_STEP))
    lightness = np.linspace(0, 1, 401)
    sideways = np.stack([np.zeros_like(hues), np.cos(hues), np.sin(hues)], -1)
    axis = np.stack([lightness, np.zeros_like(lightness), np.zeros_like(lightness)], -1)
    chroma = boundary(hull, axis[:, None], sideways[None])
    cusp = lightness[chroma.argmax(axis=0)]

    angles = np.linspace(0, np.pi, ANGLE_STEPS)[:, None]
    direction = np.cos(angles)[..., None] * np.array([1, 0, 0]) + \
        np.sin(angles)[..., None] * sideways[None]
    origin = np.stack([cusp, np.zeros_like(cusp), np.zeros_like(cusp)], -1)[None]
    distance = boundary(hull, np.broadcast_to(origin, direction.shape), direction)
    return cusp, distance


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("data", type=Path, help="characterisation data, e.g. FOGRA52.txt")
    ap.add_argument("-o", "--output", type=Path, required=True)
    args = ap.parse_args()

    cusp, distance = gamut_table(print_oklab(*read_cgats(args.data)))
    rgb = np.stack([distance, np.broadcast_to(cusp, distance.shape),
                    np.zeros_like(distance)], -1)
    Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(
        args.output, optimize=True)


if __name__ == "__main__":
    main()
