#!/bin/bash
# Foolproof Setup Script for a fresh Jetson

# 1. Download the code (API only)
# (Assumes you did the Sparse Checkout steps manually or included them here)

# 2. Download your "Golden" Venv
echo "Downloading pre-compiled environment..."
wget https://github.com/YOUR_USER/YOUR_REPO/releases/download/v1.0/jetson_agx_orin_py312_env.tar.gz

# 3. Unpack it
echo "Unpacking..."
tar -xzvf jetson_agx_orin_py312_env.tar.gz

# 4. Activate it
source venv/bin/activate

# 5. The GPU Magic (This MUST happen on the specific device)
echo "Generating TensorRT Engine for this specific device..."
cd api
# This assumes your processing.py logic handles the export, 
# or you run the export command explicitly here:
yolo export model=../models/yolov8n-pose.pt format=engine device=0

echo "Deployment Complete. Run 'python main.py' to start."
