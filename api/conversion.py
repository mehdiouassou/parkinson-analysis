"""
Post-recording BAG→MP4 Conversion Pipeline
==========================================

Converts recorded RealSense .bag files to browser-playable .mp4 using FFmpeg.
Encoder priority: h264_nvenc (Jetson NVENC hardware) → libx264 (CPU fallback).

Safety: writes to <name>.mp4.converting temp file first, renames to .mp4 only
on success, deletes on failure — no partial MP4 files are ever left on disk.

Job lifecycle:
    pending → converting → done | failed | cancelled

Both cameras of a batch are converted in PARALLEL; batches are sequential
(the API caller is responsible for not starting two batches concurrently —
is_batch_converting() can be used to guard against that).
"""

import json
import os
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np

from config import (
    RECORDINGS_DIR,
    FFMPEG_AVAILABLE,
    imageio_ffmpeg,
    REALSENSE_AVAILABLE,
    rs,
    DEFAULT_FPS,
    CAMERA_TYPE_REALSENSE,
    CAMERA_MODE,
)


# =============================================================================
#                              JOB STATE
# =============================================================================

conversion_jobs: Dict[str, dict] = {}
conversion_lock = threading.Lock()


def _make_cam_slot(enabled: bool) -> Optional[dict]:
    if not enabled:
        return None
    return {
        "enabled": True,
        "status": "pending",       # pending | skipped | converting | done | failed | cancelled
        "progress": 0,             # 0–100 percent
        "frames_written": 0,
        "total_frames": 0,
        "encoder": None,           # "h264_nvenc" or "libx264" — filled when conversion starts
        "error": None,
        "mp4_file": None,
        "output_size_mb": None,
    }


def create_conversion_job(
    batch_id: str, has_cam1: bool, has_cam2: bool, force: bool = False
) -> str:
    """Create and register a new conversion job. Returns job_id."""
    job_id = str(uuid.uuid4())
    with conversion_lock:
        conversion_jobs[job_id] = {
            "job_id": job_id,
            "batch_id": batch_id,
            "status": "pending",      # pending | converting | done | failed | cancelled
            "force": force,
            "created_at": datetime.now().isoformat(),
            "completed_at": None,
            "camera1": _make_cam_slot(has_cam1),
            "camera2": _make_cam_slot(has_cam2),
            "cancelled": False,
        }
    return job_id


def get_conversion_job(job_id: str) -> Optional[dict]:
    """Return job dict or None if not found."""
    with conversion_lock:
        return conversion_jobs.get(job_id)


def cancel_conversion_job(job_id: str) -> bool:
    """Signal cancellation. Returns False if job not found."""
    with conversion_lock:
        job = conversion_jobs.get(job_id)
        if not job:
            return False
        job["cancelled"] = True
        if job["status"] in ("pending", "converting"):
            job["status"] = "cancelled"
        return True


def get_all_conversion_jobs() -> list:
    """Return all jobs (newest first by created_at)."""
    with conversion_lock:
        jobs = list(conversion_jobs.values())
    return sorted(jobs, key=lambda j: j.get("created_at", ""), reverse=True)


def is_batch_converting(batch_id: str) -> Tuple[bool, Optional[str]]:
    """Check if a batch is currently being converted. Returns (is_converting, job_id)."""
    with conversion_lock:
        for job_id, job in conversion_jobs.items():
            if job["batch_id"] == batch_id and job["status"] == "converting":
                return True, job_id
    return False, None


# =============================================================================
#                         CONVERSION HELPERS
# =============================================================================

