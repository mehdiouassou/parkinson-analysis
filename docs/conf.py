import os
import sys

sys.path.insert(0, os.path.abspath('../api'))

project = 'Parkinson Analysis'
copyright = '2026, Mehdi Ouassou'
author = 'Mehdi Ouassou'
release = '1.0.0'

extensions = [
    'sphinx.ext.autodoc',
    'sphinx.ext.napoleon',
    'sphinx.ext.viewcode',
    'myst_parser',
]

html_theme = 'furo'

html_theme_options = {
    "sidebar_hide_name": False,
}

exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store', 'venv', 'README.md', 'frontend/README.md']
