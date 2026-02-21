# Parkinson Analysis API

FastAPI backend for the dual camera recording and processing system. Handles camera control, BAG recording, BAG to MP4 conversion, YOLOv8 processing, and file management.

## Modules

| Module | What it does |
|---|---|
| `main.py` | FastAPI app, all routes, recording state machine, MJPEG streaming |
| `camera.py` | RealSense camera abstraction, threaded capture, BAG record/pause/resume |
| `config.py` | Env vars, directory paths, device detection, video settings |
| `conversion.py` | BAG to MP4 pipeline, NVENC/x264 encoder selection, progress tracking |
| `processing.py` | YOLOv8 pose inference, motion calculation, tremor detection |
| `models.py` | Pydantic request/response schemas |
| `writers.py` | Video writer utilities |

## How recording works

1. User clicks Record, backend sets status to `warming_up`
2. 3 second warmup for auto exposure stabilization
3. Both cameras start BAG recording in parallel threads (minimizes start offset)
4. `time.monotonic()` timestamps captured around each pipeline restart for sync tracking
5. MJPEG preview stream throttled to 15fps during recording to save CPU
6. On Stop both cameras stop in parallel, metadata sidecars written with sync data
7. Pause/Resume uses the RealSense SDK recorder pause/resume (real pause, not fake)

## How streaming works

Background capture threads continuously read frames from the RealSense pipeline. The MJPEG generator reads the latest frame, JPEG encodes it and yields it. FPS is throttled to 30fps idle, 15fps during recording.

## How conversion works

BAG files are replayed at max speed (non realtime) and frames are piped to FFmpeg as raw BGR24. Tries h264_nvenc first (Jetson NVENC hardware encoder), falls back to libx264. Writes to a `.mp4.converting` temp file, validates frame count (>=95% of BAG), renames on success.

## How processing works

YOLOv8 pose inference on BAG or MP4 files. Extracts 17 COCO keypoints per frame, calculates motion vectors between frames, detects tremor via nose jitter variance. Results saved as JSON.

## Setup

Python 3.8+ (Jetson) or 3.12+ (Desktop).

```bash
pip install -r ../requirements/base.txt
# Desktop:
pip install -r ../requirements/desktop.txt
# Jetson:
pip install -r ../requirements/jetson.txt
```

## Running

```bash
# from api/ directory
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Environment Variables

| Variable | Default | What it does |
|---|---|---|
| `CAMERA_MODE` | `auto` | `auto`, `realsense`, or `mock_bag` |
| `REMOTE_MODE` | `false` | Set to `true` for Jetson remote access |
| `API_HOST` | `localhost` | `0.0.0.0` for remote, auto set if REMOTE_MODE is true |
| `BAG_FILE_CAM1` | | Path to .bag file for mock_bag mode (camera 1) |
| `BAG_FILE_CAM2` | | Path to .bag file for mock_bag mode (camera 2) |

## Directory Layout

| Directory | Contents |
|---|---|
| `recordings/` | BAG files, MP4 files, metadata JSON sidecars |
| `tagging/` | CSV files from the tagging page |
| `processed/` | JSON reports from YOLOv8 analysis |

All directories are auto created on startup.