def _get_ffmpeg_path() -> Optional[str]:
    """Return path to FFmpeg binary or None if not available."""
    if not FFMPEG_AVAILABLE or imageio_ffmpeg is None:
        return None
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _count_bag_frames(bag_path: Path) -> int:
    """
    Count color frames in a BAG by replaying at non-realtime speed.
    Fast pass — does not decode pixel data; just counts framesets.
    Returns 0 on error.
    """
    if not REALSENSE_AVAILABLE or rs is None:
        return 0

    frame_count = 0
    pipeline = rs.pipeline()
    try:
        config = rs.config()
        rs.config.enable_device_from_file(config, str(bag_path), repeat_playback=False)
        config.enable_stream(rs.stream.color)
        profile = pipeline.start(config)
        playback = profile.get_device().as_playback()
        playback.set_real_time(False)

        while True:
            try:
                frames = pipeline.wait_for_frames(timeout_ms=2000)
                if frames.get_color_frame():
                    frame_count += 1
            except RuntimeError:
                break  # End of file
    except Exception as e:
        print(f"[Conversion] BAG frame count error for {bag_path.name}: {e}")
    finally:
        try:
            pipeline.stop()
        except Exception:
            pass

    return frame_count


def _update_metadata_sidecar(
    meta_path: Path,
    mp4_file: str,
    mp4_frames: int,
    *,
    patient_name: str = "",
    patient_id: str = "",
    camera_view: str = "",
    camera_type: str = CAMERA_TYPE_REALSENSE,
    fps: float = DEFAULT_FPS,
    camera_mode: str = "",
    recorded_at: str = "",
    bag_file: str = "",
):
    """
    Update (or create) the metadata sidecar JSON after successful conversion.
    Merges conversion results into existing metadata, preserving all prior fields.
    """
    meta: dict = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except Exception:
            pass

    # Stamp conversion results
    meta["mp4_file"] = mp4_file
    meta["mp4_frames"] = mp4_frames
    meta["mp4_source"] = "converted"
    meta["converted_at"] = datetime.now().isoformat()

    # Fill in any fields missing from an older sidecar (or brand-new file)
    meta.setdefault("patient_name", patient_name)
    meta.setdefault("patient_id", patient_id)
    meta.setdefault("camera_view", camera_view)
    meta.setdefault("camera_type", camera_type)
    meta.setdefault("fps", fps)
    meta.setdefault("camera_mode", camera_mode)
    meta.setdefault("recorded_at", recorded_at)
    meta.setdefault("bag_file", bag_file or meta_path.stem.replace("_metadata", "") + ".bag")

    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"[Conversion] Metadata updated: {meta_path.name}")


# =============================================================================
#                        PER-CAMERA CONVERSION
# =============================================================================

