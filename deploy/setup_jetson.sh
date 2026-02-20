#!/bin/bash
# deploy/setup_jetson.sh
# Run from the PROJECT ROOT on a fresh Jetson AGX Orin (JetPack 5).
# Downloads the pre-compiled Python 3.8 environment and generates the TensorRT engine.
#
# Usage: bash deploy/setup_jetson.sh

set -e

# Edit this to point at the uploaded artifact in GitHub Releases.
ARTIFACT_URL="https://github.com/mehdiouassou/parkinson-analysis/releases/download/venv38/jetson_orin_py38_env.tar.gz"
ARTIFACT_NAME="jetson_orin_py38_env.tar.gz"

# --- 1. System dependencies ---
echo "Installing system dependencies..."
sudo apt-get update -q
sudo apt-get install -y \
    libssl-dev libusb-1.0-0-dev pkg-config libgtk-3-dev \
    libopenblas-base libopenmpi-dev libomp-dev \
    libjpeg-dev zlib1g-dev libavcodec-dev libavformat-dev libswscale-dev

# --- 2. Download artifact ---
if [ -f "$ARTIFACT_NAME" ]; then
    echo "Artifact found locally, skipping download."
else
    echo "Downloading environment tarball..."
    wget -O "$ARTIFACT_NAME" "$ARTIFACT_URL"
fi

# --- 3. Unpack (extracts as api/venv/) ---
echo "Unpacking environment..."
rm -rf api/venv
tar -xzvf "$ARTIFACT_NAME"

# --- 4. Generate TensorRT engine ---
# The engine is device-specific and was excluded from the tarball.
# This step takes ~10-15 minutes. Do not interrupt.
echo "Generating TensorRT engine (this takes ~10-15 minutes)..."

source api/venv/bin/activate

yolo export model=models/yolov8n-pose.pt format=engine device=0 half=True workspace=4 verbose=False

if [ -f "yolov8n-pose.engine" ]; then
    mv yolov8n-pose.engine models/
    rm -f yolov8n-pose.onnx
    echo "Engine moved to models/."
else
    echo "Warning: engine file not found at expected path. Check yolo export output above."
fi

echo ""
echo "Deployment complete."
echo "Run: source api/venv/bin/activate && python api/main.py"
