# Parkinson Analysis

A dual-camera motion analysis tool for Parkinson's assessment. Records synchronized video from two Intel RealSense cameras, runs YOLOv8-Pose on each recording to extract skeletal keypoints, and outputs per-session JSON reports with motion and tremor metrics.

Designed to run on an NVIDIA Jetson for real-time edge inference, with a React dashboard for recording, tagging, and file management.

---

## Project Structure

| Path | Description |
|---|---|
| `api/` | FastAPI backend — camera control, recording, processing pipeline |
| `web/` | React/TypeScript frontend |
| `models/` | YOLOv8 model files (`.pt`, `.engine`) |
| `deploy/` | Jetson deployment scripts |
| `docs/` | Sphinx documentation |
| `requirements/` | Python dependency sets |

---

## Setup

### Backend

Requires Python 3.12+.

```sh
cd api
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r ../requirements/desktop.txt
uvicorn main:app --reload
```

### Frontend

```sh
cd web
npm install
npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173`).

---

## Camera Modes

Set via the `CAMERA_MODE` environment variable before starting the backend:

| Mode | Description |
|---|---|
| `auto` | Auto-detect connected RealSense cameras (default) |
| `mock_bag` | Replay `.bag` files — no hardware needed |
| `realsense` | Force live RealSense detection |

For `mock_bag`, also set `BAG_FILE_CAM1` and `BAG_FILE_CAM2` to point at your `.bag` files.

For remote/Jetson deployment, set `REMOTE_MODE=true` and `API_HOST=0.0.0.0`.

---

## Models

Processing uses `yolov8n-pose` (17 COCO keypoints). Place model files in `models/`.

- The pipeline prefers a TensorRT `.engine` file and falls back to `.pt` if not found
- Build the `.engine` on the target Jetson hardware — do not commit it, it's device-specific
- On first run without any model file, Ultralytics will attempt to download `yolov8n-pose.pt`

---

## Recording Output

Each session writes files named `<timestamp>_camera{1|2}.*` under `api/recordings/`:

| File | Description |
|---|---|
| `_camera1.bag` / `_camera2.bag` | RealSense depth + RGB, used for processing |
| `_camera1.mp4` / `_camera2.mp4` | RGB preview, used for tagging |
| `_camera1_metadata.json` | Patient info sidecar (name, ID, timestamp) |

Camera 1 = Front/Sagittale, Camera 2 = Side/Frontale.

If only one camera is connected, only that camera's files are written (orphan mode). The camera swap button on the recording page remaps which physical device is treated as camera 1.

---

## Documentation

```sh
cd docs
pip install -r requirements.txt
make html
```

Output goes to `docs/_build/html/`. Swagger UI is at `http://localhost:8000/docs` while the backend is running.

---

## Notes

- Do not commit `.engine` files or `venv/` directories
- Use sparse checkout on Jetson to avoid pulling `node_modules`
- If cameras are plugged in after the server starts, call `POST /cameras/refresh`
