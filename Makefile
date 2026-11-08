UUID := paper-my-shell@coffeebowl
PYTHON := .venv/bin/python

.PHONY: pack install gamut lut venv clean

pack: $(UUID).shell-extension.zip

$(UUID).shell-extension.zip: $(shell find extension -type f ! -name gschemas.compiled)
	gnome-extensions pack extension --force \
		--extra-source=overlay.js --extra-source=printEffect.js \
		--extra-source=shaders.js --extra-source=regions.js \
		--extra-source=textureCache.js --extra-source=quickSettings.js \
		--extra-source=papergen.js --extra-source=generate.js \
		--extra-source=textures.js --extra-source=print-lut.png --extra-source=icons

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip

gamut: venv
	@test -n "$(FOGRA)" || { echo "usage: make gamut FOGRA=path/to/FOGRA52.txt"; exit 1; }
	$(PYTHON) tools/printgamut.py $(FOGRA) -o tools/print-gamut.png
	$(MAKE) lut

lut: venv
	$(PYTHON) tools/printlut.py

venv: .venv/bin/python

.venv/bin/python:
	python3 -m venv .venv
	$(PYTHON) -m pip install -q numpy pillow scipy

clean:
	rm -f *.shell-extension.zip extension/schemas/gschemas.compiled
