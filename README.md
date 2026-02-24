# Parkinson Analysis

Dual camera motion analysis tool for Parkinson's assessment. Records synchronized video from two Intel RealSense D455 cameras, converts the recordings to mp4, and runs YOLOv8-Pose on each to extract skeletal keypoints. Outputs per session JSON reports with motion and tremor metrics.

Built to run on an NVIDIA Jetson AGX Orin at the edge with a React dashboard for recording, tagging, conversion and file management.

## How it works (the short version)

Two RealSense cameras record `.bag` files (lossless depth + RGB) simultaneously. After recording you convert those bags to `.mp4` using hardware accelerated encoding (NVENC on Jetson, CPU fallback on desktop). Then you can tag the mp4s frame by frame and/or run YOLOv8 pose analysis on them.

The whole thing is a FastAPI backend that talks to a React frontend over REST. The backend handles camera control, bag recording, conversion, processing and file serving. The frontend handles the UI for all of that.

## Project Structure

| Path | What it is |
|---|---|
| `api/` | FastAPI backend, camera control, recording, conversion, processing |
| `web/` | React + TypeScript frontend |
| `models/` | YOLOv8 model files (`.pt`, `.engine`) |
| `deploy/` | Jetson deployment scripts |
| `requirements/` | Python dependency sets (desktop vs jetson) |
| `docs/` | Sphinx documentation |

## Architecture

### Recording Pipeline

```
User clicks Record
    -> 3s warmup (auto exposure stabilization)
    -> both cameras start BAG recording in parallel threads
    -> RealSense SDK handles frame capture to .bag (zero drop, SDK managed)
    -> MJPEG preview stream continues at 15fps (throttled during recording)
    -> User clicks Stop
    -> both cameras stop in parallel threads
    -> metadata sidecars written with patient info + sync data
```

The key thing here is that the BAG recording is handled entirely by the RealSense SDK. We dont manually grab frames and write them. The SDK records directly to the .bag file from the camera pipeline which means zero frame drops at the source. The preview stream runs separately at a lower FPS to save CPU.

### Multi Camera Sync (no hardware sync cable)

This is one of the trickier parts. We have two D455 cameras each on their own USB 3.1 Gen2 Type-A port on the Jetson. Theres no sync cable connecting them so we cant get hardware level frame sync.

What we do instead:

1. Both cameras start recording in parallel threads to minimize the start time offset
2. We capture `time.monotonic()` timestamps right before and after each cameras pipeline restart
3. The inter camera offset (how many ms apart they actually started) gets stored in the metadata sidecar
4. The quality analysis page shows this offset and uses it in the sync score

With parallel thread startup the offset is typically under 500ms, sometimes under 100ms. Not perfect but good enough for clinical gait analysis where movements happen over seconds not milliseconds.

The pause/resume system uses the RealSense SDK recorder device pause/resume so the BAG file doesnt contain dead frames during pauses. Both cameras pause and resume together.

### Streaming

The MJPEG preview stream is FPS throttled:
- **30 fps** when idle (smooth preview)
- **15 fps** during recording (saves CPU and USB bandwidth for the BAG recording)

Each camera has a background capture thread that continuously grabs frames from the RealSense pipeline. The streaming generator reads the latest frame from that thread, JPEG encodes it and sends it. This decouples capture rate from stream rate.

### Conversion Pipeline (BAG to MP4)

```
Select batch on Conversion page
    -> both cameras convert in parallel threads
    -> BAG replayed at max speed (non realtime, fast as disk IO allows)
    -> frames piped to FFmpeg stdin as raw BGR24
    -> encoder priority: h264_nvenc (Jetson NVENC) -> libx264 (CPU fallback)
    -> output written to .mp4.converting temp file
    -> frame count validated (must be >= 95% of BAG frames)
    -> temp file renamed to .mp4 on success, deleted on failure
    -> metadata sidecar updated with mp4 info
```

### Processing Pipeline (YOLOv8 Pose)

```
Select batch on Processing page
    -> both cameras processed in parallel threads
    -> loads BAG or MP4 (prefers BAG for depth data)
    -> runs YOLOv8 pose inference frame by frame
    -> extracts 17 COCO keypoints per frame
    -> calculates inter frame motion vectors
    -> detects tremor via nose jitter variance
    -> saves JSON report to api/processed/
```

### Quality Analysis

The quality page (in File Manager) shows per batch sync analysis:

- **Recording start offset**: how many ms apart the cameras started (ground truth from pipeline timestamps)
- **BAG frame count difference**: how many frames apart the bags are
- **MP4 frame count difference**: same but post conversion
- **Drop rate**: what percentage of BAG frames made it into the MP4
- **Sync quality**: excellent/good/fair/poor based on start offset + frame diff
- **Warning banner**: shows up when the start offset is too high, explaining that MP4s inherit the BAG offset

Score breakdown: 30pts recording start sync + 20pts frame count sync + 25pts per camera drop rate.

## Deployment

### Option A: Full Development (PC/Laptop) \

```sh
git clone https://github.com/mehdiouassou/parkinson-analysis.git
```

### Option B: API only

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

### Option C: Frontend only

```sh
mkdir parkinson-project && cd parkinson-project
git init
git remote add origin https://github.com/mehdiouassou/parkinson-analysis.git
git config core.sparseCheckout true
echo "web/" >> .git/info/sparse-checkout
git pull origin main
```

