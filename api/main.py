"""
Parkinson Analysis API
======================

FastAPI backend for the Parkinson Analysis dual-camera recording and processing pipeline.

Modules:
    config.py      - Configuration, constants, and camera detection
    models.py      - Pydantic request/response models
    camera.py      - Camera source abstraction (RealSense, .bag)
    writers.py     - Video writers (BAG, MP4, FFmpeg)
    processing.py  - Video processing and analysis pipeline

Camera Modes (set via CAMERA_MODE env var):
    auto           - Auto-detect RealSense cameras (DEFAULT)
    mock_bag       - RealSense .bag file playback (for dev)
    realsense      - Live RealSense cameras (force RealSense)

Recording Behavior:
    RealSense cameras:
        - .bag file (depth + RGB) for processing
        - .mp4 file (RGB only) for viewing/tagging

Camera Priority:
    Camera 0 (CAM1/Front)  is the first detected RealSense device.
    Camera 1 (CAM2/Side)   is the second detected RealSense device.
    If only one camera is connected, only camera1 files are recorded.
"""

from fastapi import FastAPI, Request, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import threading
import time
import json
import subprocess
from datetime import datetime
from typing import Dict

# Local modules
from config import (
    CAMERA_MODE,
    RECORDINGS_DIR,
    TAGGING_DIR,
    PROCESSED_DIR,
    FFMPEG_AVAILABLE,
    REALSENSE_AVAILABLE,
    rs,
    imageio_ffmpeg,
    JPEG_QUALITY,
    DEFAULT_FPS,
    CAMERA_TYPE_REALSENSE,
    get_detected_cameras,
    refresh_camera_detection,
    SYSTEM_STATE,
    state_lock
)
from models import (
    ActionLog,
    SaveTaggingRequest,
    ProcessRequest,
    RecordingStartRequest
)
from camera import (
    get_camera_source,
    shutdown_all_cameras,
    camera_sources
)
from writers import (
    create_mp4_writer
)
from processing import (
    process_video,
    create_processing_job,
    get_job,
    cancel_job,
    get_all_jobs,
    is_batch_processing
)


# =============================================================================
#                              FASTAPI APP SETUP
# =============================================================================