def _convert_single_camera(job_id: str, cam_num: int, batch_id: str):
    """
    Convert one camera's BAG to MP4.

    Writes to <name>.mp4.converting, renames to .mp4 on success, deletes on failure.
    Tries h264_nvenc first (Jetson NVENC), falls back to libx264.
    Updates conversion_jobs[job_id] in-place.
    """
    cam_key = f"camera{cam_num}"
    bag_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}.bag"
    mp4_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}.mp4"
    temp_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}.mp4.converting"
    meta_path = RECORDINGS_DIR / f"{batch_id}_{cam_key}_metadata.json"

    # ---- Helpers ----

    def _update(updates: dict):
        with conversion_lock:
            job = conversion_jobs.get(job_id)
            if job and job.get(cam_key):
                job[cam_key].update(updates)

    def _is_cancelled() -> bool:
        with conversion_lock:
            job = conversion_jobs.get(job_id)
            return job is None or job.get("cancelled", False)

    def _cleanup_temp():
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass

    # ---- Guards ----

    if not bag_path.exists():
        _update({"status": "failed", "error": f"BAG not found: {bag_path.name}"})
        return

    with conversion_lock:
        job = conversion_jobs.get(job_id)
        force = job.get("force", False) if job else False

    if mp4_path.exists() and not force:
        print(f"[Conversion] {cam_key}: MP4 already exists, skipping (force=False)")
        _update({"status": "skipped", "mp4_file": mp4_path.name, "progress": 100})
        _update_metadata_sidecar(meta_path, mp4_path.name, 0)
        return

    ffmpeg_path = _get_ffmpeg_path()
    if not ffmpeg_path:
        _update({"status": "failed", "error": "FFmpeg not available"})
        return

    # ---- Read metadata sidecar ----

    fps: float = DEFAULT_FPS
    camera_view = "Front" if cam_num == 1 else "Side"
    patient_name = patient_id = camera_mode = recorded_at = ""
    camera_type = CAMERA_TYPE_REALSENSE

    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            fps = float(meta.get("fps", DEFAULT_FPS))
            camera_view = meta.get("camera_view", camera_view)
            patient_name = meta.get("patient_name", "")
            patient_id = meta.get("patient_id", "")
            camera_type = meta.get("camera_type", camera_type)
            camera_mode = meta.get("camera_mode", "")
            recorded_at = meta.get("recorded_at", "")
        except Exception:
            pass

    # ---- Count total frames (for progress reporting) ----

    print(f"[Conversion] {cam_key}: Counting BAG frames...")
    _update({"status": "converting", "progress": 0})
    total_frames = _count_bag_frames(bag_path)
    print(f"[Conversion] {cam_key}: {total_frames} frames in BAG")
    _update({"total_frames": total_frames})

    if _is_cancelled():
        _update({"status": "cancelled"})
        return

    # ---- Encoder loop — try NVENC first, then libx264 ----

    encoder_configs = [
        (
            "h264_nvenc",
            ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"],
        ),
        (
            "libx264",
            ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p"],
        ),
    ]

    import subprocess

    for encoder_name, encode_args in encoder_configs:
        if _is_cancelled():
            _update({"status": "cancelled"})
            return

        _cleanup_temp()
        print(f"[Conversion] {cam_key}: Trying encoder {encoder_name}...")
        _update({"encoder": encoder_name})

        # ---- Read BAG and pipe frames ----
        pipeline = rs.pipeline()
        config = rs.config()
        frames_written = 0
        bag_read_ok = False
        ffmpeg_proc = None  # Started lazily on first frame (need actual dims)

        try:
            rs.config.enable_device_from_file(config, str(bag_path), repeat_playback=False)
            # No format/resolution/fps constraints — SDK uses native BAG format.
            # Specifying constraints here causes "Couldn't resolve requests" when
            # they don't exactly match what was recorded.
            config.enable_stream(rs.stream.color)
            profile = pipeline.start(config)
            playback = profile.get_device().as_playback()
            playback.set_real_time(False)

            # Read actual fps/dims from the BAG stream profile — ground truth
            stream_profile = profile.get_stream(rs.stream.color).as_video_stream_profile()
            actual_fps = stream_profile.fps() or fps
            actual_w = stream_profile.width()
            actual_h = stream_profile.height()
            print(f"[Conversion] {cam_key}: BAG stream {actual_w}x{actual_h} @ {actual_fps}fps")

            ffmpeg_cmd = [
                ffmpeg_path, "-y",
                "-f", "rawvideo", "-vcodec", "rawvideo",
                "-s", f"{actual_w}x{actual_h}",
                "-pix_fmt", "bgr24",
                "-r", str(int(actual_fps)),
                "-i", "pipe:0",
                *encode_args,
                "-movflags", "+faststart",
                "-f", "mp4",
                str(temp_path),
            ]
            ffmpeg_proc = subprocess.Popen(
                ffmpeg_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )

            last_progress_report = time.time()

            while True:
                if _is_cancelled():
                    break
                try:
                    frames = pipeline.wait_for_frames(timeout_ms=2000)
                    color_frame = frames.get_color_frame()
                    if not color_frame:
                        continue
                    frame_data = np.asanyarray(color_frame.get_data())

                    ffmpeg_proc.stdin.write(frame_data.tobytes())
                    frames_written += 1

                    now = time.time()
                    if now - last_progress_report > 0.5:
                        progress = int(frames_written / total_frames * 100) if total_frames > 0 else 0
                        _update({"frames_written": frames_written, "progress": min(99, progress)})
                        last_progress_report = now
                except RuntimeError:
                    break  # End of BAG

            bag_read_ok = True

        except Exception as e:
            print(f"[Conversion] {cam_key}: BAG read error ({encoder_name}): {e}")
        finally:
            try:
                pipeline.stop()
            except Exception:
                pass
            if ffmpeg_proc is not None:
                try:
                    ffmpeg_proc.stdin.close()
                except Exception:
                    pass
                _, ffmpeg_stderr = ffmpeg_proc.communicate()
                if not bag_read_ok and ffmpeg_stderr:
                    print(
                        f"[Conversion] {cam_key}: FFmpeg stderr ({encoder_name}): "
                        f"{ffmpeg_stderr.decode(errors='replace')[-500:]}"
                    )

        # Handle cancellation mid-pipe
        if _is_cancelled():
            _cleanup_temp()
            _update({"status": "cancelled"})
            return

        if not bag_read_ok:
            _cleanup_temp()
            continue  # Try next encoder

        # Validate output file exists and is non-empty
        if not temp_path.exists() or temp_path.stat().st_size == 0:
            print(f"[Conversion] {cam_key}: Output missing or empty ({encoder_name})")
            _cleanup_temp()
            continue

        # Frame count validation: ≥95% of BAG frames must be in the MP4
        mp4_frames = 0
        try:
            import cv2
            cap = cv2.VideoCapture(str(temp_path))
            mp4_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.release()
        except Exception:
            pass

        if total_frames > 0 and mp4_frames < int(total_frames * 0.95):
            print(
                f"[Conversion] {cam_key}: Frame validation failed "
                f"({mp4_frames}/{total_frames}, {encoder_name})"
            )
            _cleanup_temp()
            continue

        # ---- Success: rename temp → final ----
        try:
            if mp4_path.exists():
                mp4_path.unlink()
            temp_path.rename(mp4_path)
        except Exception as e:
            print(f"[Conversion] {cam_key}: Rename failed: {e}")
            _cleanup_temp()
            _update({"status": "failed", "error": str(e)})
            return

        output_size_mb = round(mp4_path.stat().st_size / (1024 * 1024), 1)
        print(
            f"[Conversion] {cam_key}: Done — {frames_written} frames → "
            f"{mp4_path.name} ({output_size_mb} MB, {encoder_name})"
        )

        _update({
            "status": "done",
            "progress": 100,
            "frames_written": frames_written,
            "mp4_file": mp4_path.name,
            "output_size_mb": output_size_mb,
        })

        _update_metadata_sidecar(
            meta_path, mp4_path.name, mp4_frames,
            patient_name=patient_name, patient_id=patient_id,
            camera_view=camera_view, camera_type=camera_type,
            fps=actual_fps, camera_mode=camera_mode, recorded_at=recorded_at,
            bag_file=bag_path.name,
        )
        return  # Done

    # All encoders failed
    print(f"[Conversion] {cam_key}: All encoders failed")
    _cleanup_temp()
    _update({"status": "failed", "error": "All encoders failed (h264_nvenc, libx264)"})


