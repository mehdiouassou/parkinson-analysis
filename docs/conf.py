import os
import sys

sys.path.insert(0, os.path.abspath('../api'))

project = 'Parkinson Analysis'
copyright = '2026, Mehdi Ouassou'
author = 'Mehdi Ouassou'
release = '2.0.0'

extensions = [
    'sphinx.ext.autodoc',
    'sphinx.ext.napoleon',
    'sphinx.ext.viewcode',
    'myst_parser',
]

# Mock heavy native/ML dependencies so autodoc can import the API modules
# without requiring a full GPU/RealSense environment in the docs venv.
autodoc_mock_imports = [
    'cv2',
    'numpy',
    'fastapi',
    'pydantic',
    'pyrealsense2',
    'ultralytics',
    'imageio_ffmpeg',
]

html_theme = 'furo'

html_theme_options = {
    "sidebar_hide_name": False,
}

exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store', 'venv', 'README.md', 'frontend/README.md']
