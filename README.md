# Paper my Shell

A GNOME Shell extension that lays a realistic paper texture over the whole
screen, so it reads more like print than like a glowing panel.

Everything is drawn by the compositor on top of the shell, so it covers
every app, the panel and the lock screen alike. Nothing animates: a still
screen costs nothing.

## Features

Each effect can be switched on and off on its own. The defaults come from
the settings schema and are shown in the preferences. Most effects are
subtle on purpose and change dark and light areas by only a few levels;
screens with low contrast, or with blacks or whites cut off by their
settings, may need higher values.

- **Paper texture**: a shaded relief of tooth, fibres and pulp formation,
  lit from the upper left. Shadows multiply the content and highlights
  lighten it, so nothing gets pulled towards grey and text keeps its
  contrast. Shadows show on light surfaces, highlights on dark ones; how
  strong it is on dark surfaces is adjustable. A pixel-fine grain layer on
  top keeps the rounded tooth from looking like leather.
- **Seven papers**: recycled, drawing, watercolor, washi, laid paper,
  cardboard and canvas.
- **True size**: the grain keeps its size in millimetres on every monitor,
  from the size the monitor reports.
- **Ink mottle**: lightens dark areas in soft patches, where ink soaked in
  unevenly.
- **Brightness**: dims the whole screen.
- **Matte**: the blacks of print instead of a screen. Even the darkest ink
  reflects some light, so shadows lift and turn to charcoal at the
  maximum, as on uncoated paper, while midtones and white stay. White
  gets a touch warmer.
- **Print colours**: limits colours to what offset print on uncoated
  paper can reach. Blues, violets and bright greens get much calmer, reds
  and yellows stay strong, greys don't change.
- **Ink spread** (more GPU time on big changes): dark strokes grow a
  little where the paper takes ink, with ragged edges, and creep along
  fibres in short feathers, like ink on absorbent paper. On some OLED
  panels whose subpixels aren't laid out in plain RGB stripes the ragged
  edges can look worse; it looks best at a display scale of 125 % or
  more.
- **Light scattering** (more GPU time on big changes): light that enters
  the paper next to ink scatters under it, so dark strokes get a faint
  soft halo and light gaps between them get a little darker. Sized in
  millimetres from the scattering length of uncoated paper.
- **Stays out of the way**: monitors showing a fullscreen window hide the
  overlay, so games and videos keep direct scanout (can be turned off).
  The texture starts at a random position at every login and unlock, so
  on OLED screens its light and dark spots don't wear in one place.

## Requirements

GNOME Shell 51.

## Installation

