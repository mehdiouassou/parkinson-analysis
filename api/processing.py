"""
Video Processing Pipeline

Real frame-by-frame processing for Parkinson's motion analysis:
    - Pose keypoint detection (17 points via YOLOv8-Pose / TensorRT)
    - Motion detection between frames
    - Tremor analysis (nose jitter)

All metrics are computed from actual frame data using YOLOv8-Pose on GPU.
"""

import cv2
import json
import math
import numpy as np
import os
import threading
import uuid
from datetime import datetime
from typing import Dict, Tuple, Optional

from config import RECORDINGS_DIR, PROCESSED_DIR, MODELS_DIR, DEFAULT_FPS

# Try to import pyrealsense2 for BAG file processing
try:
    import pyrealsense2 as rs
    HAS_REALSENSE = True
except ImportError:
    HAS_REALSENSE = False
    print("[Processing] pyrealsense2 not available - BAG file processing disabled")

# --- GPU AI ENGINE (YOLOv8-Pose via TensorRT) ---
try:
    from ultralytics import YOLO
    HAS_GPU_AI = True
    print("[Processing] YOLOv8 (GPU) Available")
except ImportError:
    HAS_GPU_AI = False
    print("[Processing] YOLOv8 not installed.")

MODEL_PATH = MODELS_DIR / "yolov8n-pose.engine"
if HAS_GPU_AI and not MODEL_PATH.exists():
    # Fallback to .pt if TensorRT engine not found
    fallback_path = MODELS_DIR / "yolov8n-pose.pt"
    if fallback_path.exists():
        MODEL_PATH = fallback_path
        print(f"[Processing] TensorRT engine not found, falling back to {MODEL_PATH}")
    else:
        print(f"[Processing] Warning: Neither .engine nor .pt model found. Will attempt to download .pt on first use.")
        MODEL_PATH = fallback_path

ai_model = YOLO(str(MODEL_PATH)) if HAS_GPU_AI else None


# =============================================================================
#        ANALYSIS CONFIGURATION — Tweak these to change pipeline behaviour
#        without touching any other code.
# =============================================================================

ANALYSIS_CONFIG = {
    # ---- Model / Inference ----
    # GPU device ID passed to YOLO. 0 = first GPU. "cpu" = CPU-only.
    "yolo_device": 0,

    # Print YOLO inference details per frame (noisy; useful for debugging).
    "yolo_verbose": False,

    # ---- Keypoints to track for motion calculation ----
    # Subset of the 5 head keypoints returned by extract_yolo_landmarks().
    # Available keys: "nose", "left_eye", "right_eye", "ears"
    # Removing a key reduces noise but also reduces tracking signal.
    "motion_keypoints": ["nose", "left_eye", "right_eye", "ears"],

    # ---- Tremor analysis ----
    # Nose jitter variance thresholds that determine severity label.
    # Lower the values if the patient walks slowly (less expected motion).
    "tremor_thresholds": {
        "mild":     1.0,   # variance < mild     → "None"
        "moderate": 5.0,   # mild ≤ variance < moderate → "Mild"
        "severe":  20.0,   # moderate ≤ variance < severe → "Moderate"
                           # variance ≥ severe → "Severe"
    },

    # ---- Motion score normalisation ----
    # movement_score = avg_motion / movement_score_scale (clamped to [0, 1]).
    # Increase if subjects move very fast and scores saturate at 1.0.
    "movement_score_scale": 5.0,

    # ---- Progress / output ----
    # How often to save a landmark sample in the JSON output.
    # 1 = every frame (large files), 10 = every 10th frame (default).
    "landmark_sample_every_n_frames": 10,

    # Maximum number of frame_data entries written to the JSON report.
    # Keeps report files manageable without losing analytics data.
    "max_frame_data_in_report": 50,

    # How often (in frames) to update the UI progress bar.
    "progress_update_every_n_frames": 10,

    # Timeout when waiting for the next BAG frame (milliseconds).
    "bag_frame_timeout_ms": 5000,
}
"""
Central configuration for the analysis pipeline.  Edit the values in this
dict — **without touching any other code** — to tune the pipeline behaviour:

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Key
     - Default
     - Description
   * - ``yolo_device``
     - ``0``
     - GPU device ID for YOLO inference (``0`` = first GPU, ``"cpu"`` = CPU-only).
   * - ``yolo_verbose``
     - ``False``
     - Print per-frame inference details (noisy; useful for debugging).
   * - ``motion_keypoints``
     - *5 head kps*
     - Subset of head keypoints used for motion calculation.
       Available: ``"nose"``, ``"left_eye"``, ``"right_eye"``, ``"ears"``.
   * - ``tremor_thresholds``
     - mild/mod/sev
     - Nose-jitter variance thresholds that determine severity label.
       Lower values if the patient walks slowly.
   * - ``movement_score_scale``
     - ``5.0``
     - Divides ``avg_motion`` to produce a 0–1 movement score.
       Increase if scores saturate at 1.0 for fast-moving subjects.
   * - ``landmark_sample_every_n_frames``
     - ``10``
     - How often a landmark sample is saved to the JSON output.
       ``1`` = every frame (large files).
   * - ``max_frame_data_in_report``
     - ``50``
     - Maximum ``frame_data`` entries in the JSON report.
   * - ``progress_update_every_n_frames``
     - ``10``
     - How often (in frames) the UI progress bar is updated.
   * - ``bag_frame_timeout_ms``
     - ``5000``
     - Timeout (ms) waiting for the next BAG frame before giving up.
"""


