#!/bin/bash
# deploy/pack_jetson_artifacts.sh
# Run from the PROJECT ROOT on the development Jetson.
# Packs api/venv/ into a tarball that can be deployed to new devices.
#
# Usage: bash deploy/pack_jetson_artifacts.sh

set -e

ARTIFACT_NAME="jetson_orin_py38_env.tar.gz"

echo "Packing Python 3.8 environment..."
echo "Excluding: __pycache__, *.pyc, *.engine, *.plan, *.onnx"

tar -czvf "$ARTIFACT_NAME" \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='*.engine' \
    --exclude='*.plan' \
    --exclude='*.onnx' \
    api/venv/

echo "Done. Artifact: $ARTIFACT_NAME"
echo "Upload to GitHub Releases before running setup_jetson.sh on a new device."