# =============================================================================
#                        BATCH CONVERSION ENTRY POINT
# =============================================================================

def convert_bag_to_mp4(job_id: str, batch_id: str, has_cam1: bool, has_cam2: bool):
    """
    Convert BAG files to MP4 for a batch.

    Both cameras run in PARALLEL threads. Called in a background thread by
    the /conversion/start API route.
    """
    with conversion_lock:
        job = conversion_jobs.get(job_id)
        if job:
            job["status"] = "converting"

    print(f"[Conversion] Job {job_id[:8]}: Starting batch {batch_id}")

    threads = []
    if has_cam1:
        t = threading.Thread(
            target=_convert_single_camera, args=(job_id, 1, batch_id), daemon=True
        )
        threads.append(t)
        t.start()
    if has_cam2:
        t = threading.Thread(
            target=_convert_single_camera, args=(job_id, 2, batch_id), daemon=True
        )
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    # Determine final job status
    with conversion_lock:
        job = conversion_jobs.get(job_id)
        if not job:
            return

        if job.get("cancelled"):
            job["status"] = "cancelled"
        else:
            cam_statuses = [
                job[k]["status"]
                for k in ("camera1", "camera2")
                if job.get(k) is not None
            ]
            if any(s == "failed" for s in cam_statuses):
                job["status"] = "failed"
            else:
                job["status"] = "done"

        job["completed_at"] = datetime.now().isoformat()

    print(f"[Conversion] Job {job_id[:8]}: Finished — {job['status']}")