app = FastAPI(
    title="Parkinson Camera API",
    description="Clinical motion analysis for Parkinson's disease",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
#                           RECORDING STATE
# =============================================================================

WARMUP_DURATION = 3  # seconds for camera auto-exposure to stabilize before writing

recording_state = {
    "status": "idle",           # idle, warming_up, recording, paused
    "start_time": None,         # Actual recording start (set after warm-up)
    "warmup_start": None,       # When warm-up began (for countdown)
    "timestamp_str": None,      # Timestamp string used for file naming
    "writers_mp4": {},          # logical_cam_id -> VideoWriter (compressed MP4 for viewing)
    "writers_bag": {},          # logical_cam_id -> True/None (BAG recording via pipeline)
    "filenames_mp4": {},        # logical_cam_id -> filename
    "filenames_bag": {},        # logical_cam_id -> filename
    "camera_types": {},         # logical_cam_id -> camera_type
    "frame_size": {},           # logical_cam_id -> (width, height)
    "frame_counts": {},         # logical_cam_id -> frames written to MP4
    "fps": DEFAULT_FPS,
    "patient_name": "",
    "patient_id": ""
}
recording_lock = threading.Lock()


# =============================================================================
#                         CAMERA SWAP STATE
# =============================================================================

SWAP_CAMERAS: bool = False  # If True, logical cam 0 maps to physical cam 1 and vice-versa


def get_physical_camera_id(logical_id: int) -> int:
    """
    Map a logical camera ID to its physical camera ID.

    When SWAP_CAMERAS is False: identity mapping (0->0, 1->1).
    When SWAP_CAMERAS is True:  swap mapping  (0->1, 1->0).

    Logical IDs determine file naming:
        Logical 0 → camera1 files (Front/Sagittale)
        Logical 1 → camera2 files (Side/Frontale)
    """
    if SWAP_CAMERAS:
        return 1 - logical_id
    return logical_id


# =============================================================================
#                         FRAME STREAMING GENERATOR
# =============================================================================

def gen_frames(camera_id: int):
    """
    Generate frames from camera for MJPEG streaming.

    Handles:
        - Reading frames from camera source (via physical ID after swap)
        - JPEG encoding for streaming
        - Graceful stream termination when camera goes offline so the browser
          fires onError and the frontend can retry with exponential back-off.

    MP4 recording is handled directly by the capture thread (decoupled).
    """
    last_good_frame = None
    # Count consecutive iterations where the camera is offline or delivering
    # no frames.  Once the threshold is exceeded we close the stream so the
    # frontend's onError handler fires and retries with exponential back-off.
    offline_ticks = 0
    MAX_OFFLINE_TICKS = 60  # ~2 s at 30 fps; camera hiccups are tolerated

    while True:
        # Re-evaluate every frame so a camera swap is picked up immediately
        physical_id = get_physical_camera_id(camera_id)
        camera = get_camera_source(physical_id)

        frame = None
        camera_running = camera.is_running()

        if camera_running:
            ret, frame, depth = camera.read()
            if ret and frame is not None:
                last_good_frame = frame
                offline_ticks = 0
            else:
                # Brief read failure — serve last good frame
                frame = last_good_frame
        else:
            # Camera not running (starting up or disconnected)
            frame = last_good_frame
            offline_ticks += 1

        if offline_ticks > MAX_OFFLINE_TICKS:
            # Camera has been offline too long — close the MJPEG stream.
            # The browser detects the closed connection and fires onError on
            # the <img> tag, which triggers the frontend's retry back-off.
            break

        if frame is None:
            # No frame yet (camera still initialising) — pause briefly
            time.sleep(0.033)
            continue

        _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')

        time.sleep(0.015)


# =============================================================================
#                          CAMERA STREAMING ROUTES
# =============================================================================

@app.get("/camera/{camera_id}")
def video_feed(camera_id: int):
    """
    Stream MJPEG video from camera 0 or 1.

    Returns HTTP 503 when the camera is not yet running so the browser's
    <img> onError fires immediately and the frontend can retry with
    exponential back-off without keeping a long-lived connection alive.
    """
    physical_id = get_physical_camera_id(camera_id)
    camera = get_camera_source(physical_id)

    if not camera.is_running():
        return JSONResponse(
            status_code=503,
            content={"error": f"Camera {camera_id} not available"},
            headers={"Retry-After": "2"},
        )

    return StreamingResponse(
        gen_frames(camera_id),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# =============================================================================
#                           RECORDING ROUTES
# =============================================================================

def _start_camera_recording(cam_id: int, timestamp_str: str, result_dict: dict):
    """
    Start BAG + MP4 recording for a single logical camera.

    Called in parallel threads (one per camera) so both cameras start at
    nearly the same time, minimising the inter-camera frame offset.

    Result is stored in result_dict[cam_id] for the caller to inspect.
    """
    physical_id = get_physical_camera_id(cam_id)
    camera = get_camera_source(physical_id)

    if not camera.is_running():
        print(f"[Recording] Logical cam {cam_id} (physical {physical_id}) offline, skipping")
        result_dict[cam_id] = None
        return

    camera_type = camera.camera_type
    actual_fps = camera.fps  # Use ACTUAL camera FPS, not DEFAULT_FPS
    frame_size = camera.frame_size or (848, 480)

    print(f"[Recording] Logical cam {cam_id} (physical {physical_id}): {camera_type} {frame_size}@{actual_fps}fps")

    # BAG recording (RealSense depth + RGB) — restarts pipeline
    bag_filename = f"{timestamp_str}_camera{cam_id + 1}.bag"
    bag_filepath = str(RECORDINGS_DIR / bag_filename)

    bag_success = camera.start_recording(bag_filepath)
    if bag_success:
        print(f"[Recording] BAG started for logical cam {cam_id}: {bag_filepath}")
    else:
        print(f"[Recording] BAG failed for logical cam {cam_id}, no high-quality recording")

    # MP4 preview writer — uses actual camera FPS
    mp4_filename = f"{timestamp_str}_camera{cam_id + 1}.mp4"
    mp4_filepath = str(RECORDINGS_DIR / mp4_filename)

    writer_mp4 = create_mp4_writer(mp4_filepath, frame_size, actual_fps)
    print(f"[Recording] MP4 writer for logical cam {cam_id}: {mp4_filepath}, opened={writer_mp4.isOpened()}")

    # Pass MP4 writer to camera capture thread (decoupled from streaming)
    camera.set_mp4_writer(writer_mp4)

    result_dict[cam_id] = {
        "writer_mp4": writer_mp4,
        "mp4_filename": mp4_filename,
        "bag_filename": bag_filename if bag_success else None,
        "bag_success": bag_success,
        "camera_type": camera_type,
        "frame_size": frame_size,
        "actual_fps": actual_fps,
    }


def _initialize_recording():
    """
    Create VideoWriters for all active cameras and start recording.

    Both cameras are started in PARALLEL threads so their recording pipelines
    initialise at the same time, minimising the inter-camera start offset.

    Performs slow operations (pipeline restart, writer creation) WITHOUT
    holding the recording lock to avoid blocking the MJPEG streams.

    Orphan handling: if only one camera is running, writers are only
    created for that camera. No 0-byte files are created for missing cameras.

    File naming uses the LOGICAL camera ID (not the physical one):
        Logical 0 → _camera1.bag / _camera1.mp4  (Front/Sagittale)
        Logical 1 → _camera2.bag / _camera2.mp4  (Side/Frontale)
    """
    # Read state under lock
    with recording_lock:
        if recording_state["status"] != "warming_up":
            print("[Recording] Warm-up cancelled before writers were created")
            return
        timestamp_str = recording_state["timestamp_str"]

    # ---- Launch both cameras in PARALLEL to minimise start-time offset ----
    writers_info: dict = {}
    threads = []
    for cam_id in [0, 1]:
        t = threading.Thread(
            target=_start_camera_recording,
            args=(cam_id, timestamp_str, writers_info),
            daemon=True,
        )
        threads.append(t)
        t.start()

    # Wait for both cameras to finish initialising
    for t in threads:
        t.join()

    # Remove cameras that were offline (result_dict stores None for those)
    writers_info = {k: v for k, v in writers_info.items() if v is not None}

    # Store results under lock
    with recording_lock:
        if recording_state["status"] != "warming_up":
            # Cancelled during initialization — clean up
            for cam_id, info in writers_info.items():
                physical_id = get_physical_camera_id(cam_id)
                camera = get_camera_source(physical_id)
                camera.clear_mp4_writer()
                info["writer_mp4"].release()
                if info["bag_success"]:
                    camera.stop_recording()
            print("[Recording] Warm-up cancelled during writer initialization")
            return

        for cam_id, info in writers_info.items():
            recording_state["writers_mp4"][cam_id] = info["writer_mp4"]
            recording_state["filenames_mp4"][cam_id] = info["mp4_filename"]
            recording_state["writers_bag"][cam_id] = info["bag_success"]
            recording_state["filenames_bag"][cam_id] = info["bag_filename"]
            recording_state["camera_types"][cam_id] = info["camera_type"]
            recording_state["frame_size"][cam_id] = info["frame_size"]
            recording_state["frame_counts"][cam_id] = 0
            recording_state.setdefault("fps_per_cam", {})[cam_id] = info["actual_fps"]

        recording_state["status"] = "recording"
        recording_state["start_time"] = datetime.now()
        print("[Recording] Recording started (both cameras initialised in parallel)")


@app.post("/recording/start")
def start_recording(data: RecordingStartRequest = None):
    """
    Start recording with a warm-up period.

    Immediately sets status to 'warming_up' and returns. A background thread
    waits WARMUP_DURATION seconds (so auto-exposure can stabilize), then
    initializes VideoWriters and sets status to 'recording'.

    Only active (running) cameras get writers. If one camera is offline,
    only the other camera is recorded (orphan mode).
    """
    with recording_lock:
        if recording_state["status"] in ("recording", "warming_up", "paused"):
            return JSONResponse(
                status_code=409,
                content={
                    "error": "A recording is already in progress",
                    "status": recording_state["status"]
                }
            )

    timestamp = datetime.now()
    timestamp_str = timestamp.strftime("%Y-%m-%d_%H-%M-%S")

    with recording_lock:
        recording_state["patient_name"] = data.patientName if data else ""
        recording_state["patient_id"] = data.patientId if data else ""
        recording_state["timestamp_str"] = timestamp_str
        recording_state["warmup_start"] = timestamp
        recording_state["frame_counts"] = {}
        recording_state["status"] = "warming_up"

    def warmup_then_record():
        """Wait for warm-up then initialize writers and start recording."""
        time.sleep(WARMUP_DURATION)
        print("[Recording] Warm-up complete, initializing writers...")
        _initialize_recording()

    t = threading.Thread(target=warmup_then_record, daemon=True)
    t.start()

    return {
        "status": "warming_up",
        "message": f"Warming up cameras for {WARMUP_DURATION}s before recording..."
    }


@app.post("/recording/pause")
def pause_recording():
    """Pause recording."""
    with recording_lock:
        recording_state["status"] = "paused"
        # Pause MP4 writing on all cameras
        for cam_id in list(recording_state["writers_mp4"].keys()):
            physical_id = get_physical_camera_id(cam_id)
            try:
                camera = get_camera_source(physical_id)
                camera.pause_mp4_writer()
            except Exception:
                pass
    return {"status": "paused", "message": "Recording paused"}


@app.post("/recording/resume")
def resume_recording():
    """Resume recording."""
    with recording_lock:
        recording_state["status"] = "recording"
        # Resume MP4 writing on all cameras
        for cam_id in list(recording_state["writers_mp4"].keys()):
            physical_id = get_physical_camera_id(cam_id)
            try:
                camera = get_camera_source(physical_id)
                camera.resume_mp4_writer()
            except Exception:
                pass
    return {"status": "recording", "message": "Recording resumed"}


@app.post("/recording/stop")
def stop_recording():
    """
    Stop recording and save files with metadata sidecars.

    RealSense cameras produce: .bag + .mp4
    If called during warm-up, cancels the warm-up before any writers are created.
    BAG and MP4 pipelines for both cameras are stopped in parallel to minimise
    the inter-camera stop-time offset.
    """
    mp4_files = []
    bag_files = []
    patient_name = ""
    patient_id = ""
    camera_types = {}

    # Frame counts and FPS captured BEFORE the writers are released
    _stop_frame_counts: dict = {}
    _stop_fps: dict = {}

    with recording_lock:
        if recording_state["status"] == "idle":
            return {"status": "idle", "message": "No recording is active"}

        if recording_state["status"] == "warming_up":
            recording_state["status"] = "idle"
            recording_state["warmup_start"] = None
            recording_state["timestamp_str"] = None
            recording_state["camera_types"] = {}
            recording_state["frame_counts"] = {}
            recording_state["patient_name"] = ""
            recording_state["patient_id"] = ""
            print("[Recording] Warm-up cancelled by stop request")
            return {
                "status": "idle",
                "message": "Recording cancelled during warm-up",
                "mp4_files": [],
                "bag_files": [],
                "path": str(RECORDINGS_DIR)
            }

        # Atomically read all state and clear in one lock acquisition
        patient_name = recording_state.get("patient_name", "")
        patient_id = recording_state.get("patient_id", "")
        camera_types = recording_state.get("camera_types", {}).copy()
        fps_per_cam = recording_state.get("fps_per_cam", {}).copy()

        # Collect writers and filenames before clearing state
        writers_bag = dict(recording_state["writers_bag"])
        writers_mp4 = dict(recording_state["writers_mp4"])
        filenames_bag = dict(recording_state["filenames_bag"])
        filenames_mp4 = dict(recording_state["filenames_mp4"])

        # Clear state immediately to prevent concurrent operations
        recording_state["status"] = "idle"
        recording_state["start_time"] = None
        recording_state["warmup_start"] = None
        recording_state["timestamp_str"] = None
        recording_state["writers_mp4"] = {}
        recording_state["writers_bag"] = {}
        recording_state["filenames_mp4"] = {}
        recording_state["filenames_bag"] = {}
        recording_state["camera_types"] = {}
        recording_state["frame_counts"] = {}
        recording_state["fps_per_cam"] = {}
        recording_state["patient_name"] = ""
        recording_state["patient_id"] = ""

    # ----- Capture frame counts BEFORE writers are released -----
    for cam_id in list(writers_mp4.keys()):
        physical_id = get_physical_camera_id(cam_id)
        try:
            camera = camera_sources.get(physical_id)
            if camera:
                _stop_frame_counts[cam_id] = camera.get_mp4_frame_count()
        except Exception:
            _stop_frame_counts[cam_id] = 0
        _stop_fps[cam_id] = fps_per_cam.get(cam_id, DEFAULT_FPS)

    # ----- Clear MP4 writers from camera capture threads (parallel) -----
    def _clear_writer(cam_id: int):
        physical_id = get_physical_camera_id(cam_id)
        try:
            camera = camera_sources.get(physical_id)
            if camera:
                camera.clear_mp4_writer()
        except Exception as e:
            print(f"[Recording] Error clearing MP4 writer cam {cam_id}: {e}")

    clear_threads = [threading.Thread(target=_clear_writer, args=(c,), daemon=True)
                     for c in list(writers_mp4.keys())]
    for t in clear_threads:
        t.start()
    for t in clear_threads:
        t.join()

    # ----- Stop BAG recordings and release MP4 writers in PARALLEL -----
    def _stop_cam_resources(cam_id: int):
        """Stop BAG + release MP4 writer for one camera."""
        # Stop BAG
        is_recording = writers_bag.get(cam_id, False)
        if is_recording:
            print(f"[Recording] Stopping BAG recording logical cam {cam_id}")
            try:
                physical_cam = get_camera_source(get_physical_camera_id(cam_id))
                physical_cam.stop_recording()
            except Exception as e:
                print(f"[Recording] Error stopping BAG cam {cam_id}: {e}")

        bag_filename = filenames_bag.get(cam_id)
        if bag_filename:
            filepath = RECORDINGS_DIR / bag_filename
            try:
                exists = filepath.exists()
                size = filepath.stat().st_size if exists else 0
                print(f"[Recording] BAG {bag_filename}: exists={exists}, size={size}")
                if exists and size > 0:
                    bag_files.append(bag_filename)
            except OSError as e:
                print(f"[Recording] Error checking BAG file {bag_filename}: {e}")

        # Release MP4 writer
        writer = writers_mp4.get(cam_id)
        if writer is not None:
            print(f"[Recording] Releasing MP4 writer logical cam {cam_id}")
            try:
                writer.release()
            except Exception as e:
                print(f"[Recording] Error releasing MP4 writer cam {cam_id}: {e}")

        mp4_filename = filenames_mp4.get(cam_id)
        if mp4_filename:
            filepath = RECORDINGS_DIR / mp4_filename
            try:
                exists = filepath.exists()
                size = filepath.stat().st_size if exists else 0
                print(f"[Recording] MP4 {mp4_filename}: frames={_stop_frame_counts.get(cam_id, '?')}, exists={exists}, size={size}")
                if exists and size > 0:
                    mp4_files.append(mp4_filename)
            except OSError as e:
                print(f"[Recording] Error checking MP4 file {mp4_filename}: {e}")

    all_cam_ids = set(list(writers_bag.keys()) + list(writers_mp4.keys()))
    stop_threads = [threading.Thread(target=_stop_cam_resources, args=(c,), daemon=True)
                    for c in all_cam_ids]
    for t in stop_threads:
        t.start()
    for t in stop_threads:
        t.join()

    # Save metadata sidecar for each MP4 file
    for mp4_file in mp4_files:
        base_name = mp4_file.replace('.mp4', '')
        metadata_file = f"{base_name}_metadata.json"
        metadata_path = RECORDINGS_DIR / metadata_file

        cam_id = 0 if '_camera1' in base_name else 1 if '_camera2' in base_name else -1
        cam_type = camera_types.get(cam_id, CAMERA_TYPE_REALSENSE)
        # Logical cam_id 0 = Front/Sagittale, cam_id 1 = Side/Frontale
        camera_view = "Front" if cam_id == 0 else "Side"

        # Try to retrieve frame counts saved during stop
        cam_mp4_frames = _stop_frame_counts.get(cam_id, 0)

        metadata_content = {
            "patient_name": patient_name,
            "patient_id": patient_id,
            "mp4_file": mp4_file,
            "bag_file": mp4_file.replace('.mp4', '.bag'),
            "hq_file": mp4_file.replace('.mp4', '.bag'),
            "camera_type": cam_type,
            "camera_view": camera_view,  # "Front" or "Side" for tagging page
            "fps": _stop_fps.get(cam_id, DEFAULT_FPS),  # Actual recording FPS
            "mp4_frames": cam_mp4_frames,               # Frames written to MP4
            "recorded_at": datetime.now().isoformat(),
            "camera_mode": CAMERA_MODE
        }
        metadata_path.write_text(json.dumps(metadata_content, indent=2))
        print(f"[Recording] Metadata saved: {metadata_file}")

    return {
        "status": "idle",
        "message": "Recording stopped",
        "mp4_files": mp4_files,
        "bag_files": bag_files,
        "path": str(RECORDINGS_DIR)
    }


@app.get("/recording/status")
def get_recording_status():
    """
    Get current recording status with live metrics.

    Returns:
        status:            idle | warming_up | recording | paused
        duration:          seconds elapsed since recording started (None during warm-up)
        warmup_remaining:  seconds left in warm-up countdown (None when not warming up)
        frame_counts:      dict of camera_id -> frames written to MP4
        current_filenames: dict of "camN_mp4/bag" -> filename (populated after warm-up)
    """
    with recording_lock:
        status = recording_state["status"]
        start_time = recording_state["start_time"]
        warmup_start = recording_state["warmup_start"]

        duration = None
        warmup_remaining = None

        if status == "recording" and start_time:
            duration = (datetime.now() - start_time).total_seconds()

        if status == "warming_up" and warmup_start:
            elapsed = (datetime.now() - warmup_start).total_seconds()
            warmup_remaining = max(0.0, WARMUP_DURATION - elapsed)

        current_filenames: dict = {}
        for cam_id, fname in recording_state["filenames_mp4"].items():
            if fname:
                current_filenames[f"cam{cam_id}_mp4"] = fname
        for cam_id, fname in recording_state["filenames_bag"].items():
            if fname:
                current_filenames[f"cam{cam_id}_bag"] = fname

        # Get live frame counts from camera capture threads
        live_frame_counts = {}
        if status in ("recording", "paused"):
            for cam_id in list(recording_state.get("writers_mp4", {}).keys()):
                physical_id = get_physical_camera_id(cam_id)
                camera = camera_sources.get(physical_id)
                if camera:
                    live_frame_counts[cam_id] = camera.get_mp4_frame_count()
                else:
                    live_frame_counts[cam_id] = 0

        return {
            "status": status,
            "patient_name": recording_state["patient_name"],
            "patient_id": recording_state["patient_id"],
            "start_time": start_time.isoformat() if start_time else None,
            "duration": duration,
            "warmup_remaining": warmup_remaining,
            "frame_counts": live_frame_counts,
            "current_filenames": current_filenames,
        }


# =============================================================================
#                           SYSTEM INFO ROUTES
# =============================================================================

@app.get("/system/info")
def get_system_info():
    """Get system information and capabilities."""
    return {
        "camera_mode": CAMERA_MODE,
        "realsense_available": REALSENSE_AVAILABLE,
        "ffmpeg_available": FFMPEG_AVAILABLE,
        "active_cameras": list(camera_sources.keys()),
        "supported_modes": [
            "auto",       # Auto-detect RealSense cameras (recommended)
            "mock_bag",   # RealSense .bag playback (for dev)
            "realsense",  # Live RealSense (force detection)
        ]
    }


@app.get("/cameras/info")
def get_cameras_info():
    """
    Get detailed information about detected cameras.

    Returns camera types, serials, and recording formats.
    """
    detected = get_detected_cameras()
    cameras_info = []

    for cam_id in [0, 1]:
        camera = get_camera_source(cam_id)
        info = camera.get_info()
        info["recording_format"] = {
            "high_quality": ".bag (depth + RGB)",
            "preview": ".mp4 (RGB)"
        }
        cameras_info.append(info)

    return {
        "mode": CAMERA_MODE,
        "cameras": cameras_info,
        "detected_devices": detected
    }






@app.post("/cameras/refresh")
def refresh_cameras():
    """
    Force re-detection of cameras.
    Call this if you've plugged in or unplugged cameras.
    """
    # 1. Stop all cameras first to release USB handles
    shutdown_all_cameras()
    
    # 2. Refresh detection logic (simple, fast, no retries)
    refresh_camera_detection()

    # 3. Return result
    detected = get_detected_cameras()
    return {
        "message": "Cameras refreshed",
        "detected": detected
    }





@app.post("/cameras/swap")
def swap_cameras():
    """
    Toggle the logical↔physical camera swap.

    When swapped, /camera/0 streams from physical device 1 and vice-versa.
    Recordings are always saved with logical naming:

    - camera1 = Front/Sagittale  (logical 0)
    - camera2 = Side/Frontale    (logical 1)
    """
    global SWAP_CAMERAS
    SWAP_CAMERAS = not SWAP_CAMERAS

    print(f"[CameraSwap] SWAP_CAMERAS = {SWAP_CAMERAS}")
    return {"is_swapped": SWAP_CAMERAS}


@app.get("/cameras/swap-state")
def get_cameras_swap_state():
    """Return the current camera swap state."""
    return {"is_swapped": SWAP_CAMERAS}


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.on_event("shutdown")
def shutdown():
    """Clean up resources on shutdown."""
    shutdown_all_cameras()


# =============================================================================
#                         VIDEO LISTING & SERVING
# =============================================================================

@app.get("/recordings")
def list_recordings():
    """List MP4 video files for tagging, including patient metadata."""
    files = []

    for f in RECORDINGS_DIR.glob("*.mp4"):
        metadata_path = RECORDINGS_DIR / f"{f.stem}_metadata.json"
        patient_name = ""
        patient_id = ""
        if metadata_path.exists():
            try:
                meta = json.loads(metadata_path.read_text())
                patient_name = meta.get("patient_name", "")
                patient_id = meta.get("patient_id", "")
            except Exception:
                pass

        if "_camera1" in f.stem:
            cam_type = "Front"
        elif "_camera2" in f.stem:
            cam_type = "Side"
        else:
            cam_type = ""

        files.append({
            "name": f.name,
            "size": f.stat().st_size,
            "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            "format": "mp4",
            "patient_name": patient_name,
            "patient_id": patient_id,
            "camera_type": cam_type,
        })

    files.sort(key=lambda x: x["modified"], reverse=True)
    return {"files": files}


@app.get("/recordings/batches")
def list_batches():
    """
    List recording batches (camera1 + camera2 pairs) and orphaned singles.

    Primary processing file: .bag (RealSense depth + RGB)
    Preview file: .mp4

    Returns MP4 names for viewing/tagging.
    """
    bag_files = list(RECORDINGS_DIR.glob("*.bag"))

    batches: Dict[str, dict] = {}

    for f in bag_files:
        name = f.stem
        parts = name.rsplit('_camera', 1)
        if len(parts) == 2:
            batch_id = parts[0]
            camera_num = parts[1]

            if batch_id not in batches:
                batches[batch_id] = {
                    "batch_id": batch_id,
                    "camera1": None,
                    "camera2": None,
                    "camera1_hq": None,
                    "camera2_hq": None,
                    "camera1_type": None,
                    "camera2_type": None,
                    "complete": False,
                    "orphaned": False,
                    "type": "batch",
                    "modified": None
                }

            mp4_file = RECORDINGS_DIR / f"{name}.mp4"
            if camera_num == "1":
                batches[batch_id]["camera1_hq"] = f.name
                batches[batch_id]["camera1"] = mp4_file.name if mp4_file.exists() else f.name
                batches[batch_id]["camera1_type"] = CAMERA_TYPE_REALSENSE
            elif camera_num == "2":
                batches[batch_id]["camera2_hq"] = f.name
                batches[batch_id]["camera2"] = mp4_file.name if mp4_file.exists() else f.name
                batches[batch_id]["camera2_type"] = CAMERA_TYPE_REALSENSE

            mtime = datetime.fromtimestamp(f.stat().st_mtime).isoformat()
            if batches[batch_id]["modified"] is None or mtime > batches[batch_id]["modified"]:
                batches[batch_id]["modified"] = mtime

    # Mark complete vs orphaned
    for batch in batches.values():
        has_cam1 = batch["camera1_hq"] is not None
        has_cam2 = batch["camera2_hq"] is not None
        batch["complete"] = has_cam1 and has_cam2
        batch["orphaned"] = (has_cam1 or has_cam2) and not batch["complete"]
        if batch["orphaned"]:
            batch["type"] = "orphan"

    # Enrich with patient metadata from sidecar JSON
    for batch_id, batch in batches.items():
        meta_path = RECORDINGS_DIR / f"{batch_id}_camera1_metadata.json"
        if not meta_path.exists():
            meta_path = RECORDINGS_DIR / f"{batch_id}_camera2_metadata.json"

        batch["patient_name"] = ""
        batch["patient_id"] = ""
        batch["recorded_at"] = ""

        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                batch["patient_name"] = meta.get("patient_name", "")
                batch["patient_id"] = meta.get("patient_id", "")
                batch["recorded_at"] = meta.get("recorded_at", "")
            except Exception:
                pass

    result = sorted(batches.values(), key=lambda x: x["modified"] or "", reverse=True)
    return {"batches": result}


@app.get("/recordings/frame-comparison/{batch_id}")
def get_frame_comparison(batch_id: str):
    """
    Compare frame counts between BAG and MP4 files for a recording batch.

    Returns per-camera statistics so the specialist can assess how many frames
    were dropped between the high-quality BAG source and the MP4 preview, and
    whether both cameras have a similar (ideally equal) frame count.

    BAG frame count is read from the metadata sidecar (saved at stop time).
    MP4 frame count is read via OpenCV (or from the sidecar).
    """
    import cv2 as _cv2

    results = {}

    for cam_num in [1, 2]:
        cam_key = f"camera{cam_num}"
        bag_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}.bag"
        mp4_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}.mp4"
        meta_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}_metadata.json"

        cam_result = {
            "bag_exists": bag_path.exists(),
            "mp4_exists": mp4_path.exists(),
            "bag_frames": None,
            "mp4_frames": None,
            "mp4_frames_from_sidecar": None,
            "frame_difference": None,
            "drop_rate_percent": None,
            "fps": DEFAULT_FPS,
        }

        # Read FPS and MP4 frame count from sidecar (fast, no need to decode)
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                cam_result["fps"] = meta.get("fps", DEFAULT_FPS)
                sidecar_mp4_frames = meta.get("mp4_frames")
                if sidecar_mp4_frames:
                    cam_result["mp4_frames_from_sidecar"] = sidecar_mp4_frames
            except Exception:
                pass

        # Count MP4 frames via OpenCV (authoritative, works on any MP4)
        if mp4_path.exists():
            try:
                cap = _cv2.VideoCapture(str(mp4_path))
                cam_result["mp4_frames"] = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                if cam_result["fps"] == DEFAULT_FPS:
                    reported_fps = cap.get(_cv2.CAP_PROP_FPS)
                    if reported_fps > 0:
                        cam_result["fps"] = reported_fps
                cap.release()
            except Exception as e:
                cam_result["mp4_frames_error"] = str(e)

        # Count BAG frames by replaying through pyrealsense2 with real-time
        # disabled so the pipeline runs as fast as disk I/O allows.
        # This is exact (not an estimate) but takes a few seconds on large files.
        if bag_path.exists():
            bag_size = bag_path.stat().st_size
            mp4_size = mp4_path.stat().st_size if mp4_path.exists() else 0
            cam_result["bag_size_mb"] = round(bag_size / (1024 * 1024), 1)
            cam_result["mp4_size_mb"] = round(mp4_size / (1024 * 1024), 1)

            if REALSENSE_AVAILABLE and rs is not None:
                try:
                    _pipeline = rs.pipeline()
                    _config = rs.config()
                    rs.config.enable_device_from_file(
                        _config, str(bag_path), repeat_playback=False
                    )
                    # Only need colour stream for counting
                    _config.enable_stream(rs.stream.color)
                    _profile = _pipeline.start(_config)

                    # Run without real-time constraint — as fast as disk allows
                    _playback = _profile.get_device().as_playback()
                    _playback.set_real_time(False)

                    bag_frame_count = 0
                    while True:
                        try:
                            _frames = _pipeline.wait_for_frames(timeout_ms=2000)
                            if _frames.get_color_frame():
                                bag_frame_count += 1
                        except RuntimeError:
                            # End of file reached
                            break

                    try:
                        _pipeline.stop()
                    except Exception:
                        pass

                    cam_result["bag_frames"] = bag_frame_count
                    cam_result["bag_frames_source"] = "exact"
                except Exception as e:
                    print(f"[FrameComparison] BAG playback failed for {bag_path.name}: {e}")
                    cam_result["bag_frames"] = None
                    cam_result["bag_frames_source"] = "unavailable"
            else:
                cam_result["bag_frames"] = None
                cam_result["bag_frames_source"] = "realsense_unavailable"

        # Compute difference metrics
        mp4_f = cam_result["mp4_frames"]
        bag_f = cam_result["bag_frames"]
        if mp4_f is not None and bag_f is not None and bag_f > 0:
            diff = bag_f - mp4_f
            cam_result["frame_difference"] = diff
            cam_result["drop_rate_percent"] = round(max(0, diff) / bag_f * 100, 2)

        results[cam_key] = cam_result

    # Cross-camera synchronisation comparison
    cam1_frames = results.get("camera1", {}).get("mp4_frames")
    cam2_frames = results.get("camera2", {}).get("mp4_frames")
    sync_info = {}
    if cam1_frames and cam2_frames:
        sync_info["cam1_mp4_frames"] = cam1_frames
        sync_info["cam2_mp4_frames"] = cam2_frames
        sync_info["frame_count_difference"] = abs(cam1_frames - cam2_frames)
        fps = results.get("camera1", {}).get("fps") or DEFAULT_FPS
        sync_info["time_offset_seconds"] = round(
            abs(cam1_frames - cam2_frames) / fps if fps > 0 else 0, 3
        )
        sync_info["in_sync"] = sync_info["frame_count_difference"] <= int(fps)  # within 1 second

    return {
        "batch_id": batch_id,
        "cameras": results,
        # None (→ JSON null) when only one camera exists so the frontend
        # can distinguish "no sync possible" from "sync computed".
        "sync": sync_info if sync_info else None,
    }


