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
| `deploy/` | Deployment scripts (`pack_jetson_artifacts.sh`, `setup_jetson.sh`) |
| `requirements/` | Python dependency sets |
| `docs/` | Sphinx documentation |

---

## Deployment Strategies

Clone only what you need.

### Option A: Full Development (PC/Laptop)

```sh
git clone https://github.com/mehdiouassou/parkinson-analysis.git
```

Gets everything: `api/`, `web/`, `docs/`, `models/`, `deploy/`, `requirements/`.

### Option B: Jetson / API Server

Skips the `web/` folder. Run from wherever you want the project directory created.

```sh
mkdir parkinson-project && cd parkinson-project
git init
git remote add origin https://github.com/mehdiouassou/parkinson-analysis.git
git config core.sparseCheckout true
echo "api/" >> .git/info/sparse-checkout
echo "deploy/" >> .git/info/sparse-checkout
echo "models/" >> .git/info/sparse-checkout
echo "requirements/" >> .git/info/sparse-checkout
git pull origin main
```

### Option C: Frontend Server

```sh
mkdir parkinson-project && cd parkinson-project
git init
git remote add origin https://github.com/mehdiouassou/parkinson-analysis.git
git config core.sparseCheckout true
echo "web/" >> .git/info/sparse-checkout
git pull origin main
```

---

## Setup

### Desktop (PC/Laptop)

Requires Python 3.12+.

```sh
cd api
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r ../requirements/desktop.txt
uvicorn main:app --reload
```

### Jetson AGX Orin (JetPack 5)

For Jetson deployment, you **should** run `pip install -r requirements/jetson.txt` to ensure all dependencies are installed. The artifact contains dependencies, but running requirements is good practice and will not harm the repo.

#### Automated

Edit `ARTIFACT_URL` in `deploy/setup_jetson.sh` to point at the uploaded release, then run from the project root:

```sh
bash deploy/setup_jetson.sh
```

#### Manual

1. Clone the repo or use sparse checkout (Option B above).

2. Download `jetson_orin_py38_env.tar.gz` from GitHub Releases and place it in the project root.

3. Unpack (recreates `api/venv/`):
   ```sh
   tar -xzvf jetson_orin_py38_env.tar.gz
   ```

4. Generate the TensorRT engine (~10–15 min, do not interrupt):
   ```sh
   source api/venv/bin/activate
   yolo export model=models/yolov8n-pose.pt format=engine device=0 half=True workspace=4
   mv yolov8n-pose.engine models/
   rm -f yolov8n-pose.onnx
   ```

5. Run:
   ```sh
   python api/main.py
   ```

### Frontend

```sh
cd web
npm install
npm run dev
```

Open the URL printed by Vite (typically `http://localhost:5173`).

---

## Models

Processing uses `yolov8n-pose` (17 COCO keypoints). Place model files in `models/`.

- The pipeline prefers a TensorRT `.engine` file and falls back to `.pt` if not found
- `.engine` files are hardware-specific — do not commit them and do not copy them between devices
- On first run without any model file, Ultralytics will attempt to download `yolov8n-pose.pt`

### Updating the Golden Artifact

When Python dependencies change, rebuild the venv on the development Jetson, then run from the project root:

```sh
bash deploy/pack_jetson_artifacts.sh
```

Upload the resulting `jetson_orin_py38_env.tar.gz` to GitHub Releases.

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

## Recording Output

Each session writes files named `<timestamp>_camera{1|2}.*` under `api/recordings/`:

| File | Description |
|---|---|
| `_camera1.bag` / `_camera2.bag` | RealSense depth + RGB, used for processing |
| `_camera1.mp4` / `_camera2.mp4` | RGB preview, used for tagging |
| `_camera1_metadata.json` | Patient info sidecar (name, ID, timestamp) |

Camera 1 = Front/Frontale, Camera 2 = Side/Sagittale.

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
- Do not run `pip install` on Jetson — use the pre-built artifact
- If cameras are plugged in after the server starts, call `POST /cameras/refresh`

---

## Author

**Mehdi Ouassou**
Università degli Studi di Verona — Informatica L-31

---

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for the full text.

You are free to use, modify, and build upon this work for academic, research, or personal purposes. Attribution is required: any use or derivative work must credit **Mehdi Ouassou** as the original author.
