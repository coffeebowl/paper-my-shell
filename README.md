# Paper my Shell

A GNOME Shell extension that lays a realistic paper texture over the whole
screen, so it reads more like print than like a glowing panel.

## Textures

The textures are generated from a seed, so they come out the same on every
device: recycled, drawing and watercolor paper. Each is two seamless tiles:

- detail (1024²): relief, tiled 1:1. Only small random features, so the
  repetition can't be spotted.
- tone (512²): low-frequency tone variation, stretched 8× so it repeats
  only every 4096 px. Large features in the detail tile would make the
  1024 px grid obvious on big screens.

`extension/papergen.js` has the generator and its presets,
`extension/generate.js` writes a texture as PNGs. `tools/preview.py`
composites one over a test card or a screenshot; it needs numpy and
Pillow, `make venv` sets them up in `.venv`:

```sh
gjs -m extension/generate.js watercolor /tmp/w
.venv/bin/python tools/preview.py /tmp/w -i 0.15 -o /tmp/preview.png
```

## License

Paper my Shell is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version. See [LICENSE](LICENSE).