@app.get("/videos/{video_name}")
def get_video(video_name: str, request: Request):
    """
    Serve video with byte-range support for streaming.

    Always advertises Accept-Ranges so browsers can seek immediately
    without downloading the entire file first.
    """
    video_path = RECORDINGS_DIR / video_name

    if not video_path.exists():
        return JSONResponse(status_code=404, content={"error": "Video not found"})

    file_size = video_path.stat().st_size
    range_header = request.headers.get('range')

    media_type = "video/mp4" if video_name.endswith('.mp4') else "application/octet-stream"

    def chunk_generator(path, start_pos, end_pos, chunk_size=1024*1024):
        with open(path, "rb") as f:
            f.seek(start_pos)
            remaining = end_pos - start_pos + 1
            while remaining > 0:
                read_size = min(chunk_size, remaining)
                data = f.read(read_size)
                if not data:
                    break
                yield data
                remaining -= len(data)

    if not range_header:
        # No Range header — return full file but advertise range support
        # so the browser knows it can seek without re-downloading.
        return StreamingResponse(
            chunk_generator(video_path, 0, file_size - 1),
            status_code=200,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Content-Type": media_type,
            }
        )

    range_str = range_header.replace("bytes=", "")
    parts = range_str.split("-")
    start = int(parts[0]) if parts[0] else 0
    end = int(parts[1]) if parts[1] else file_size - 1

    start = max(0, start)
    end = min(end, file_size - 1)

    return StreamingResponse(
        chunk_generator(video_path, start, end),
        status_code=206,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
            "Content-Type": media_type,
        }
    )