## Setup

### Desktop

Requires Python 3.10/3.11.

```sh
cd api
python3.11 -m virtualenv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r ../requirements/desktop.txt 
uvicorn main:app --reload --host 0.0.0.0
```

Use desktop-older.gpus.txt for older NVIDIA GPUs.

### Jetson AGX Orin (JetPack 5)

You should run `pip install -r requirements/jetson.txt` even if using the pre built artifact. It wont break anything and makes sure all deps are there.

#### Automated

Edit `ARTIFACT_URL` in `deploy/setup_jetson.sh` then run:

```sh
bash deploy/setup_jetson.sh
```

#### Manual

1. Clone or sparse checkout (Option B)
2. Download `jetson_orin_py38_env.tar.gz` from GitHub Releases
3. Unpack: `tar -xzvf jetson_orin_py38_env.tar.gz`
4. Generate TensorRT engine (10-15 min, dont interrupt):
   ```sh
   source api/venv/bin/activate
   yolo export model=models/yolov8n-pose.pt format=engine device=0 half=True workspace=4
   mv yolov8n-pose.engine models/
   rm -f yolov8n-pose.onnx
   ```
5. Run: `python api/main.py`

#### Jetson Performance

Make sure your Jetson is in MAXN power mode so the USB controllers and GPU arent throttled:

```sh
sudo nvpmodel -m 0
sudo jetson_clocks
```

Without this you might see USB bandwidth issues with dual cameras and slower NVENC encoding.

### Frontend

```sh
cd web
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Camera Modes

Set via `CAMERA_MODE` env var before starting the backend:

| Mode | What it does |
|---|---|
| `auto` | Auto detect connected RealSense cameras (default) |
| `mock_bag` | Replay `.bag` files, no hardware needed (for dev) |
| `realsense` | Force live RealSense detection |

For `mock_bag` also set `BAG_FILE_CAM1` and `BAG_FILE_CAM2` to your `.bag` file paths.

For Jetson/remote set `REMOTE_MODE=true` and `API_HOST=0.0.0.0`.

## Recording Output

Each session writes to `api/recordings/`:

| File | What it is |
|---|---|
| `<timestamp>_camera1.bag` | RealSense depth + RGB, Front camera |
| `<timestamp>_camera2.bag` | RealSense depth + RGB, Side camera |
| `<timestamp>_camera1.mp4` | Converted RGB video (created by Conversion page) |
| `<timestamp>_camera1_metadata.json` | Patient info, FPS, sync data, conversion info |

Camera 1 = Front/Frontale, Camera 2 = Side/Sagittale.

If only one camera is connected only that cameras files get written (orphan mode). The swap button on the recording page flips which physical device is camera 1.

## Models

Processing uses `yolov8n-pose` (17 COCO keypoints). Place model files in `models/`.

- Pipeline prefers TensorRT `.engine` and falls back to `.pt`
- `.engine` files are hardware specific, dont commit them or copy between devices
- On first run without a model file Ultralytics will try to download `yolov8n-pose.pt`

### Updating the Artifact

When Python deps change, rebuild the venv on the dev Jetson then:

```sh
bash deploy/pack_jetson_artifacts.sh
```

Upload `jetson_orin_py38_env.tar.gz` to GitHub Releases.

## Known Limitations and Future Improvements

### No hardware sync

Without a sync cable between the two D455 cameras we cant guarantee frame level synchronization. The parallel thread approach gets us within a few hundred ms which is fine for gait analysis but not for high precision temporal correlation. If you need sub frame sync you need the sync cable or a single multi sensor rig.

### USB bandwidth

Two D455 cameras at 848x480@60fps with both color and depth streams is pushing it even on USB 3.1 Gen2. If you see frame drops or pipeline failures the system falls back to 30fps automatically. Each camera ideally needs its own USB controller (not just its own port on the same hub).

### Streaming during recording

The MJPEG preview stream shares USB bandwidth with BAG recording. Thats why we throttle it to 15fps during recording. If you still see issues you could disable streaming entirely during recording but that means no live preview.

### Pipeline restart on record start/stop

Starting and stopping recording requires restarting the RealSense pipeline (to toggle the SDK recorder). This causes a brief interruption in the MJPEG stream. The frontend handles this with retry logic but you might see a flash.

### BAG file sizes

BAG files include depth + RGB at full resolution and are big. A 60 second recording at 60fps can be several GB per camera. Make sure you have enough disk space and plan for cleanup.

### Conversion is post recording

MP4s are not created during recording. You have to go to the Conversion page after recording to convert BAGs to MP4s. This is by design since we want zero drop BAG recording and dont want FFmpeg competing for CPU during capture.

## Documentation

```sh
cd docs
pip install -r requirements.txt
sphinx-build -b html . _build/html
```

Output goes to `docs/_build/html/`. Swagger UI is at `http://localhost:8000/docs` while the backend is running.

## Notes

- Dont commit `.engine` files or `venv/` directories
- Dont run `pip install` on Jetson unless using the requirements file
- If cameras are plugged in after the server starts call `POST /cameras/refresh`

## Author

**Mehdi Ouassou**
Universita degli Studi di Verona, Informatica L-31

## License

MIT License. See [LICENSE](LICENSE) for the full text.

You are free to use, modify and build upon this work for academic, research or personal purposes. Attribution is required: any use or derivative work must credit **Mehdi Ouassou** as the original author.