# =============================================================================
#                           PROCESSING JOB STATE
# =============================================================================

processing_jobs: Dict[str, dict] = {}
processing_lock = threading.Lock()


# =============================================================================
#                          BAG FILE READER
# =============================================================================

class BagFileReader:
    """
    Read frames from a RealSense BAG file.
    Provides an iterator interface similar to cv2.VideoCapture.
    """
    
    def __init__(self, bag_path: str):
        if not HAS_REALSENSE:
            raise RuntimeError("pyrealsense2 not available")
        
        self.bag_path = bag_path
        self.pipeline = rs.pipeline()
        self.config = rs.config()
        
        # Enable playback from BAG file
        rs.config.enable_device_from_file(self.config, bag_path, repeat_playback=False)
        
        # Start pipeline
        self.profile = self.pipeline.start(self.config)
        
        # Get playback device to control playback
        self.playback = self.profile.get_device().as_playback()
        self.playback.set_real_time(False)  # Don't limit to real-time speed
        
        # Get video stream info
        color_stream = self.profile.get_stream(rs.stream.color).as_video_stream_profile()
        self.width = color_stream.width()
        self.height = color_stream.height()
        self.fps = color_stream.fps()
        
        # Estimate frame count from duration
        # BAG files don't directly expose frame count, so we estimate
        self._frame_count = None
        self._frames_read = 0
        self._is_open = True
    
    def isOpened(self) -> bool:
        return self._is_open
    
    def get(self, prop: int):
        """Mimic cv2.VideoCapture.get() for common properties."""
        if prop == cv2.CAP_PROP_FRAME_WIDTH:
            return self.width
        elif prop == cv2.CAP_PROP_FRAME_HEIGHT:
            return self.height
        elif prop == cv2.CAP_PROP_FPS:
            return self.fps
        elif prop == cv2.CAP_PROP_FRAME_COUNT:
            # Estimate based on duration - may not be accurate
            return self._frame_count or -1
        return 0
    
    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        """Read next frame, returns (success, frame) like cv2.VideoCapture."""
        if not self._is_open:
            return False, None
        
        try:
            frames = self.pipeline.wait_for_frames(timeout_ms=ANALYSIS_CONFIG["bag_frame_timeout_ms"])
            color_frame = frames.get_color_frame()
            
            if not color_frame:
                return False, None
            
            # Convert to numpy array (BGR format for OpenCV compatibility)
            frame = np.asanyarray(color_frame.get_data())
            
            # RealSense gives RGB, OpenCV expects BGR
            if len(frame.shape) == 3 and frame.shape[2] == 3:
                frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            
            self._frames_read += 1
            return True, frame
            
        except RuntimeError:
            # End of file or error
            self._is_open = False
            return False, None
    
    def release(self):
        """Stop pipeline and cleanup."""
        if self._is_open:
            try:
                self.pipeline.stop()
            except:
                pass
            self._is_open = False
    
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()
        return False