@app.get("/videos/{video_name}/metadata")
def get_video_metadata(video_name: str):
    """
    Read video metadata from sidecar JSON or embedded ffprobe tags.
    Fallback logic for FPS: Metadata -> Container (MP4/BAG) -> Default.
    """
    video_path = RECORDINGS_DIR / video_name

    if not video_path.exists():
        return JSONResponse(status_code=404, content={"error": "Video not found"})

    # Try sidecar JSON first
    metadata_file = video_name.replace('.mp4', '_metadata.json')
    metadata_path = RECORDINGS_DIR / metadata_file

    result_metadata = {
        "patient_name": "",
        "patient_id": "",
        "comment": "",
        "recorded_at": "",
        "camera_view": "",
        "fps": 0.0,
        "source": "none"
    }

    # 1. Try Sidecar
    if metadata_path.exists():
        try:
            data = json.loads(metadata_path.read_text())
            result_metadata.update({
                "patient_name": data.get('patient_name', ''),
                "patient_id": data.get('patient_id', ''),
                "comment": f"Patient: {data.get('patient_name', '')} | ID: {data.get('patient_id', '')}",
                "recorded_at": data.get('recorded_at', ''),
                "camera_view": data.get('camera_view', ''),
                "fps": float(data.get('fps', 0)),
                "source": "sidecar"
            })
        except Exception as e:
            print(f"[Metadata] Error reading sidecar: {e}")

    # 2. Fallback to FFprobe if no sidecar data found
    if result_metadata["source"] == "none":
        try:
            import os
            ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
            ffmpeg_dir = os.path.dirname(ffmpeg_path)
            ffprobe_path = os.path.join(ffmpeg_dir, 'ffprobe.exe' if os.name == 'nt' else 'ffprobe')

            if os.path.exists(ffprobe_path):
                result = subprocess.run([
                    ffprobe_path, '-v', 'quiet', '-print_format', 'json', '-show_format', str(video_path)
                ], capture_output=True, text=True, timeout=10)

                if result.returncode == 0:
                    data = json.loads(result.stdout)
                    tags = data.get('format', {}).get('tags', {})
                    result_metadata.update({
                        "patient_name": tags.get('title', ''),
                        "patient_id": tags.get('artist', ''),
                        "comment": tags.get('comment', ''),
                        "source": "embedded"
                    })
        except Exception as e:
            print(f"[Metadata] Error reading embedded tags: {e}")

    # 3. FPS Fallback: If missing/invalid, try reading from container via OpenCV
    if result_metadata["fps"] <= 0:
        try:
            cap = cv2.VideoCapture(str(video_path))
            if cap.isOpened():
                cap_fps = cap.get(cv2.CAP_PROP_FPS)
                if cap_fps > 0:
                    result_metadata["fps"] = cap_fps
                cap.release()
        except Exception:
            pass

    # 4. Final FPS Default
    if result_metadata["fps"] <= 0:
        result_metadata["fps"] = DEFAULT_FPS

    return result_metadata




