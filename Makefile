PYTHON := .venv/bin/python

.PHONY: venv

venv: .venv/bin/python

.venv/bin/python:
	python3 -m venv .venv
	$(PYTHON) -m pip install -q numpy pillow