# =============================================================================
#                          PROGRESS HELPERS
# =============================================================================

def update_job_progress(job_id: str, camera_num: int, progress: int, step_name: str):
    """Update processing job progress."""
    with processing_lock:
        if job_id in processing_jobs:
            processing_jobs[job_id][f"camera{camera_num}_progress"] = progress
            processing_jobs[job_id][f"camera{camera_num}_step"] = step_name


def check_job_cancelled(job_id: str) -> bool:
    """Check if job was cancelled."""
    with processing_lock:
        if job_id not in processing_jobs:
            return True
        return processing_jobs[job_id]["status"] == "cancelled"


# =============================================================================
#                     POSE KEYPOINT DETECTION (YOLOv8-Pose)
# =============================================================================

# YOLOv8-Pose returns 17 COCO keypoints. We use the first 5 (head region):
#   0: Nose, 1: Left Eye, 2: Right Eye, 3: Left Ear, 4: Right Ear
YOLO_KEYPOINT_NAMES = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"]


def extract_yolo_landmarks(results):
    """
    Extract pose keypoints from YOLOv8-Pose results.

    YOLO Pose returns 17 keypoints per person.
    Indices: 0:Nose, 1:L-Eye, 2:R-Eye, 3:L-Ear, 4:R-Ear

    Returns:
        Dictionary with named keypoint groups, or None if no person detected.
    """
    if not results or len(results) == 0:
        return None

    # Get the first person detected
    if not results[0].keypoints or not results[0].keypoints.xy.numel():
        return None

    keypoints = results[0].keypoints.xy.cpu().numpy()[0]

    # Check if we have enough points (at least 5 for face)
    if keypoints.shape[0] < 5:
        return None

    landmarks = {
        "nose": [{"x": float(keypoints[0][0]), "y": float(keypoints[0][1])}],
        "left_eye": [{"x": float(keypoints[1][0]), "y": float(keypoints[1][1])}],
        "right_eye": [{"x": float(keypoints[2][0]), "y": float(keypoints[2][1])}],
        "ears": [
            {"x": float(keypoints[3][0]), "y": float(keypoints[3][1])},  # Left Ear
            {"x": float(keypoints[4][0]), "y": float(keypoints[4][1])}   # Right Ear
        ]
    }
    return landmarks


def analyze_tremor_yolo(history: list) -> float:
    """Simple tremor detection based on Nose X/Y movement variance (jitter)."""
    if len(history) < 10:
        return 0.0

    nose_x = [frame["nose"][0]["x"] for frame in history if frame and "nose" in frame]

    if not nose_x:
        return 0.0
    variance = np.var(nose_x)
    return float(variance)