# =============================================================================
#                            TAGGING ROUTES
# =============================================================================

@app.post("/tagging/save")
def save_tagging(data: SaveTaggingRequest):
    """Save tagging logs as CSV."""
    if not data.logs:
        return {"success": False, "message": "No logs to save"}

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    video_name = data.videoFile.replace('.mp4', '')
    filename = f"tagging_{video_name}_{timestamp}.csv"
    filepath = TAGGING_DIR / filename

    headers = ['Frame', 'Direction', 'Direction_Human']
    rows = [headers]
    for log in data.logs:
        rows.append([str(log.frame), str(log.direction), log.action])

    csv_content = '\n'.join([','.join(row) for row in rows])
    filepath.write_text(csv_content)

    return {
        "success": True,
        "message": "Tagging saved",
        "filename": filename,
        "path": str(filepath)
    }


# =============================================================================
#                          PROCESSING ROUTES
# =============================================================================

@app.post("/recordings/fix-mp4-codec")
def fix_mp4_codec():
    """Re-encode MP4 files to browser-compatible H.264."""
    if not FFMPEG_AVAILABLE:
        return {"success": False, "message": "ffmpeg not available", "fixed": []}

    fixed = []
    errors = []

    for mp4_file in RECORDINGS_DIR.glob("*.mp4"):
        temp_file = mp4_file.with_suffix('.mp4.tmp')

        try:
            ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
            print(f"[FixCodec] Re-encoding {mp4_file.name}...")

            result = subprocess.run([
                ffmpeg_path, '-y', '-i', str(mp4_file),
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                str(temp_file)
            ], capture_output=True, timeout=300)

            if temp_file.exists() and temp_file.stat().st_size > 0:
                mp4_file.unlink()
                temp_file.rename(mp4_file)
                fixed.append(mp4_file.name)
                print(f"[FixCodec] Fixed {mp4_file.name}")
            else:
                stderr = result.stderr.decode() if result.stderr else "No error output"
                errors.append(f"{mp4_file.name}: {stderr[:200]}")
                if temp_file.exists():
                    temp_file.unlink()
        except Exception as e:
            errors.append(f"{mp4_file.name}: {str(e)}")
            if temp_file.exists():
                temp_file.unlink()

    return {
        "success": len(errors) == 0,
        "message": f"Fixed {len(fixed)} files",
        "fixed": fixed,
        "errors": errors
    }


