import os
import sys
# Point to the api/ directory so Sphinx can import your modules
sys.path.insert(0, os.path.abspath('../api'))

project = 'Parkinson Analysis'

copyright = '2026, Parkinson Analysis Team'
author = 'Parkinson Analysis Team'

release = '1.0.0'

# Extensions for automatic API generation
extensions = [
    'sphinx.ext.autodoc',      # Generates docs from docstrings
    'sphinx.ext.napoleon',     # Supports Google/NumPy style docstrings
    'sphinx.ext.viewcode',     # Links to source code
    'sphinx.ext.githubpages',  # For easy deployment
    'myst_parser'              # Support for Markdown files
]

# Theme (using standard one, but 'sphinx_rtd_theme' is recommended if installed)
html_theme = 'alabaster' 

# Add any paths that contain custom static files (such as style sheets) here
html_static_path = []

exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store', 'venv']