def calculate_keypoint_motion(prev_landmarks: dict, curr_landmarks: dict) -> dict:
    """
    Calculate motion between two frames based on YOLO keypoint positions.

    Returns:
        Dictionary with total, average, and max motion across tracked keypoints.
    """
    if not prev_landmarks or not curr_landmarks:
        return {"total_motion": 0, "average_motion": 0, "max_point_motion": 0, "points_tracked": 0}

    total_motion = 0.0
    point_motions = []

    # Use only the configured keypoints for motion calculation
    motion_kps = ANALYSIS_CONFIG.get("motion_keypoints", ["nose", "left_eye", "right_eye", "ears"])

    for key in [k for k in ["nose", "left_eye", "right_eye"] if k in motion_kps]:
        prev_pts = prev_landmarks.get(key, [])
        curr_pts = curr_landmarks.get(key, [])
        if prev_pts and curr_pts:
            # Check if either point has zero confidence (failed detection)
            # YOLOv8-Pose usually gives (0,0) with conf < threshold
            # Assume we only use points with valid confidence if available, 
            # or check coordinates > 0
            if (curr_pts[0]["x"] > 0 or curr_pts[0]["y"] > 0) and \
               (prev_pts[0]["x"] > 0 or prev_pts[0]["y"] > 0):
                dx = curr_pts[0]["x"] - prev_pts[0]["x"]
                dy = curr_pts[0]["y"] - prev_pts[0]["y"]
                dist = np.sqrt(dx * dx + dy * dy)
                point_motions.append(dist)
                total_motion += dist

    # Ears (list of 2) — optional based on config
    if "ears" in motion_kps:
        prev_ears = prev_landmarks.get("ears", [])
        curr_ears = curr_landmarks.get("ears", [])
        for i in range(min(len(prev_ears), len(curr_ears))):
            if (curr_ears[i]["x"] > 0 or curr_ears[i]["y"] > 0) and \
               (prev_ears[i]["x"] > 0 or prev_ears[i]["y"] > 0):
                dx = curr_ears[i]["x"] - prev_ears[i]["x"]
                dy = curr_ears[i]["y"] - prev_ears[i]["y"]
                dist = np.sqrt(dx * dx + dy * dy)
                point_motions.append(dist)
                total_motion += dist

    avg_motion = total_motion / max(len(point_motions), 1)
    max_motion = max(point_motions) if point_motions else 0

    return {
        "total_motion": round(total_motion, 3),
        "average_motion": round(avg_motion, 3),
        "max_point_motion": round(max_motion, 3),
        "points_tracked": len(point_motions)
    }


# =============================================================================
#                       MAIN PROCESSING PIPELINE
# =============================================================================