@app.post("/processing/start")
def start_processing(data: ProcessRequest):
    """Start processing a video batch."""
    batch_id = data.batch_id

    camera1_bag = RECORDINGS_DIR / f"{batch_id}_camera1.bag"
    camera2_bag = RECORDINGS_DIR / f"{batch_id}_camera2.bag"
    camera1_mp4 = RECORDINGS_DIR / f"{batch_id}_camera1.mp4"
    camera2_mp4 = RECORDINGS_DIR / f"{batch_id}_camera2.mp4"

    has_cam1 = camera1_bag.exists() or camera1_mp4.exists()
    has_cam2 = camera2_bag.exists() or camera2_mp4.exists()

    if not has_cam1 and not has_cam2:
        return {"success": False, "message": "No camera files found"}

    is_processing, existing_job_id = is_batch_processing(batch_id)
    if is_processing:
        return {
            "success": False,
            "message": "Batch already being processed",
            "job_id": existing_job_id
        }

    job_id = create_processing_job(batch_id, has_cam1, has_cam2)
    is_orphan = (has_cam1 or has_cam2) and not (has_cam1 and has_cam2)

    if has_cam1:
        t1 = threading.Thread(target=process_video, args=(job_id, 1, batch_id))
        t1.start()
    if has_cam2:
        t2 = threading.Thread(target=process_video, args=(job_id, 2, batch_id))
        t2.start()

    return {
        "success": True,
        "message": f"Processing started ({'orphan' if is_orphan else 'both cameras'})",
        "job_id": job_id,
        "is_orphan": is_orphan
    }


