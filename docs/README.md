# docs/

Sphinx documentation for the Parkinson Analysis project. Covers the full architecture: recording pipeline, multi camera sync, conversion, processing, streaming and the frontend.

## Build

```sh
pip install -r requirements.txt
sphinx-build -b html . _build/html
```

Output goes to `_build/html/index.html`.

## Structure

- `index.rst` — root page with architecture overview, sync explanation and limitations
- `backend/` — per module docs with how it works sections + autodoc API reference
- `frontend/` — manually written docs for React pages, components and utilities
- `conf.py` — Sphinx config (furo theme, autodoc with mocked heavy deps)