def process_video(job_id: str, camera_num: int, batch_id: str):
    """
    Process a video file with real frame-by-frame analysis.
    
    Processing Pipeline:
        1. Load video and metadata
        2. Apply warm color filter to each frame
        3. Calculate per-frame metrics (brightness, color, edges)
        4. Calculate inter-frame motion
        5. Detect tremor patterns from motion history
        6. Aggregate all metrics into final report
    
    Args:
        job_id: Processing job identifier
        camera_num: Camera number (1 or 2)
        batch_id: Video batch ID (timestamp prefix)
    """
    start_time = time.time()
    try:
        # Priority: BAG (RealSense depth + RGB) > MP4 (compressed preview)
        cam_key = f"camera{camera_num}"
        
        # Default assumption: old naming convention
        bag_file = RECORDINGS_DIR / f"{batch_id}_{cam_key}.bag"
        
        # If not found, check for new naming convention (CF/CS)
        if not bag_file.exists():
            suffix = "CF" if camera_num == 1 else "CS"
            # Pattern: YYYY-MM-DD_HH-MM-SS_CF_note.bag or just _CF.bag
            candidates = list(RECORDINGS_DIR.glob(f"{batch_id}_{suffix}*.bag"))
            if candidates:
                bag_file = candidates[0]
                print(f"[Processing] Found renamed bag for {cam_key}: {bag_file.name}")
            else:
                # If still not found, check if it's the old naming but maybe with extra suffix? Unlikely but safe.
                # Actually, if we didn't find the bag, we might still find an MP4 later.
                pass

        base_name = bag_file.stem
        mp4_file = RECORDINGS_DIR / f"{base_name}.mp4"
        metadata_file = RECORDINGS_DIR / f"{base_name}_metadata.json"

        # Determine which file to use
        video_file = None
        use_bag = False

        if bag_file.exists() and HAS_REALSENSE:
            video_file = bag_file
            use_bag = True
        elif mp4_file.exists():
            video_file = mp4_file
        else:
            # Try finding just MP4 if bag missing
             if not mp4_file.exists():
                suffix = "CF" if camera_num == 1 else "CS"
                candidates = list(RECORDINGS_DIR.glob(f"{batch_id}_{suffix}*.mp4"))
                if candidates:
                    mp4_file = candidates[0]
                    video_file = mp4_file
                    metadata_file = RECORDINGS_DIR / f"{mp4_file.stem}_metadata.json"
             
             if not video_file or not video_file.exists():
                raise FileNotFoundError(f"No video file found for {batch_id} camera {camera_num}")
        
        
        
        # ---------------------------------------------------------------------
        #                    STEP 1: Initialize (0-5%)
        # ---------------------------------------------------------------------

        update_job_progress(job_id, camera_num, 2, "Initializing...")


        # ---------------------------------------------------------------------
        #               STEP 2: Load Patient Metadata (5-8%)
        # Load metadata FIRST so the recorded FPS is available as a fallback
        # when the video container does not embed FPS (can happen with BAG
        # files or improperly muxed MP4s).
        # ---------------------------------------------------------------------

        update_job_progress(job_id, camera_num, 5, "Loading metadata...")

        patient_info = {"patient_name": "", "patient_id": "", "recorded_at": ""}
        meta_fps: float | None = None
        if metadata_file.exists():
            try:
                patient_info = json.loads(metadata_file.read_text())
                raw_meta_fps = patient_info.get("fps")
                if raw_meta_fps and float(raw_meta_fps) > 0:
                    meta_fps = float(raw_meta_fps)
            except Exception:
                pass


        # ---------------------------------------------------------------------
        #                  STEP 3: Load Video (8-12%)
        # ---------------------------------------------------------------------

        if use_bag:
            format_used = "BAG (RealSense)"
        else:
            format_used = "MP4"

        update_job_progress(job_id, camera_num, 8, f"Opening video ({format_used})...")

        if not video_file.exists():
            raise FileNotFoundError(f"Video file not found: {video_file}")

        # Use appropriate reader based on file type
        if use_bag:
            cap = BagFileReader(str(video_file))
            # BAG files don't expose frame count easily, estimate based on duration
            total_frames = -1  # Unknown, will count during processing
        else:
            cap = cv2.VideoCapture(str(video_file))
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if not cap.isOpened():
            raise RuntimeError(f"Failed to open video: {video_file}")

        # Prefer the value saved in the metadata sidecar (exact recording FPS)
        # if available. Fall back to the video container FPS, then to
        # DEFAULT_FPS.
        cap_fps = cap.get(cv2.CAP_PROP_FPS)
        fps = meta_fps if meta_fps and meta_fps > 0 else (cap_fps if cap_fps > 0 else DEFAULT_FPS)

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        duration = total_frames / fps if total_frames > 0 and fps > 0 else 0

        video_info = {
            "frames": total_frames,
            "fps": fps,
            "width": width,
            "height": height,
            "duration": duration,
            "format": format_used
        }

        if total_frames > 0:
            update_job_progress(job_id, camera_num, 12, f"Loaded {total_frames} frames @ {fps:.0f} fps")
        else:
            update_job_progress(job_id, camera_num, 12, f"Loaded {format_used} stream @ {fps:.0f} fps")
        
        
        # ---------------------------------------------------------------------
        #          STEP 4: Process Frames (12-90%) - YOLO POSE DETECTION
        # ---------------------------------------------------------------------

        update_job_progress(job_id, camera_num, 13, "Processing frames with pose detection...")

        if not HAS_GPU_AI or ai_model is None:
            raise RuntimeError("YOLOv8-Pose not available. Cannot process video without GPU AI engine.")

        # Accumulators for metrics
        frame_landmarks_list = []  # Store landmarks for each frame (sampled)
        landmark_history = []      # Recent landmarks for tremor analysis
        motion_history = []
        persons_detected = 0
        persons_not_detected = 0

        prev_landmarks = None
        frames_processed = 0

        while True:
            if check_job_cancelled(job_id):
                cap.release()
                return

            ret, frame = cap.read()
            if not ret:
                break

            frame_data = {
                "frame_number": frames_processed,
                "person_detected": False,
                "landmarks": None,
                "motion": None
            }

            # Run YOLOv8-Pose inference on GPU
            results = ai_model(
                frame,
                verbose=ANALYSIS_CONFIG["yolo_verbose"],
                device=ANALYSIS_CONFIG["yolo_device"],
            )
            landmarks = extract_yolo_landmarks(results)

            if landmarks is not None:
                persons_detected += 1
                frame_data["person_detected"] = True

                # Store for tremor analysis
                landmark_history.append(landmarks)

                # Calculate motion from previous frame
                if prev_landmarks is not None:
                    motion = calculate_keypoint_motion(prev_landmarks, landmarks)
                    motion_history.append(motion)
                    frame_data["motion"] = motion

                prev_landmarks = landmarks

                # Sample landmarks (configurable interval to keep JSON size manageable)
                sample_interval = ANALYSIS_CONFIG["landmark_sample_every_n_frames"]
                if frames_processed % sample_interval == 0:
                    frame_data["landmarks"] = landmarks
                    frame_landmarks_list.append(frame_data)
            else:
                persons_not_detected += 1
                prev_landmarks = None

            frames_processed += 1

            # Update progress (12% to 90% = 78% range for frame processing)
            if frames_processed % ANALYSIS_CONFIG["progress_update_every_n_frames"] == 0:
                if total_frames > 0:
                    progress = 12 + int((frames_processed / total_frames) * 78)
                    progress = min(progress, 89)
                    frame_msg = f"Frame {frames_processed}/{total_frames} (detections: {persons_detected})"
                else:
                    REF_FRAMES = 6000
                    progress = 12 + int(78 * math.log1p(frames_processed) / math.log1p(REF_FRAMES))
                    progress = min(progress, 89)
                    frame_msg = f"Frame {frames_processed} (detections: {persons_detected})"

                update_job_progress(job_id, camera_num, progress, frame_msg)

        cap.release()

        # Update total_frames now that we know the actual count
        if total_frames <= 0:
            total_frames = frames_processed

        # Update video_info with actual values now that processing is complete
        video_info["frames"] = total_frames
        video_info["duration"] = total_frames / fps if fps > 0 else 0


        # ---------------------------------------------------------------------
        #              STEP 5: Compute Final Metrics (90-95%)
        # ---------------------------------------------------------------------

        update_job_progress(job_id, camera_num, 91, "Computing final metrics...")

        # Person detection rate
        total_detection_frames = persons_detected + persons_not_detected
        detection_rate = persons_detected / max(total_detection_frames, 1)

        # Motion statistics
        if motion_history:
            avg_motions = [m.get("average_motion", 0) for m in motion_history]
            avg_motion = float(np.mean(avg_motions))
            motion_std = float(np.std(avg_motions))
            motion_max = float(np.max(avg_motions))
            motion_min = float(np.min(avg_motions))
        else:
            avg_motion = motion_std = motion_max = motion_min = 0.0

        # Tremor analysis (nose jitter variance) using configurable thresholds
        tremor_variance = analyze_tremor_yolo(landmark_history)
        tt = ANALYSIS_CONFIG["tremor_thresholds"]
        tremor_severity = (
            "None"     if tremor_variance < tt["mild"]
            else "Mild"     if tremor_variance < tt["moderate"]
            else "Moderate" if tremor_variance < tt["severe"]
            else "Severe"
        )

        # Movement score (0-1, higher = more movement) with configurable scale
        movement_score = min(1.0, avg_motion / ANALYSIS_CONFIG["movement_score_scale"])


        # ---------------------------------------------------------------------
        #               STEP 6: Generate Report (95-100%)
        # ---------------------------------------------------------------------

        update_job_progress(job_id, camera_num, 96, "Generating report...")

        # BAG vs MP4 frame comparison (for drop-rate analysis)
        mp4_path = RECORDINGS_DIR / f"{batch_id}_camera{camera_num}.mp4"
        mp4_frame_count = None
        if mp4_path.exists():
            try:
                _cap_mp4 = cv2.VideoCapture(str(mp4_path))
                mp4_frame_count = int(_cap_mp4.get(cv2.CAP_PROP_FRAME_COUNT))
                _cap_mp4.release()
            except Exception:
                pass

        # Also read mp4_frames from the metadata sidecar if OpenCV reports 0
        if not mp4_frame_count:
            try:
                meta_file = RECORDINGS_DIR / f"{batch_id}_camera{camera_num}_metadata.json"
                if meta_file.exists():
                    _meta = json.loads(meta_file.read_text())
                    mp4_frame_count = _meta.get("mp4_frames")
            except Exception:
                pass

        bag_frame_count = frames_processed if use_bag else None
        frame_drop_info = {}
        if use_bag and bag_frame_count and mp4_frame_count:
            diff = bag_frame_count - mp4_frame_count
            frame_drop_info = {
                "bag_frames": bag_frame_count,
                "mp4_frames": mp4_frame_count,
                "frames_dropped": max(0, diff),
                "drop_rate_percent": round(max(0, diff) / bag_frame_count * 100, 2) if bag_frame_count > 0 else 0,
                "note": "BAG is ground truth; MP4 may drop frames under CPU/IO load"
            }

        result_data = {
            "batch_id": batch_id,
            "camera": camera_num,
            "camera_type": "sagittale" if camera_num == 1 else "frontale",
            "processed_at": datetime.now().isoformat(),

            "patient": {
                "name": patient_info.get("patient_name", ""),
                "id": patient_info.get("patient_id", ""),
                "recorded_at": patient_info.get("recorded_at", "")
            },

            "video": {
                "file": video_file.name,
                "format": format_used,
                "frames": video_info["frames"],
                "frames_processed": frames_processed,
                "duration_seconds": round(video_info["duration"], 2),
                "fps": video_info["fps"],
                "resolution": f"{video_info['width']}x{video_info['height']}"
            },

            # Frame comparison between BAG source and MP4 preview
            "frame_comparison": frame_drop_info,

            "pose_detection": {
                "persons_detected": persons_detected,
                "persons_not_detected": persons_not_detected,
                "detection_rate": round(detection_rate * 100, 1),
                "engine": "YOLOv8-Pose (TensorRT/GPU)" if HAS_GPU_AI else "N/A"
            },

            "pose_keypoints": {
                "keypoints_per_person": 17,
                "tracked_regions": YOLO_KEYPOINT_NAMES,
                "motion_keypoints_used": ANALYSIS_CONFIG["motion_keypoints"],
                "sampled_frames": len(frame_landmarks_list)
            },

            "motion_analysis": {
                "average_motion": round(avg_motion, 3),
                "max_motion": round(motion_max, 3),
                "min_motion": round(motion_min, 3),
                "standard_deviation": round(motion_std, 3),
                "movement_score": round(movement_score, 3)
            },

            "tremor_analysis": {
                "nose_jitter_variance": round(tremor_variance, 4),
                "severity": tremor_severity,
                "thresholds_used": ANALYSIS_CONFIG["tremor_thresholds"]
            },

            "frame_data": frame_landmarks_list[:ANALYSIS_CONFIG["max_frame_data_in_report"]],

            "status": "completed"
        }

        # --- TIMING LOGIC ---
        end_time = time.time()
        duration = round(end_time - start_time, 2)
        
        if metadata_file.exists():
            try:
                meta = json.loads(metadata_file.read_text())
                meta["processing_duration_s"] = duration
                
                conv_dur = meta.get("conversion_duration_s")
                if conv_dur:
                     meta["total_duration_s"] = round(duration + float(conv_dur), 2)
                     
                metadata_file.write_text(json.dumps(meta, indent=2))
                print(f"[Processing] Updated metadata with duration: {duration}s")
            except Exception as e:
                print(f"[Processing] Failed to update metadata duration: {e}")
        
        # Save analysis result
        result_filename = f"{batch_id}_camera{camera_num}_analysis.json"
        result_path = PROCESSED_DIR / result_filename
        result_path.write_text(json.dumps(result_data, indent=2))
        print(f"[Processing] Saved: {result_path}")
        
        update_job_progress(job_id, camera_num, 100, "Complete")
        
        
        # ---------------------------------------------------------------------
        #                      Mark Job Complete
        # ---------------------------------------------------------------------
        
        with processing_lock:
            if job_id in processing_jobs:
                processing_jobs[job_id][f"camera{camera_num}_status"] = "completed"
                processing_jobs[job_id][f"camera{camera_num}_result"] = result_filename
                
                # Check if all cameras are done (completed or skipped)
                cam1_done = processing_jobs[job_id].get("camera1_status") in ["completed", "skipped"]
                cam2_done = processing_jobs[job_id].get("camera2_status") in ["completed", "skipped"]
                
                if cam1_done and cam2_done:
                    processing_jobs[job_id]["status"] = "completed"
                    
    except Exception as e:
        print(f"[Processing] Error for camera {camera_num}: {e}")
        with processing_lock:
            if job_id in processing_jobs:
                processing_jobs[job_id][f"camera{camera_num}_status"] = "error"
                processing_jobs[job_id][f"camera{camera_num}_error"] = str(e)

                # Only mark overall job as error if the other camera is also done
                other_cam = 1 if camera_num == 2 else 2
                other_status = processing_jobs[job_id].get(f"camera{other_cam}_status", "skipped")
                if other_status in ("completed", "skipped", "error", "cancelled"):
                    # Both cameras are done - mark overall based on results
                    if other_status == "completed":
                        processing_jobs[job_id]["status"] = "completed"  # partial success
                    else:
                        processing_jobs[job_id]["status"] = "error"


