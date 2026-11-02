UUID := paper-my-shell@coffeebowl
PYTHON := .venv/bin/python

.PHONY: pack install venv clean

pack: $(UUID).shell-extension.zip

$(UUID).shell-extension.zip: $(shell find extension -type f ! -name gschemas.compiled)
	gnome-extensions pack extension --force \
		--extra-source=papergen.js --extra-source=generate.js \
		--extra-source=textures.js --extra-source=icons

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip

venv: .venv/bin/python

.venv/bin/python:
	python3 -m venv .venv
	$(PYTHON) -m pip install -q numpy pillow

clean:
	rm -f *.shell-extension.zip extension/schemas/gschemas.compiled
