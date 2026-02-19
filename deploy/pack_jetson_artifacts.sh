#!/bin/bash
# Zips up your hard work. 
# EXCLUDES the __pycache__ and local .engine files (they are hardware locked)

echo "Packing Virtual Environment..."
tar -czvf jetson_agx_orin_py312_env.tar.gz \
    --exclude='__pycache__' \
    --exclude='*.engine' \
    venv/

echo "Done. Upload 'jetson_agx_orin_py312_env.tar.gz' to GitHub Releases."
