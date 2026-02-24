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
    conversion.py  - Post-recording BAG→MP4 conversion pipeline

Camera Modes (set via CAMERA_MODE env var):
    auto           - Auto-detect RealSense cameras (DEFAULT)
    mock_bag       - RealSense .bag file playback (for dev)
    realsense      - Live RealSense cameras (force RealSense)

Recording Behavior:
    RealSense cameras:
        - .bag file (depth + RGB) only — zero-drop, SDK-managed
        - .mp4 is generated post-recording via the Conversion page

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
import os
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
    RecordingStartRequest,
    RecordingStopRequest,
    ConversionStartRequest,
)
from camera import (
    get_camera_source,
    startup_all_cameras,
    restart_all_cameras,
    shutdown_all_cameras,
    camera_sources
)
from processing import (
    process_video,
    create_processing_job,
    get_job,
    cancel_job,
    get_all_jobs,
    is_batch_processing
)
from conversion import (
    convert_bag_to_mp4,
    create_conversion_job,
    get_conversion_job,
    cancel_conversion_job,
    get_all_conversion_jobs,
    is_batch_converting,
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


@app.on_event("startup")
def on_startup():
    """Start all detected cameras on server boot."""
    startup_all_cameras()


@app.on_event("shutdown")
def on_shutdown():
    """Release all camera resources on server shutdown."""
    shutdown_all_cameras()


# =============================================================================
#                           RECORDING STATE
# =============================================================================

WARMUP_DURATION = 3  # seconds for camera auto-exposure to stabilize before writing

recording_state = {
    "status": "idle",           # idle, warming_up, recording, paused
    "start_time": None,         # Actual recording start (set after warm-up)
    "warmup_start": None,       # When warm-up began (for countdown)
    "timestamp_str": None,      # Timestamp string used for file naming
    "writers_bag": {},          # logical_cam_id -> True/None (BAG recording via pipeline)
    "filenames_bag": {},        # logical_cam_id -> filename
    "camera_types": {},         # logical_cam_id -> camera_type
    "fps_per_cam": {},          # logical_cam_id -> actual fps at recording start
    "patient_name": "",
    "patient_id": "",
    # Sync tracking
    "recording_start_times": {},    # logical_cam_id -> ISO timestamp
    "inter_camera_offset_ms": 0.0,  # ms between camera starts
    "pipeline_restart_ms": {},      # logical_cam_id -> ms for pipeline restart
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

STREAM_FPS_IDLE = 30       # Preview FPS when not recording (smooth enough)
STREAM_FPS_RECORDING = 10  # Preview FPS during recording (save CPU/bandwidth for BAG)


def gen_frames(camera_id: int):
    """
    Generate MJPEG frames from a camera.

    This stream lives as long as the HTTP connection does — it NEVER
    closes voluntarily.  If the camera is offline or restarting, the
    generator yields a placeholder frame to keep the connection alive
    and allow detection of client disconnects (via write errors).
    """
    last_good_frame = None

    # Pre-render a placeholder frame to yield when camera is not ready
    # This prevents the generator from blocking indefinitely and allows
    # the server to detect if the client has disconnected.
    placeholder = np.zeros((480, 848, 3), dtype=np.uint8)
    # Dark grey background
    placeholder[:] = (20, 20, 20)
    # Centered text
    text = "WAITING FOR CAMERA..."
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 1.0
    thickness = 2
    (text_w, text_h), _ = cv2.getTextSize(text, font, font_scale, thickness)
    text_x = (848 - text_w) // 2
    text_y = (480 + text_h) // 2
    cv2.putText(placeholder, text, (text_x, text_y), font, font_scale, (150, 150, 150), thickness)
    
    _, ph_buffer = cv2.imencode('.jpg', placeholder, [cv2.IMWRITE_JPEG_QUALITY, 60])
    ph_bytes = (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + ph_buffer.tobytes() + b'\r\n')

    while True:
        # Determine target FPS based on recording state
        is_recording = recording_state["status"] in ("recording", "warming_up", "paused")
        target_fps = STREAM_FPS_RECORDING if is_recording else STREAM_FPS_IDLE
        frame_interval = 1.0 / target_fps

        frame_start = time.monotonic()

        # Re-evaluate every frame so a camera swap is picked up immediately
        physical_id = get_physical_camera_id(camera_id)
        camera = get_camera_source(physical_id)

        frame = None

        if camera.is_running():
            ret, frame, depth = camera.read()
            if ret and frame is not None:
                last_good_frame = frame
            else:
                frame = last_good_frame
        else:
            # Camera not running — serve last good frame (or wait)
            frame = last_good_frame

        if frame is None:
            # No frame yet (camera still starting) — serve placeholder
            try:
                yield ph_bytes
                # Sleep a bit longer than normal frame interval to save bandwidth
                time.sleep(0.5)
            except (GeneratorExit, OSError):
                # Client disconnected — clean exit
                break
            continue

        try:
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        except (GeneratorExit, OSError):
            # Client disconnected (navigated away) — clean exit
            break

        elapsed = time.monotonic() - frame_start
        sleep_time = frame_interval - elapsed
        if sleep_time > 0:
            time.sleep(sleep_time)


# =============================================================================
#                          CAMERA STREAMING ROUTES
# =============================================================================

@app.get("/camera/{camera_id}")
def video_feed(camera_id: int):
    """
    Stream MJPEG video from camera 0 or 1.

    Always returns a StreamingResponse — never 503.  If the camera
    isn’t running yet, gen_frames() will wait until it comes online
    and start streaming frames as soon as they’re available.
    """
    return StreamingResponse(
        gen_frames(camera_id),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# =============================================================================
#                           RECORDING ROUTES
# =============================================================================

def _prepare_camera_recording(cam_id: int, timestamp_str: str, prepared_dict: dict):
    """
    Phase 1: Prepare a camera for recording (SLOW, ~1-3s per camera).

    Stops the current pipeline and builds a new config with recording
    enabled. Does NOT start the new pipeline — that happens in Phase 2
    (commit) after all cameras have been prepared.

    Called in parallel threads so all cameras prepare simultaneously.
    Result is stored in prepared_dict[cam_id].
    """
    physical_id = get_physical_camera_id(cam_id)
    camera = get_camera_source(physical_id)

    if not camera.is_running():
        print(f"[Recording] Logical cam {cam_id} (physical {physical_id}) offline, skipping")
        prepared_dict[cam_id] = None
        return

    camera_type = camera.camera_type
    actual_fps = camera.fps
    frame_size = camera.frame_size or (848, 480)

    print(f"[Recording] Preparing logical cam {cam_id} (physical {physical_id}): {camera_type} {frame_size}@{actual_fps}fps")

    bag_filename = f"{timestamp_str}_camera{cam_id + 1}.bag"
    bag_filepath = str(RECORDINGS_DIR / bag_filename)

    t_prepare_start = time.monotonic()
    prepared = camera.prepare_recording(bag_filepath)
    t_prepare_end = time.monotonic()
    prepare_ms = round((t_prepare_end - t_prepare_start) * 1000, 1)

    if prepared is not None:
        print(f"[Recording] Cam {cam_id} prepared in {prepare_ms}ms")
    else:
        print(f"[Recording] Cam {cam_id} prepare FAILED")

    prepared_dict[cam_id] = {
        "prepared": prepared,
        "bag_filename": bag_filename,
        "camera_type": camera_type,
        "actual_fps": actual_fps,
        "prepare_ms": prepare_ms,
    }


def _commit_camera_recording(cam_id: int, prepared_info: dict, barrier: threading.Barrier, result_dict: dict):
    """
    Phase 2: Commit recording start for a camera (FAST, ~100-300ms).

    Waits at the barrier so all cameras start simultaneously, then
    calls commit_recording() to start the pipeline.
    """
    physical_id = get_physical_camera_id(cam_id)
    camera = get_camera_source(physical_id)
    prepared = prepared_info.get("prepared")

    if prepared is None:
        result_dict[cam_id] = None
        try:
            barrier.wait(timeout=10)
        except threading.BrokenBarrierError:
            pass
        return

    try:
        # ── Synchronisation point ──────────────────────────────────────
        # All cameras wait here until every camera is ready to start.
        barrier.wait(timeout=10)
        # ──────────────────────────────────────────────────────────────
    except threading.BrokenBarrierError:
        print(f"[Recording] Barrier broken for cam {cam_id}")
        result_dict[cam_id] = None
        return

    t_commit_start = time.monotonic()
    bag_success = camera.commit_recording(prepared)
    t_commit_end = time.monotonic()
    commit_ms = round((t_commit_end - t_commit_start) * 1000, 1)

    recording_started_at = datetime.now().isoformat()

    if bag_success:
        print(f"[Recording] Cam {cam_id} committed in {commit_ms}ms")
    else:
        print(f"[Recording] Cam {cam_id} commit FAILED")

    result_dict[cam_id] = {
        "bag_filename": prepared_info["bag_filename"] if bag_success else None,
        "bag_success": bag_success,
        "camera_type": prepared_info["camera_type"],
        "actual_fps": prepared_info["actual_fps"],
        # Sync tracking — monotonic timestamps for inter-camera offset calculation
        "recording_start_mono": t_commit_end if bag_success else None,
        "recording_start_iso": recording_started_at if bag_success else None,
        "pipeline_restart_ms": round(prepared_info["prepare_ms"] + commit_ms, 1),
        "commit_ms": commit_ms,
    }


def _initialize_recording():
    """
    Start BAG recording for all active cameras using barrier synchronisation.

    Two-phase start:
        Phase 1 (PREPARE): Both cameras stop their old pipelines and build
                           new configs in PARALLEL. This is the slow part
                           (~1-3s per camera) but runs concurrently.
        Phase 2 (COMMIT):  Both cameras wait at a threading.Barrier, then
                           call pipeline.start() simultaneously. This is
                           fast (~100-300ms) and synchronised.

    This reduces the inter-camera start offset from ~2s (sequential) to
    <100ms (the difference in pipeline.start() time between cameras).
    """
    with recording_lock:
        if recording_state["status"] != "warming_up":
            print("[Recording] Warm-up cancelled before recording started")
            return
        timestamp_str = recording_state["timestamp_str"]

    # ── Phase 1: PREPARE both cameras in parallel ──
    prepared_dict: dict = {}
    prep_threads = []
    for cam_id in [0, 1]:
        t = threading.Thread(
            target=_prepare_camera_recording,
            args=(cam_id, timestamp_str, prepared_dict),
            daemon=True,
        )
        prep_threads.append(t)
        t.start()

    for t in prep_threads:
        t.join()

    # Filter out cameras that couldn't prepare (offline or failed)
    ready_cams = {
        cid: info for cid, info in prepared_dict.items()
        if info is not None and info.get("prepared") is not None
    }

    if not ready_cams:
        print("[Recording] No cameras ready for recording")
        with recording_lock:
            if recording_state["status"] == "warming_up":
                recording_state["status"] = "idle"
        return

    # ── Phase 2: COMMIT all cameras simultaneously via barrier ──
    barrier = threading.Barrier(len(ready_cams))
    cam_info: dict = {}
    commit_threads = []
    for cam_id, info in ready_cams.items():
        t = threading.Thread(
            target=_commit_camera_recording,
            args=(cam_id, info, barrier, cam_info),
            daemon=True,
        )
        commit_threads.append(t)
        t.start()

    for t in commit_threads:
        t.join()

    # Drop cameras that failed to commit
    cam_info = {k: v for k, v in cam_info.items() if v is not None}

    with recording_lock:
        if recording_state["status"] != "warming_up":
            # Cancelled during startup — stop any BAG pipelines that started
            for cam_id, info in cam_info.items():
                if info.get("bag_success"):
                    try:
                        get_camera_source(get_physical_camera_id(cam_id)).stop_recording()
                    except Exception:
                        pass
            print("[Recording] Warm-up cancelled during recording startup")
            return

        for cam_id, info in cam_info.items():
            recording_state["writers_bag"][cam_id] = info["bag_success"]
            recording_state["filenames_bag"][cam_id] = info["bag_filename"]
            recording_state["camera_types"][cam_id] = info["camera_type"]
            recording_state["fps_per_cam"][cam_id] = info["actual_fps"]

        # Compute inter-camera start offset using monotonic timestamps
        start_monos = {
            cid: info["recording_start_mono"]
            for cid, info in cam_info.items()
            if info.get("recording_start_mono") is not None
        }
        inter_camera_offset_ms = 0.0
        if len(start_monos) == 2:
            vals = list(start_monos.values())
            inter_camera_offset_ms = round(abs(vals[0] - vals[1]) * 1000, 1)
            print(f"[Recording] Inter-camera start offset: {inter_camera_offset_ms}ms")

        recording_state["recording_start_times"] = {
            cid: info.get("recording_start_iso") for cid, info in cam_info.items()
        }
        recording_state["inter_camera_offset_ms"] = inter_camera_offset_ms
        recording_state["pipeline_restart_ms"] = {
            cid: info.get("pipeline_restart_ms", 0) for cid, info in cam_info.items()
        }

        recording_state["status"] = "recording"
        recording_state["start_time"] = datetime.now()
        print(f"[Recording] Recording started (barrier-synced, offset: {inter_camera_offset_ms}ms)")


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
        recording_state["patient_id"] = data.patientId if data else ""
        recording_state["timestamp_str"] = timestamp_str
        recording_state["warmup_start"] = timestamp
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
    """
    Pause recording — pauses BAG writing on all active cameras.

    The RealSense pipeline stays running (MJPEG streaming continues)
    but frames are no longer written to disk. This gives a true pause
    so the resulting BAG has no gap/filler frames.
    """
    with recording_lock:
        if recording_state["status"] != "recording":
            return {"status": recording_state["status"], "message": "Not recording"}
        recording_state["status"] = "paused"

    # Pause BAG recording on all active cameras (outside lock to avoid blocking)
    for cam_id in list(recording_state["writers_bag"].keys()):
        if recording_state["writers_bag"].get(cam_id):
            physical_cam = get_camera_source(get_physical_camera_id(cam_id))
            if not physical_cam.pause_recording():
                print(f"[Recording] Warning: failed to pause BAG on cam {cam_id}")

    return {"status": "paused", "message": "Recording paused (BAG writing stopped)"}


@app.post("/recording/resume")
def resume_recording():
    """
    Resume recording — resumes BAG writing on all active cameras.

    Both cameras are resumed in parallel to minimise inter-camera
    resume offset.
    """
    with recording_lock:
        if recording_state["status"] != "paused":
            return {"status": recording_state["status"], "message": "Not paused"}
        recording_state["status"] = "recording"

    # Resume BAG recording on all active cameras
    for cam_id in list(recording_state["writers_bag"].keys()):
        if recording_state["writers_bag"].get(cam_id):
            physical_cam = get_camera_source(get_physical_camera_id(cam_id))
            if not physical_cam.resume_recording():
                print(f"[Recording] Warning: failed to resume BAG on cam {cam_id}")

    return {"status": "recording", "message": "Recording resumed"}


@app.post("/recording/stop")
def stop_recording(data: RecordingStopRequest = None):
    """
    Stop recording and save BAG files with metadata sidecars.

    If called during warm-up, cancels before any writers are created.
    BAG pipelines for both cameras are stopped in parallel to minimise
    the inter-camera stop-time offset.

    MP4 files are NOT created here — use the Conversion page post-recording.
    """
    bag_files = []
    patient_id = ""
    camera_types = {}
    fps_per_cam = {}

    with recording_lock:
        if recording_state["status"] == "idle":
            return {"status": "idle", "message": "No recording is active"}

        if recording_state["status"] == "warming_up":
            recording_state["status"] = "idle"
            recording_state["warmup_start"] = None
            recording_state["timestamp_str"] = None
            recording_state["camera_types"] = {}
            recording_state["fps_per_cam"] = {}
            recording_state["patient_id"] = ""
            recording_state["recording_start_times"] = {}
            recording_state["inter_camera_offset_ms"] = 0.0
            recording_state["pipeline_restart_ms"] = {}
            print("[Recording] Warm-up cancelled by stop request")
            return {
                "status": "idle",
                "message": "Recording cancelled during warm-up",
                "bag_files": [],
                "path": str(RECORDINGS_DIR)
            }

        # Atomically read all state and clear in one lock acquisition
        patient_id = recording_state.get("patient_id", "")
        camera_types = recording_state.get("camera_types", {}).copy()
        fps_per_cam = recording_state.get("fps_per_cam", {}).copy()
        writers_bag = dict(recording_state["writers_bag"])
        filenames_bag = dict(recording_state["filenames_bag"])
        inter_camera_offset_ms = recording_state.get("inter_camera_offset_ms", 0.0)
        recording_start_times = recording_state.get("recording_start_times", {}).copy()
        pipeline_restart_ms = recording_state.get("pipeline_restart_ms", {}).copy()

        # Clear state immediately to prevent concurrent operations
        recording_state["status"] = "idle"
        recording_state["start_time"] = None
        recording_state["warmup_start"] = None
        recording_state["timestamp_str"] = None
        recording_state["writers_bag"] = {}
        recording_state["filenames_bag"] = {}
        recording_state["camera_types"] = {}
        recording_state["fps_per_cam"] = {}
        recording_state["patient_id"] = ""
        recording_state["recording_start_times"] = {}
        recording_state["inter_camera_offset_ms"] = 0.0
        recording_state["pipeline_restart_ms"] = {}

    # ----- Stop BAG recordings in PARALLEL -----
    stop_timestamps: dict = {}  # cam_id -> ISO timestamp when recording actually stopped

    def _stop_cam_resources(cam_id: int):
        """Stop BAG recording for one camera and collect the filename."""
        is_recording = writers_bag.get(cam_id, False)
        if is_recording:
            print(f"[Recording] Stopping BAG recording logical cam {cam_id}")
            try:
                physical_cam = get_camera_source(get_physical_camera_id(cam_id))
                physical_cam.stop_recording()
                stop_timestamps[cam_id] = datetime.now().isoformat()
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

    stop_threads = [
        threading.Thread(target=_stop_cam_resources, args=(c,), daemon=True)
        for c in list(writers_bag.keys())
    ]
    for t in stop_threads:
        t.start()
    for t in stop_threads:
        t.join()

    # ----- Rename BAG files with Note and CF/CS -----
    note = data.note.strip() if data and data.note else ""
    # Sanitize note
    import re
    safe_note = re.sub(r'[^\w\-_]', '', note)
    
    renamed_bag_files = []
    
    for bag_file in bag_files:
        old_path = RECORDINGS_DIR / bag_file
        
        # Parse timestamp and camera
        # Expected format: YYYY-MM-DD_HH-MM-SS_cameraX.bag
        parts = bag_file.split('_camera')
        if len(parts) == 2:
            timestamp_part = parts[0]
            cam_suffix = parts[1] # "1.bag" or "2.bag"
            
            cam_label = "CF" if cam_suffix.startswith("1") else "CS"
            
            if safe_note:
                new_filename = f"{timestamp_part}_{cam_label}_{safe_note}.bag"
            else:
                new_filename = f"{timestamp_part}_{cam_label}.bag"
                
            new_path = RECORDINGS_DIR / new_filename
            
            try:
                os.rename(old_path, new_path)
                print(f"[Recording] Renamed {bag_file} -> {new_filename}")
                renamed_bag_files.append(new_filename)
            except OSError as e:
                print(f"[Recording] Rename failed for {bag_file}: {e}")
                renamed_bag_files.append(bag_file) # Keep old name if fail
        else:
            renamed_bag_files.append(bag_file)

    bag_files = renamed_bag_files

    # Save metadata sidecar for each BAG file — includes sync tracking data
    # and hardware timestamps for post-hoc alignment
    for bag_file in bag_files:
        base_name = bag_file.replace('.bag', '')
        metadata_file = f"{base_name}_metadata.json"
        metadata_path = RECORDINGS_DIR / metadata_file

        if '_CF' in base_name or '_camera1' in base_name:
            cam_id = 0
            camera_view = "Front"
        elif '_CS' in base_name or '_camera2' in base_name:
            cam_id = 1
            camera_view = "Side"
        else:
            cam_id = -1
            camera_view = "Unknown"

        cam_type = camera_types.get(cam_id, CAMERA_TYPE_REALSENSE)
        
        # Read hardware timestamps from camera for post-hoc sync alignment
        physical_cam = get_camera_source(get_physical_camera_id(cam_id))
        first_hw_ts = physical_cam.get_first_hw_timestamp()
        last_hw_ts = physical_cam.get_last_hw_timestamp()
        hw_ts_domain = physical_cam.get_hw_timestamp_domain()
        frames_at_stop = physical_cam.get_recording_frame_count()

        metadata_content = {
            "patient_id": patient_id,
            "note": note,
            "bag_file": bag_file,
            "camera_type": cam_type,
            "camera_view": camera_view,
            "fps": fps_per_cam.get(cam_id, DEFAULT_FPS),
            "recorded_at": datetime.now().isoformat(),
            "camera_mode": CAMERA_MODE,
            # Sync tracking — per-camera start/stop times and inter-camera offset
            "recording_started_at": recording_start_times.get(cam_id),
            "recording_stopped_at": stop_timestamps.get(cam_id),
            "inter_camera_offset_ms": inter_camera_offset_ms,
            "pipeline_restart_ms": pipeline_restart_ms.get(cam_id, 0),
            # Hardware timestamps for post-hoc alignment between cameras
            "first_hw_timestamp": first_hw_ts,
            "last_hw_timestamp": last_hw_ts,
            "hw_timestamp_domain": hw_ts_domain,
            "frames_at_stop": frames_at_stop,
            # MP4 fields — populated by conversion.py after BAG→MP4 conversion
            "mp4_file": None,
            "mp4_frames": None,
            "mp4_source": None,
            "converted_at": None,
            # Timing fields
            "conversion_duration_s": None,
            "processing_duration_s": None,
            "total_duration_s": None,
        }
        metadata_path.write_text(json.dumps(metadata_content, indent=2))
        print(f"[Recording] Metadata saved: {metadata_file}")

    return {
        "status": "idle",
        "message": "Recording stopped",
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
        current_filenames: dict of "camN_bag" -> filename (populated after warm-up)
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
        for cam_id, fname in recording_state["filenames_bag"].items():
            if fname:
                current_filenames[f"cam{cam_id}_bag"] = fname

        return {
            "status": status,
            "patient_name": recording_state["patient_name"],
            "patient_id": recording_state["patient_id"],
            "start_time": start_time.isoformat() if start_time else None,
            "duration": duration,
            "warmup_remaining": warmup_remaining,
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






@app.post("/cameras/restart")
def restart_cameras():
    """
    Hard restart: stop all cameras → USB settle → re-detect → restart.

    This is the "nuclear option" triggered ONLY by the user clicking
    the Restart button.  Takes several seconds due to USB settle time.
    """
    restart_all_cameras()

    detected = get_detected_cameras()
    return {
        "message": f"Cameras restarted — {len(detected)} camera(s) found",
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

        if "_camera1" in f.stem or "_CF" in f.stem:
            cam_type = "Front"
        elif "_camera2" in f.stem or "_CS" in f.stem:
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
        # Try both formats:
        # Old: YYYY-MM-DD_HH-MM-SS_camera1.bag
        # New: YYYY-MM-DD_HH-MM-SS_CF_note.bag
        
        parts_old = name.rsplit('_camera', 1)
        
        batch_id = ""
        camera_num = ""
        
        if len(parts_old) == 2:
             batch_id = parts_old[0]
             camera_num = parts_old[1] # "1" or "2"
        else:
             # Try new format
             # Split by _CF or _CS
             if "_CF" in name:
                 parts_new = name.split('_CF')
                 batch_id = parts_new[0]
                 camera_num = "1"
             elif "_CS" in name:
                 parts_new = name.split('_CS')
                 batch_id = parts_new[0]
                 camera_num = "2"
        
        if batch_id and camera_num:
            if batch_id not in batches:
                batches[batch_id] = {
                    "batch_id": batch_id,
                    "camera1": None,
                    "camera2": None,
                    "camera1_hq": None,
                    "camera2_hq": None,
                    "camera1_has_mp4": False,
                    "camera2_has_mp4": False,
                    "camera1_type": None,
                    "camera2_type": None,
                    "complete": False,
                    "orphaned": False,
                    "type": "batch",
                    "modified": None
                }

            mp4_file = RECORDINGS_DIR / f"{name}.mp4"
            mp4_exists = mp4_file.exists()
            if camera_num == "1":
                batches[batch_id]["camera1_hq"] = f.name
                batches[batch_id]["camera1"] = mp4_file.name if mp4_exists else f.name
                batches[batch_id]["camera1_has_mp4"] = mp4_exists
                batches[batch_id]["camera1_type"] = CAMERA_TYPE_REALSENSE
            elif camera_num == "2":
                batches[batch_id]["camera2_hq"] = f.name
                batches[batch_id]["camera2"] = mp4_file.name if mp4_exists else f.name
                batches[batch_id]["camera2_has_mp4"] = mp4_exists
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
        meta_path = None
        
        # Try to find metadata from actual bag filenames
        if batch.get("camera1_hq"):
             bag_name = batch["camera1_hq"]
             # Strip extension
             base_name = os.path.splitext(bag_name)[0]
             possible_meta = RECORDINGS_DIR / f"{base_name}_metadata.json"
             if possible_meta.exists():
                 meta_path = possible_meta
        
        if not meta_path and batch.get("camera2_hq"):
             bag_name = batch["camera2_hq"]
             base_name = os.path.splitext(bag_name)[0]
             possible_meta = RECORDINGS_DIR / f"{base_name}_metadata.json"
             if possible_meta.exists():
                 meta_path = possible_meta
        
        # Fallback to legacy naming if somehow not found
        if not meta_path:
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
            "bag_expected_frames": None,
            "bag_dropped_frames": None,
            "real_fps": None,
            "frame_difference": None,
            "drop_rate_percent": None,
            "fps": DEFAULT_FPS,
        }

        # Read FPS, sync data, and MP4 frame count from sidecar
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                cam_result["fps"] = meta.get("fps", DEFAULT_FPS)
                sidecar_mp4_frames = meta.get("mp4_frames")
                if sidecar_mp4_frames:
                    cam_result["mp4_frames_from_sidecar"] = sidecar_mp4_frames
                # Sync tracking data from recording
                cam_result["recording_started_at"] = meta.get("recording_started_at")
                cam_result["recording_stopped_at"] = meta.get("recording_stopped_at")
                cam_result["inter_camera_offset_ms"] = meta.get("inter_camera_offset_ms", 0)
                cam_result["pipeline_restart_ms"] = meta.get("pipeline_restart_ms", 0)
                # True hardware FPS and drops
                cam_result["bag_expected_frames"] = meta.get("expected_frames")
                cam_result["bag_dropped_frames"] = meta.get("dropped_frames")
                cam_result["real_fps"] = meta.get("real_fps")
                # Hardware timestamps for post-hoc alignment
                cam_result["first_hw_timestamp"] = meta.get("first_hw_timestamp")
                cam_result["last_hw_timestamp"] = meta.get("last_hw_timestamp")
                cam_result["hw_timestamp_domain"] = meta.get("hw_timestamp_domain")
                cam_result["frames_at_stop"] = meta.get("frames_at_stop")
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
    cam1_bag_frames = results.get("camera1", {}).get("bag_frames")
    cam2_bag_frames = results.get("camera2", {}).get("bag_frames")
    sync_info = {}
    if cam1_frames and cam2_frames:
        fps = results.get("camera1", {}).get("fps") or DEFAULT_FPS

        sync_info["cam1_mp4_frames"] = cam1_frames
        sync_info["cam2_mp4_frames"] = cam2_frames
        sync_info["frame_count_difference"] = abs(cam1_frames - cam2_frames)
        sync_info["time_offset_seconds"] = round(
            abs(cam1_frames - cam2_frames) / fps if fps > 0 else 0, 3
        )

        # BAG-level frame sync (before conversion — more reliable)
        if cam1_bag_frames and cam2_bag_frames:
            sync_info["cam1_bag_frames"] = cam1_bag_frames
            sync_info["cam2_bag_frames"] = cam2_bag_frames
            sync_info["bag_frame_count_difference"] = abs(cam1_bag_frames - cam2_bag_frames)
            sync_info["bag_time_offset_seconds"] = round(
                abs(cam1_bag_frames - cam2_bag_frames) / fps if fps > 0 else 0, 3
            )

        # Inter-camera recording start offset (from metadata — ground truth)
        inter_offset = results.get("camera1", {}).get("inter_camera_offset_ms", 0)
        if not inter_offset:
            inter_offset = results.get("camera2", {}).get("inter_camera_offset_ms", 0)
        sync_info["recording_start_offset_ms"] = inter_offset

        # Pipeline restart times per camera
        sync_info["cam1_pipeline_restart_ms"] = results.get("camera1", {}).get("pipeline_restart_ms", 0)
        sync_info["cam2_pipeline_restart_ms"] = results.get("camera2", {}).get("pipeline_restart_ms", 0)

        # Sync assessment — considers both frame count diff and recording start offset
        frame_offset_ok = sync_info["frame_count_difference"] <= int(fps)  # within 1 second
        start_offset_ok = inter_offset <= 500  # within 500ms
        sync_info["in_sync"] = frame_offset_ok and start_offset_ok

        # Sync quality level for UI
        if inter_offset <= 100 and sync_info["frame_count_difference"] <= int(fps * 0.5):
            sync_info["sync_quality"] = "excellent"  # <100ms offset, <0.5s frame diff
        elif frame_offset_ok and start_offset_ok:
            sync_info["sync_quality"] = "good"
        elif frame_offset_ok or start_offset_ok:
            sync_info["sync_quality"] = "fair"
        else:
            sync_info["sync_quality"] = "poor"

        # Warning if bags themselves weren't synced (impacts MP4 sync too)
        if not start_offset_ok:
            sync_info["warning"] = (
                f"Cameras started {inter_offset:.0f}ms apart. "
                "MP4 files inherit this offset — they cannot be more synced than the source BAGs. "
                "No hardware sync cable available."
            )

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
    Serve video file with range request support.

    Uses Starlette's FileResponse which handles:
        - Accept-Ranges headers automatically
        - Byte-range requests for seeking
        - Kernel-level sendfile() for efficient I/O
        - No Python thread blocking during transfer
    """
    video_path = RECORDINGS_DIR / video_name

    if not video_path.exists():
        return JSONResponse(status_code=404, content={"error": "Video not found"})

    media_type = "video/mp4" if video_name.endswith('.mp4') else "application/octet-stream"

    # FileResponse handles range requests, Accept-Ranges, and Content-Length
    # automatically via Starlette internals. Much more efficient than our
    # custom chunk_generator + StreamingResponse approach.
    return FileResponse(
        path=str(video_path),
        media_type=media_type,
        filename=video_name,
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
#                        CONVERSION ROUTES
# =============================================================================

@app.post("/conversion/start")
def start_conversion(data: ConversionStartRequest):
    """
    Start BAG→MP4 conversion for a batch.

    Both cameras of the batch are converted in parallel. Batches are sequential
    (only one batch can convert at a time per job). Uses h264_nvenc on Jetson
    (NVENC hardware encoder), falls back to libx264 if unavailable.

    Set force=True to re-convert even if an MP4 already exists.
    """
    batch_id = data.batch_id

    # Check both old naming (_camera1/_camera2) and new naming (_CF/_CS)
    camera1_bag = RECORDINGS_DIR / f"{batch_id}_camera1.bag"
    camera2_bag = RECORDINGS_DIR / f"{batch_id}_camera2.bag"
    has_cam1 = camera1_bag.exists()
    has_cam2 = camera2_bag.exists()

    if not has_cam1:
        candidates = list(RECORDINGS_DIR.glob(f"{batch_id}_CF*.bag"))
        if candidates:
            has_cam1 = True
    if not has_cam2:
        candidates = list(RECORDINGS_DIR.glob(f"{batch_id}_CS*.bag"))
        if candidates:
            has_cam2 = True

    if not has_cam1 and not has_cam2:
        return {"success": False, "message": "No BAG files found for this batch"}

    is_converting, existing_job_id = is_batch_converting(batch_id)
    if is_converting:
        return {
            "success": False,
            "message": "Batch already being converted",
            "job_id": existing_job_id
        }

    job_id = create_conversion_job(batch_id, has_cam1, has_cam2, force=data.force)
    is_orphan = (has_cam1 or has_cam2) and not (has_cam1 and has_cam2)

    t = threading.Thread(
        target=convert_bag_to_mp4,
        args=(job_id, batch_id, has_cam1, has_cam2),
        daemon=True,
    )
    t.start()

    return {
        "success": True,
        "message": f"Conversion started ({'orphan' if is_orphan else 'both cameras'})",
        "job_id": job_id,
        "is_orphan": is_orphan,
    }


@app.get("/conversion/status/{job_id}")
def get_conversion_status(job_id: str):
    """Get conversion job status."""
    job = get_conversion_job(job_id)
    if not job:
        return {"success": False, "message": "Job not found"}
    return {"success": True, "job": job}


@app.post("/conversion/cancel/{job_id}")
def cancel_conversion(job_id: str):
    """Cancel a conversion job."""
    if cancel_conversion_job(job_id):
        return {"success": True, "message": "Conversion cancelled"}
    return {"success": False, "message": "Job not found"}


@app.get("/conversion/jobs")
def list_conversion_jobs():
    """List all conversion jobs."""
    return {"jobs": get_all_conversion_jobs()}


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
        # Try both formats:
        # Old: YYYY-MM-DD_HH-MM-SS_camera1.bag
        # New: YYYY-MM-DD_HH-MM-SS_CF_note.bag
        
        parts_old = name.rsplit('_camera', 1)
        
        batch_id = ""
        camera_num = ""
        
        if len(parts_old) == 2:
             batch_id = parts_old[0]
             camera_num = parts_old[1] # "1" or "2"
        else:
             # Try new format
             if "_CF" in name:
                 parts_new = name.split('_CF')
                 batch_id = parts_new[0]
                 camera_num = "1"
             elif "_CS" in name:
                 parts_new = name.split('_CS')
                 batch_id = parts_new[0]
                 camera_num = "2"
        
        if batch_id and camera_num:
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
                    "camera1_has_mp4": False,
                    "camera2_has_mp4": False,
                    "camera1_bag_name": None,
                    "camera2_bag_name": None,
                    "camera1_type": None,
                    "camera2_type": None,
                    "modified": None
                }

            hq_size = f.stat().st_size
            mtime = datetime.fromtimestamp(f.stat().st_mtime).isoformat()

            mp4_path = RECORDINGS_DIR / f"{name}.mp4"
            mp4_exists = mp4_path.exists()
            mp4_size = mp4_path.stat().st_size if mp4_exists else 0

            file_info = {
                "name": mp4_path.name if mp4_exists else f.name,
                "size": hq_size + mp4_size
            }

            if camera_num == "1":
                batches[batch_id]["camera1"] = file_info
                batches[batch_id]["camera1_size"] = hq_size + mp4_size
                batches[batch_id]["camera1_hq_size"] = hq_size
                batches[batch_id]["camera1_mp4_size"] = mp4_size
                batches[batch_id]["camera1_has_mp4"] = mp4_exists
                batches[batch_id]["camera1_bag_name"] = f.name
                batches[batch_id]["camera1_type"] = CAMERA_TYPE_REALSENSE
            elif camera_num == "2":
                batches[batch_id]["camera2"] = file_info
                batches[batch_id]["camera2_size"] = hq_size + mp4_size
                batches[batch_id]["camera2_hq_size"] = hq_size
                batches[batch_id]["camera2_mp4_size"] = mp4_size
                batches[batch_id]["camera2_has_mp4"] = mp4_exists
                batches[batch_id]["camera2_bag_name"] = f.name
                batches[batch_id]["camera2_type"] = CAMERA_TYPE_REALSENSE

            if batches[batch_id]["modified"] is None or mtime > batches[batch_id]["modified"]:
                batches[batch_id]["modified"] = mtime

    # Enrich each batch with patient metadata from sidecar JSON
    for batch_id, batch in batches.items():
        meta_path = None
        
        # Try to find metadata from actual bag filenames
        if batch.get("camera1_bag_name"):
             bag_name = batch["camera1_bag_name"]
             base_name = os.path.splitext(bag_name)[0]
             possible_meta = RECORDINGS_DIR / f"{base_name}_metadata.json"
             if possible_meta.exists():
                 meta_path = possible_meta
        
        if not meta_path and batch.get("camera2_bag_name"):
             bag_name = batch["camera2_bag_name"]
             base_name = os.path.splitext(bag_name)[0]
             possible_meta = RECORDINGS_DIR / f"{base_name}_metadata.json"
             if possible_meta.exists():
                 meta_path = possible_meta

        # Fallback to legacy naming (only if no valid path found above)
        if not meta_path or not meta_path.exists():
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

    # Old naming: {batch_id}_camera1.bag, {batch_id}_camera2.bag
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

    # New naming: {batch_id}_CF*.bag, {batch_id}_CS*.bag (and matching .mp4, _metadata.json)
    for suffix in ["CF", "CS"]:
        for f in RECORDINGS_DIR.glob(f"{batch_id}_{suffix}*"):
            try:
                f.unlink()
                deleted.append(f.name)
            except Exception as e:
                errors.append(f"{f.name}: {str(e)}")

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