From a release: download `paper-my-shell@coffeebowl.shell-extension.zip`
from the [latest release](https://github.com/coffeebowl/paper-my-shell/releases/latest)
and install it:

```sh
gnome-extensions install --force paper-my-shell@coffeebowl.shell-extension.zip
```

Or from source:

```sh
git clone https://github.com/coffeebowl/paper-my-shell.git
cd paper-my-shell
make install
```

Then log out and back in (on Wayland the shell can't reload extensions)
and enable it:

```sh
gnome-extensions enable paper-my-shell@coffeebowl
```

To remove it again, uninstall it and delete its texture cache:

```sh
gnome-extensions uninstall paper-my-shell@coffeebowl
rm -r ~/.cache/paper-my-shell@coffeebowl
```

## Usage

The **Paper** toggle in Quick Settings turns everything on and off and
shows the selected paper. Everything else is in the preferences
(Extensions app, or **Settings** in the toggle's menu).

## How it works

The textures are generated on the device, the first time each one is
used: a few seconds in a separate `gjs` process, so the shell never
stalls. They are kept in `~/.cache/paper-my-shell@coffeebowl/` and look
the same on every device. A new version of the generator replaces them.

Each texture is four seamless tiles, uploaded once and tiled by the GPU
(about 5.5 MB of video memory):

- detail (1024²): relief, tiled 1:1. Only small random features, so the
  repetition can't be spotted.
- tone (512²): low-frequency tone variation, stretched 8× so it repeats
  only every 4096 px. Large features in the detail tile would make the
  1024 px grid obvious on big screens. Sampled again at 2×, it also gives
  the ink mottle, which follows the paper's formation.
- grain (256²): pixel-fine fibres and grain, tiled 1:1 with its own
  strength.
- ink (256²): fibre directions and where the paper takes ink, for ink
  spread.

Laid paper and canvas are regular patterns with a period of whole pixels.
Scaled by a fraction they would shimmer, so true size is off for them.

Texture, mottle and brightness are one full-screen pass per monitor, a
single quad with a small shader whose blend does the multiply and the OVER
at once. All settings are uniforms, so changing them never rebuilds
anything.

The matte look, print colours, ink spread and light scattering need the
finished pixels, so the UI is rendered offscreen and one shader does them
and the paper in a single pass instead of the overlay. Each monitor keeps
its offscreen copy between frames, and a frame only repaints the part of
it that changed, so a small change costs about as much as without the
extension. Ink spread and light scattering read neighbouring pixels, so
they repaint a pixel wide ring around each change one frame later; at
fractional scales, where Mutter's rounding to device pixels can't be
followed exactly, they also repaint the changed area once more when the
screen has been still for a moment. Monitors showing a fullscreen window
(with "hide in fullscreen") or HDR are left out and keep the overlay where
it applies.

## Development

- `extension/`: the extension as it is packed. `extension.js` has the
  shaders and the overlay, `prefs.js` the preferences, `papergen.js` the
  texture generator and its presets, `generate.js` runs it and writes
  PNGs.
- `extension/schemas/`: the settings, their defaults and ranges, and the
  list of textures.
- `tools/preview.py`: mirrors the shaders in numpy and composites a
  texture over a test card or a screenshot.
- `tools/printgamut.py`: builds the print gamut table, `tools/printlut.py`
  bakes print colours into the shader's lookup table.
- `tools/headless/`: runs the extension in an isolated headless GNOME
  Shell.

The Python tools need numpy, Pillow and SciPy; `make venv` sets them up in
`.venv`.

### Testing

`tools/headless/run.sh` starts the extension in an isolated headless GNOME
Shell (own settings and cache, real GPU) next to a helper extension that
takes screenshots, checks partial redraws or measures frame costs:

```sh
tools/headless/run.sh check /tmp/out                     # screenshots
BG='#c04040' tools/headless/run.sh check /tmp/out 1600x1000,1280x800 print-colors-enabled=true
PAPER_SCALE=1.25 tools/headless/run.sh verify /tmp/out 2000x1250 ink-spread-enabled=true
TIMEOUT=400 tools/headless/run.sh perf /tmp/out 3840x2160
```

`verify` moves a square over a test card in small steps, then saves what
the monitor shows (`partial.png`) and the same after a full repaint
(`full.png`). The two have to be equal. Screenshots can't show this, they
render a fresh offscreen copy.

### Textures

A texture is a preset in `papergen.js` and a choice of the `texture` key
in the schema, in the order shown. To look at one without the shell:

```sh
gjs -m extension/generate.js watercolor /tmp/w
.venv/bin/python tools/preview.py /tmp/w -i 0.15 -o /tmp/preview.png
```

`preview.py` matches the compositor to within 1–2 levels.

See [docs/texture-research.md](docs/texture-research.md) for how to make
believable textures and ideas for more materials.

### Print gamut

`tools/print-gamut.png` is the print gamut for print colours, generated
from Fogra's characterisation data for uncoated paper
([FOGRA52.txt](https://registry.color.org/cmyk-registry/fogra52), not in
the repository). The shader doesn't read it: `extension/print-lut.png` is
the whole mapping baked into a 65³ lookup table, made from the gamut by
the same code `preview.py` uses:

```sh
make gamut FOGRA=path/to/FOGRA52.txt   # gamut, then the lookup table
make lut                               # only the lookup table
```

## License

Paper my Shell is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version. See [LICENSE](LICENSE).
