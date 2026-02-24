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
3. Phase 1 (PREPARE): both cameras stop old pipelines and build new recording-enabled configs in parallel (~1-3s, concurrent)
4. Phase 2 (COMMIT): both cameras wait at a `threading.Barrier` then call `pipeline.start()` simultaneously (~100-300ms)
5. `time.monotonic()` timestamps captured around each commit + hardware timestamps tracked per frame
6. MJPEG preview stream throttled to 10fps during recording to save CPU
7. On Stop both cameras stop in parallel, BAG files renamed with CF/CS labels, metadata sidecars written with sync data and hardware timestamps
8. Pause/Resume uses the RealSense SDK recorder pause/resume (real pause, not fake)

## How streaming works

Background capture threads continuously read frames from the RealSense pipeline. The MJPEG generator reads the latest frame, JPEG encodes it and yields it. FPS is throttled to 30fps idle, 10fps during recording.

## How conversion works

BAG files are replayed at max speed (non realtime) and frames are piped to an encoder as raw video. Encoder priority: nvv4l2h264enc (Jetson GStreamer hardware) -> h264_nvenc (Desktop NVENC) -> libx264 (CPU fallback). Writes to a `.mp4.converting` temp file, validates frame count (>=95% of BAG), renames on success.

## How processing works

YOLOv8 pose inference on BAG or MP4 files. Extracts 17 COCO keypoints per frame, calculates motion vectors between frames, detects tremor via nose jitter variance. Results saved as JSON.

## Setup

Python 3.10 or 3.11 (Desktop) or 3.8 (Jetson with JetPack 5). Python 3.12+ is not supported due to pinned dependency versions (e.g. ``numpy==1.23.5``).

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

## File naming convention

Files follow the pattern `{timestamp}_{CF|CS}_{patient_id}_{note}.ext`:
- **CF** = Camera Frontale (front view, camera 1)
- **CS** = Camera Sagittale (side view, camera 2)

Legacy recordings using `_camera1`/`_camera2` naming are still recognised by all routes.