@app.get("/processing/status/{job_id}")
def get_processing_status(job_id: str):
    """Get processing job status."""
    job = get_job(job_id)
    if not job:
        return {"success": False, "message": "Job not found"}
    return {"success": True, "job": job}


@app.post("/processing/cancel/{job_id}")
def cancel_processing(job_id: str):
    """Cancel a processing job."""
    if cancel_job(job_id):
        return {"success": True, "message": "Processing cancelled"}
    return {"success": False, "message": "Job not found"}


@app.get("/processing/jobs")
def list_processing_jobs():
    """List all processing jobs."""
    return {"jobs": get_all_jobs()}


# =============================================================================
#                        FILE MANAGEMENT ROUTES
# =============================================================================

@app.get("/files/all")
def list_all_files():
    """
    List all files organized by type.

    Videos grouped by batch showing BAG (high-quality) + MP4 preview info.
    """
    result = {
        "videos": [],
        "csvs": [],
        "jsons": []
    }

    batches: Dict[str, dict] = {}

    # Process BAG files (RealSense recordings)
    for f in RECORDINGS_DIR.glob("*.bag"):
        name = f.stem
        parts = name.rsplit('_camera', 1)
        if len(parts) == 2:
            batch_id = parts[0]
            camera_num = parts[1]

            if batch_id not in batches:
                batches[batch_id] = {
                    "batch_id": batch_id,
                    "camera1": None,
                    "camera2": None,
                    "camera1_size": 0,
                    "camera2_size": 0,
                    "camera1_hq_size": 0,
                    "camera2_hq_size": 0,
                    "camera1_mp4_size": 0,
                    "camera2_mp4_size": 0,
                    "camera1_bag_name": None,
                    "camera2_bag_name": None,
                    "camera1_type": None,
                    "camera2_type": None,
                    "modified": None
                }

            hq_size = f.stat().st_size
            mtime = datetime.fromtimestamp(f.stat().st_mtime).isoformat()

            mp4_path = RECORDINGS_DIR / f"{name}.mp4"
            mp4_size = mp4_path.stat().st_size if mp4_path.exists() else 0

            file_info = {
                "name": mp4_path.name if mp4_path.exists() else f.name,
                "size": hq_size + mp4_size
            }

            if camera_num == "1":
                batches[batch_id]["camera1"] = file_info
                batches[batch_id]["camera1_size"] = hq_size + mp4_size
                batches[batch_id]["camera1_hq_size"] = hq_size
                batches[batch_id]["camera1_mp4_size"] = mp4_size
                batches[batch_id]["camera1_bag_name"] = f.name
                batches[batch_id]["camera1_type"] = CAMERA_TYPE_REALSENSE
            elif camera_num == "2":
                batches[batch_id]["camera2"] = file_info
                batches[batch_id]["camera2_size"] = hq_size + mp4_size
                batches[batch_id]["camera2_hq_size"] = hq_size
                batches[batch_id]["camera2_mp4_size"] = mp4_size
                batches[batch_id]["camera2_bag_name"] = f.name
                batches[batch_id]["camera2_type"] = CAMERA_TYPE_REALSENSE

            if batches[batch_id]["modified"] is None or mtime > batches[batch_id]["modified"]:
                batches[batch_id]["modified"] = mtime

    # Enrich each batch with patient metadata from sidecar JSON
    for batch_id, batch in batches.items():
        meta_path = RECORDINGS_DIR / f"{batch_id}_camera1_metadata.json"
        if not meta_path.exists():
            meta_path = RECORDINGS_DIR / f"{batch_id}_camera2_metadata.json"

        batch["patient_name"] = ""
        batch["patient_id"] = ""
        batch["recorded_at"] = ""

        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                batch["patient_name"] = meta.get("patient_name", "")
                batch["patient_id"] = meta.get("patient_id", "")
                batch["recorded_at"] = meta.get("recorded_at", "")
            except Exception:
                pass

    result["videos"] = sorted(batches.values(), key=lambda x: x["modified"] or "", reverse=True)

    # CSVs
    for f in TAGGING_DIR.glob("*.csv"):
        result["csvs"].append({
            "name": f.name,
            "size": f.stat().st_size,
            "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
        })
    result["csvs"].sort(key=lambda x: x["modified"], reverse=True)

    # JSONs
    for f in PROCESSED_DIR.glob("*.json"):
        result["jsons"].append({
            "name": f.name,
            "size": f.stat().st_size,
            "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
        })
    result["jsons"].sort(key=lambda x: x["modified"], reverse=True)

    return result


