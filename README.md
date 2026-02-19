# Parkinson Analysis

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/mehdiouassou/parkinson-analysis)
[![Smoke Tests](https://img.shields.io/badge/smoke%20tests-passing-brightgreen)](https://github.com/mehdiouassou/parkinson-analysis)
[![Code Coverage](https://img.shields.io/badge/coverage-93%25-brightgreen)](https://github.com/mehdiouassou/parkinson-analysis)

The Parkinson Analysis project is a computer vision tool for analyzing patient motion to provide valuable clinical insights.

This tool utilizes a dual-camera system to capture patient movements from two angles, then uses an AI model to interpret the data. It is a comprehensive solution, from recording to analysis.

## Project Structure

The project is a monorepo containing all necessary components.

*   **`api/`**: A Python backend using FastAPI that manages camera feeds, video processing, and the REST API.
*   **`web/`**: A frontend built with React and TypeScript, providing the user interface.
*   **`models/`**: Contains the AI models, including `yolov8n-pose.pt` for skeletal tracking.
*   **`deploy/`**: Includes scripts for deploying the system on a Jetson device.
*   **`docs/`**: Project documentation.
*   **`requirements/`**: Python dependency lists.

## Local Setup

Instructions for running the project on a local machine.

### Backend (API)

Requires Python 3.12 or higher.

```sh
cd api
python -m venv venv
# On Windows
venv\Scripts\activate
# On macOS/Linux
source venv/bin/activate
pip install -r ../requirements/desktop.txt
uvicorn main:app --reload
```

### Frontend (Web)

```sh
cd web
npm install
npm run dev
```

After starting both services, open your browser to the address provided by the frontend's development server to view the application.

## Models & TensorRT

The system uses the `yolov8n-pose` model for skeletal tracking to track patient movements and derive clinical metrics.

For optimal performance, especially on edge devices like the NVIDIA Jetson, the models are optimized with **TensorRT**, a high-performance deep learning inference optimizer. This project uses TensorRT directly for model optimization instead of ONNX.

To build the TensorRT engine from the `.pt` file, refer to the scripts and instructions in the `models/` directory.

## Edge Deployment

The project is designed for deployment on an NVIDIA Jetson device for real-time analysis in a clinical setting. The `deploy/` directory contains scripts to set up and package the artifacts for a Jetson device.

## Documentation

Comprehensive documentation for both the frontend and backend is available in the `docs/` directory. Building the documentation requires Sphinx.

### Frontend (Web)
```sh
cd web
npm install
npm run dev
```

## Documentation
- See `docs/` for backend and frontend documentation.
- See `models/README.md` for model management.
- See `deploy/` for deployment scripts and Jetson artifact strategy.

## Notes
- Do NOT commit hardware-specific .engine files or large venvs.
- Use sparse checkout for Jetson deployments to avoid downloading node_modules.
