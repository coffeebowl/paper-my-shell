# Paper my Shell

A GNOME Shell extension that lays a realistic paper texture over the whole
screen, so it reads more like print than like a glowing panel.

Everything is drawn by the compositor on top of the shell, so it covers
every app and the panel alike. Nothing animates: a still screen costs
nothing.

## Features

Each effect can be switched on and off on its own. The defaults come from
the settings schema and are shown in the preferences.

- **Paper texture**: a shaded relief of tooth, fibres and pulp formation,
  lit from the upper left. Shadows multiply the content and highlights
  lighten it, so nothing gets pulled towards grey and text keeps its
  contrast. Shadows show on light surfaces, highlights on dark ones; how
  strong it is on dark surfaces is adjustable.
- **Three papers**: recycled, drawing and watercolor.
- **Matte**: the contrast of print instead of a screen. Even the darkest
  ink reflects some light, so blacks lift and turn to charcoal at the
  maximum, as on uncoated paper. Whites drop and get a touch warmer, so
  mid grey and the overall brightness stay the same.
- **Print colours** (experimental): limits colours to what offset print on
  uncoated paper can reach. Blues, violets and bright greens get much
  calmer, reds and yellows stay strong, greys don't change.
- **Stays out of the way**: monitors showing a fullscreen window hide the
  overlay, so games and videos keep direct scanout (can be turned off).

## Requirements

GNOME Shell 50.

## Installation

From source:

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

The **Paper** toggle in Quick Settings turns everything on and off. Its
menu has the texture, its intensity and the matte amount. Everything else
is in the preferences (Extensions app, or **Settings** in that menu).

## How it works

The textures are generated on the device, the first time each one is
used: a few seconds in a separate `gjs` process, so the shell never
stalls. They are kept in `~/.cache/paper-my-shell@coffeebowl/` and look
the same on every device. A new version of the generator replaces them.

Each texture is two seamless tiles, uploaded once and tiled by the GPU
(about 5 MB of video memory):

- detail (1024²): relief, tiled 1:1. Only small random features, so the
  repetition can't be spotted.
- tone (512²): low-frequency tone variation, stretched 8× so it repeats
  only every 4096 px. Large features in the detail tile would make the
  1024 px grid obvious on big screens.

Texture and matte are two full-screen passes per monitor (multiply, then
OVER), each a single quad with a small shader. All settings are uniforms,
so changing them never rebuilds anything.

Print colours need the finished pixels, so the UI is rendered offscreen
and one shader does print colours and the paper in a single pass instead
of the overlay. Partial redraws would leave the offscreen copy incomplete,
so while it is on every frame repaints the whole screen.

## Development

- `extension/`: the extension as it is packed. `extension.js` has the
  shaders and the overlay, `prefs.js` the preferences, `papergen.js` the
  texture generator and its presets, `generate.js` runs it and writes
  PNGs.
- `extension/schemas/`: the settings, their defaults and ranges, and the
  list of textures.
- `tools/preview.py`: mirrors the shaders in numpy and composites a
  texture over a test card or a screenshot.
- `tools/printgamut.py`: builds the print gamut table.

The Python tools need numpy, Pillow and SciPy; `make venv` sets them up in
`.venv`.

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

`extension/print-gamut.png` is the print gamut for print colours,
generated from Fogra's characterisation data for uncoated paper
([FOGRA52.txt](https://registry.color.org/cmyk-registry/fogra52), not in
the repository):

```sh
make gamut FOGRA=path/to/FOGRA52.txt
```

## License

Paper my Shell is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version. See [LICENSE](LICENSE).
