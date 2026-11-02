UUID := paper-my-shell@coffeebowl
PYTHON := .venv/bin/python

.PHONY: pack install gamut venv clean

pack: $(UUID).shell-extension.zip

$(UUID).shell-extension.zip: $(shell find extension -type f ! -name gschemas.compiled)
	gnome-extensions pack extension --force \
		--extra-source=papergen.js --extra-source=generate.js \
		--extra-source=textures.js --extra-source=print-gamut.png --extra-source=icons

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip

gamut: venv
	@test -n "$(FOGRA)" || { echo "usage: make gamut FOGRA=path/to/FOGRA52.txt"; exit 1; }
	$(PYTHON) tools/printgamut.py $(FOGRA) -o extension/print-gamut.png

venv: .venv/bin/python

.venv/bin/python:
	python3 -m venv .venv
	$(PYTHON) -m pip install -q numpy pillow scipy

clean:
	rm -f *.shell-extension.zip extension/schemas/gschemas.compiled