# =============================================================================
#                          JOB MANAGEMENT
# =============================================================================

def create_processing_job(batch_id: str, has_cam1: bool, has_cam2: bool) -> str:
    """
    Create a new processing job.
    
    Args:
        batch_id: Video batch ID
        has_cam1: Whether camera 1 file exists
        has_cam2: Whether camera 2 file exists
    
    Returns:
        Job ID
    """
    job_id = str(uuid.uuid4())[:8]
    is_orphan = (has_cam1 or has_cam2) and not (has_cam1 and has_cam2)
    
    with processing_lock:
        processing_jobs[job_id] = {
            "job_id": job_id,
            "batch_id": batch_id,
            "status": "processing",
            "started_at": datetime.now().isoformat(),
            "is_orphan": is_orphan,
            "camera1_progress": 0 if has_cam1 else -1,
            "camera2_progress": 0 if has_cam2 else -1,
            "camera1_status": "processing" if has_cam1 else "skipped",
            "camera2_status": "processing" if has_cam2 else "skipped",
            "camera1_step": "Initializing..." if has_cam1 else "No file",
            "camera2_step": "Initializing..." if has_cam2 else "No file",
            "camera1_result": None,
            "camera2_result": None
        }
    
    return job_id


def get_job(job_id: str) -> dict:
    """Get processing job by ID."""
    with processing_lock:
        return processing_jobs.get(job_id, {}).copy()


def cancel_job(job_id: str) -> bool:
    """Cancel a processing job."""
    with processing_lock:
        if job_id not in processing_jobs:
            return False
        processing_jobs[job_id]["status"] = "cancelled"
        processing_jobs[job_id]["camera1_status"] = "cancelled"
        processing_jobs[job_id]["camera2_status"] = "cancelled"
    return True


def get_all_jobs() -> list:
    """Get all processing jobs."""
    with processing_lock:
        return list(processing_jobs.values())


def is_batch_processing(batch_id: str) -> tuple:
    """Check if batch is already being processed."""
    with processing_lock:
        for job_id, job in processing_jobs.items():
            if job["batch_id"] == batch_id and job["status"] in ["processing", "pending"]:
                return True, job_id
    return False, None