# -----------------------------------------------------------------------------
#                         DELETE ENDPOINTS
# -----------------------------------------------------------------------------

@app.delete("/files/video/single/{filename}")
def delete_single_video(filename: str):
    """Delete a single video file (BAG + MP4 + metadata)."""
    deleted = []
    errors = []

    if filename.endswith('.mp4'):
        base_name = filename[:-4]
    elif filename.endswith('.bag'):
        base_name = filename[:-4]
    else:
        return {"success": False, "message": f"Invalid file type: {filename}"}

    files_to_delete = [
        f"{base_name}.bag",
        f"{base_name}.mp4",
        f"{base_name}_metadata.json"
    ]

    for file in files_to_delete:
        filepath = RECORDINGS_DIR / file
        if filepath.exists():
            try:
                filepath.unlink()
                deleted.append(file)
                print(f"[Delete] Removed: {file}")
            except Exception as e:
                errors.append(f"{file}: {str(e)}")

    if not deleted:
        return {"success": False, "message": f"No files found for: {base_name}"}

    if errors:
        return {"success": False, "deleted": deleted, "errors": errors}
    return {"success": True, "deleted": deleted, "message": f"Deleted files for {base_name}"}


@app.delete("/files/video/{batch_id}")
def delete_video_batch(batch_id: str):
    """Delete entire video batch (both cameras, BAG + MP4 + metadata)."""
    deleted = []
    errors = []

    for cam_num in [1, 2]:
        base_name = f"{batch_id}_camera{cam_num}"

        for ext in ['.bag', '.mp4', '_metadata.json']:
            filename = base_name + ext
            filepath = RECORDINGS_DIR / filename
            if filepath.exists():
                try:
                    filepath.unlink()
                    deleted.append(filename)
                except Exception as e:
                    errors.append(f"{filename}: {str(e)}")

    if errors:
        return {"success": False, "deleted": deleted, "errors": errors}
    return {"success": True, "deleted": deleted, "message": f"Deleted batch {batch_id}"}


@app.delete("/files/csv/{filename}")
def delete_csv(filename: str):
    """Delete a CSV file."""
    filepath = TAGGING_DIR / filename
    if not filepath.exists():
        return {"success": False, "message": "File not found"}
    try:
        filepath.unlink()
        return {"success": True, "message": f"Deleted {filename}"}
    except Exception as e:
        return {"success": False, "message": str(e)}


@app.delete("/files/json/{filename}")
def delete_json(filename: str):
    """Delete a JSON file."""
    filepath = PROCESSED_DIR / filename
    if not filepath.exists():
        return {"success": False, "message": "File not found"}
    try:
        filepath.unlink()
        return {"success": True, "message": f"Deleted {filename}"}
    except Exception as e:
        return {"success": False, "message": str(e)}


# -----------------------------------------------------------------------------
#                        DOWNLOAD ENDPOINTS
# -----------------------------------------------------------------------------

@app.get("/files/download/video/{filename}")
def download_video(filename: str):
    """Download a video file (MP4)."""
    filepath = RECORDINGS_DIR / filename
    if not filepath.exists():
        return JSONResponse(status_code=404, content={"error": "File not found"})
    return FileResponse(filepath, filename=filename, media_type="video/mp4")


@app.get("/files/download/bag/{filename}")
def download_bag(filename: str):
    """Download a RealSense BAG file."""
    filepath = RECORDINGS_DIR / filename
    if not filepath.exists():
        return JSONResponse(status_code=404, content={"error": "File not found"})
    return FileResponse(filepath, filename=filename, media_type="application/octet-stream")


@app.get("/files/download/csv/{filename}")
def download_csv(filename: str):
    """Download a CSV file."""
    filepath = TAGGING_DIR / filename
    if not filepath.exists():
        return JSONResponse(status_code=404, content={"error": "File not found"})
    return FileResponse(filepath, filename=filename, media_type="text/csv")


@app.get("/files/download/json/{filename}")
def download_json(filename: str):
    """Download a JSON file."""
    filepath = PROCESSED_DIR / filename
    if not filepath.exists():
        return JSONResponse(status_code=404, content={"error": "File not found"})
    return FileResponse(filepath, filename=filename, media_type="application/json")


@app.get("/files/view/json/{filename}")
def view_json(filename: str):
    """View JSON file content."""
    filepath = PROCESSED_DIR / filename
    if not filepath.exists():
        filepath = RECORDINGS_DIR / filename
        if not filepath.exists():
            return JSONResponse(status_code=404, content={"error": "File not found"})

    try:
        content = json.loads(filepath.read_text())
        return {"success": True, "filename": filename, "content": content}
    except Exception as e:
        return {"error": str(e)}
