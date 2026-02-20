# docs/

Sphinx documentation for the Parkinson Analysis project.

## Build

```sh
pip install -r requirements.txt
make html         # Linux/macOS
.\make.bat html   # Windows
```

Output goes to `_build/html/index.html`.

## Structure

- `backend/` — auto-generated API reference from Python docstrings (`sphinx.ext.autodoc`)
- `frontend/` — manually written reference for React pages, components, and utilities
- `conf.py` — Sphinx configuration (theme: furo)
- `index.rst` — documentation root
