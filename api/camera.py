"""
Camera Source Abstraction Layer

Supports RealSense camera backends:
    - Auto-detect: Automatically detects connected RealSense cameras
    - RealSense .bag playback (mock_bag) - for testing with recorded data
    - Live RealSense (realsense/auto) - desktop/laptop with RealSense cameras

Camera Priority:
    - Camera 0 (CAM1/Front) is always the first detected RealSense device
    - Camera 1 (CAM2/Side) is the second detected RealSense device
"""

import numpy as np
import threading
import os
import time
from typing import Dict, Tuple, Optional

from config import (
    CAMERA_MODE,
    BAG_FILES,
    REALSENSE_AVAILABLE,
    rs,
    DEFAULT_FRAME_SIZE,
    CAMERA_TYPE_REALSENSE,
    CAMERA_TYPE_BAG_FILE,
    get_camera_type,
    get_detected_cameras,
    get_realsense_count,
    refresh_camera_detection,
    REALSENSE_MULTI_CAM_WIDTH,
    REALSENSE_MULTI_CAM_HEIGHT,
    REALSENSE_MULTI_CAM_FPS,
    REALSENSE_SINGLE_CAM_FPS,
)


# =============================================================================
#                           CAMERA SOURCE CLASS
# =============================================================================

class CameraSource:
    """
    Unified camera source wrapping the RealSense backend.

    Attributes:
        camera_id: Camera index (0 for Front/Sagittale, 1 for Side/Frontale)
        mode: Camera backend mode (from CAMERA_MODE)
        camera_type: Detected camera type (realsense or bag_file)
        frame_size: Current frame dimensions (width, height)
        fps: Current frame rate
        realsense_serial: Serial number for RealSense cameras (for multi-cam)
    """


    def __init__(self, camera_id: int, mode: str = None):
        self.camera_id = camera_id
        self.mode = mode or CAMERA_MODE
        self.pipeline = None
        self.frame_size = DEFAULT_FRAME_SIZE
        self.fps = 60
        self._lock = threading.RLock()
        self._running = False
        self._recording = False
        self._recording_path = None

        # Threaded capture state
        self._capture_thread = None
        self._latest_frame = None
        self._latest_depth = None
        self._last_frame_time = 0
        self._stop_event = threading.Event()

        # MP4 recording (decoupled from streaming)
        self._mp4_writer = None
        self._mp4_paused = False
        self._mp4_lock = threading.Lock()
        self._mp4_frame_count = 0

        # Determine camera type based on mode and detection
        self.camera_type = get_camera_type(camera_id)
        self.realsense_serial = None

        # Get RealSense serial if applicable
        if self.camera_type == CAMERA_TYPE_REALSENSE:
            cameras = get_detected_cameras()
            if camera_id in cameras and cameras[camera_id]["type"] == CAMERA_TYPE_REALSENSE:
                self.realsense_serial = cameras[camera_id].get("serial")

        print(f"[Camera {camera_id}] Initialized as {self.camera_type}" +
              (f" (S/N: {self.realsense_serial})" if self.realsense_serial else ""))


    # -------------------------------------------------------------------------
    #                              LIFECYCLE
    # -------------------------------------------------------------------------

    def start(self, bag_path: str = None) -> bool:
        """Start the camera source. Returns True if successful."""
        with self._lock:
            if self._running:
                return True

            if not REALSENSE_AVAILABLE:
                print(f"[Camera {self.camera_id}] RealSense not available, cannot start")
                return False

            # CRITICAL OPTIMIZATION:
            # Do not attempt to start if the camera was not detected.
            # This prevents 30s timeouts on startup when no cameras are connected.
            detected = get_detected_cameras()
            if self.camera_type == CAMERA_TYPE_REALSENSE and self.camera_id not in detected:
                print(f"[Camera {self.camera_id}] Not detected in system, skipping startup.")
                return False

            success = self._start_realsense(bag_path)
            if success:
                self._stop_event.clear()
                self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
                self._capture_thread.start()
            return success

    def stop(self):
        """Stop the camera source and release resources."""
        # Signal stop event immediately (before acquiring lock) so that
        # any running start() loop can detect it and abort early.
        self._stop_event.set()
        self._running = False

        if self._capture_thread:
            self._capture_thread.join(timeout=2.0)
            self._capture_thread = None

        with self._lock:
            self._recording = False
            self._recording_path = None
            if self.pipeline:
                try:
                    self.pipeline.stop()
                except:
                    pass
                self.pipeline = None

    def is_running(self) -> bool:
        """Check if camera is currently running."""
        return self._running

    def is_recording(self) -> bool:
        """Check if BAG recording is active."""
        return self._recording

    # -------------------------------------------------------------------------
    #                           RECORDING CONTROL
    # -------------------------------------------------------------------------

    def start_recording(self, bag_path: str) -> bool:
        """
        Start BAG recording by restarting pipeline with recording enabled.

        Stops the current streaming pipeline and restarts it with recording
        enabled. The same pipeline handles both streaming and recording.

        Args:
            bag_path: Path to .bag file to record to

        Returns:
            True if recording started successfully
        """
        if self.camera_type != CAMERA_TYPE_REALSENSE:
            print(f"[Camera {self.camera_id}] BAG recording only supported for live RealSense cameras")
            return False

        if self._recording:
            print(f"[Camera {self.camera_id}] Already recording to {self._recording_path}")
            return True

        print(f"[Camera {self.camera_id}] Starting recording, restarting pipeline...")

        # Stop capture thread first
        self._stop_event.set()
        if self._capture_thread:
            self._capture_thread.join(timeout=2.0)
            self._capture_thread = None

        with self._lock:
            if self.pipeline:
                try:
                    self.pipeline.stop()
                except:
                    pass
                self.pipeline = None
            self._running = False

        success = self._start_realsense(record_to=bag_path, quick_restart=True)
        if success:
            self._stop_event.clear()
            self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
            self._capture_thread.start()

        return success

    def stop_recording(self) -> str:
        """
        Stop BAG recording and restart pipeline for streaming only.

        Returns:
            Path to the recorded .bag file, or None if not recording
        """
        if not self._recording:
            return None

        recorded_path = self._recording_path
        print(f"[Camera {self.camera_id}] Stopping recording, restarting pipeline...")

        # Stop capture thread
        self._stop_event.set()
        if self._capture_thread:
            self._capture_thread.join(timeout=2.0)
            self._capture_thread = None

        with self._lock:
            if self.pipeline:
                try:
                    self.pipeline.stop()
                except:
                    pass
                self.pipeline = None
            self._running = False
            self._recording = False
            self._recording_path = None

        success = self._start_realsense(quick_restart=True)
        if success:
            self._stop_event.clear()
            self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
            self._capture_thread.start()

        return recorded_path


    # -------------------------------------------------------------------------
    #                           REALSENSE BACKEND
    # -------------------------------------------------------------------------

    def _start_realsense(self, bag_path: str = None, record_to: str = None, quick_restart: bool = False) -> bool:
        """
        Start RealSense pipeline (live or .bag playback).

        Args:
            bag_path: Path to .bag file for playback (mock_bag mode)
            record_to: Path to .bag file to record to (recording mode)
            quick_restart: If True, reduce delays (sensor already warmed up)
        """
        # For multi-camera setups, stagger startup to avoid USB conflicts
        num_cameras = get_realsense_count()
        if num_cameras >= 2 and self.camera_id > 0:
            # reduced delay
            delay = 0.5
            print(f"[Camera {self.camera_id}] Waiting {delay}s for staggered startup...")
            time.sleep(delay)

        actual_bag_path = bag_path or BAG_FILES.get(self.camera_id)
        is_bag_mode = self.camera_type == CAMERA_TYPE_BAG_FILE and actual_bag_path and os.path.exists(actual_bag_path)

        if num_cameras >= 2:
            configs_to_try = [
                (848, 480, 60),
                (848, 480, 30),
            ]
        else:
            configs_to_try = [
                (848, 480, 60),
                (848, 480, 30),
            ]

        for width, height, fps in configs_to_try:
            # Check for stop signal between attempts
            if self._stop_event.is_set():
                print(f"[Camera {self.camera_id}] Startup aborted by stop signal")
                break
            
            try:
                self.pipeline = rs.pipeline()
                config = rs.config()

                if is_bag_mode:
                    print(f"[Camera {self.camera_id}] Loading .bag file: {actual_bag_path}")
                    rs.config.enable_device_from_file(config, actual_bag_path, repeat_playback=True)
                else:
                    print(f"[Camera {self.camera_id}] Starting live RealSense capture")

                    if self.realsense_serial:
                        config.enable_device(self.realsense_serial)
                        print(f"[Camera {self.camera_id}] Using device: {self.realsense_serial}")
                    else:
                        ctx = rs.context()
                        devices = ctx.query_devices()
                        if len(devices) > self.camera_id:
                            serial = devices[self.camera_id].get_info(rs.camera_info.serial_number)
                            config.enable_device(serial)
                            self.realsense_serial = serial
                            print(f"[Camera {self.camera_id}] Using device: {serial}")

                    print(f"[Camera {self.camera_id}] Trying: {width}x{height} @ {fps}fps")
                    config.enable_stream(rs.stream.color, width, height, rs.format.bgr8, fps)
                    config.enable_stream(rs.stream.depth, width, height, rs.format.z16, fps)

                    if record_to:
                        config.enable_record_to_file(record_to)
                        self._recording = True
                        self._recording_path = record_to
                        print(f"[Camera {self.camera_id}] Recording to: {record_to}")

                profile = self.pipeline.start(config)

                # Reduce stabilization time
                stabilize_time = 0.2
                stabilize_frames = 2
                print(f"[Camera {self.camera_id}] Waiting for sensor to stabilize...")
                time.sleep(stabilize_time)

                for _ in range(stabilize_frames):
                    try:
                        self.pipeline.wait_for_frames(timeout_ms=500)
                    except:
                        pass

                color_stream = profile.get_stream(rs.stream.color)
                if color_stream:
                    video_stream = color_stream.as_video_stream_profile()
                    self.frame_size = (video_stream.width(), video_stream.height())
                    self.fps = video_stream.fps()

                self._running = True
                print(f"[Camera {self.camera_id}] RealSense started: {self.frame_size} @ {self.fps}fps" +
                      (" [RECORDING]" if self._recording else ""))
                return True

            except Exception as e:
                print(f"[Camera {self.camera_id}] Config {width}x{height}@{fps} failed: {e}")
                if self.pipeline:
                    try:
                        self.pipeline.stop()
                    except:
                        pass
                self.pipeline = None
                continue

        # All configurations failed — camera is offline
        print(f"[Camera {self.camera_id}] All RealSense configurations failed, camera offline")
        self._recording = False
        self._recording_path = None
        return False

    def _capture_loop(self):
        """
        Background thread to continuously capture frames from RealSense.
        Decouples capture rate from consumption rate (streaming/recording).
        """
        print(f"[Camera {self.camera_id}] Capture loop started")
        error_count = 0
        
        while not self._stop_event.is_set() and self.pipeline:
            try:
                # Wait for frames (blocking with timeout) - efficient
                frames = self.pipeline.wait_for_frames(timeout_ms=2000)
                if not frames:
                    continue

                color_frame = frames.get_color_frame()
                depth_frame = frames.get_depth_frame()

                if not color_frame:
                    continue

                # Convert to numpy arrays immediately
                frame_data = np.asanyarray(color_frame.get_data())
                depth_data = np.asanyarray(depth_frame.get_data()) if depth_frame else None

                # Update latest frame atomically
                with self._lock:
                    self._latest_frame = frame_data
                    self._latest_depth = depth_data
                    self._last_frame_time = time.time()

                # Write to MP4 if recording (decoupled from streaming)
                with self._mp4_lock:
                    if self._mp4_writer is not None and not self._mp4_paused:
                        try:
                            self._mp4_writer.write(frame_data)
                            self._mp4_frame_count += 1
                        except Exception:
                            pass

                error_count = 0

            except RuntimeError as e:
                # Timeout or other runtime error
                error_count += 1
                if error_count % 30 == 0:
                    print(f"[Camera {self.camera_id}] Capture error: {e}")
                if "Frame didn't arrive" in str(e):
                    # Could try to restart pipeline here if needed
                    pass
            except Exception as e:
                print(f"[Camera {self.camera_id}] Unexpected capture error: {e}")
                time.sleep(0.1)

        print(f"[Camera {self.camera_id}] Capture loop stopped")

    def _read_realsense(self) -> Tuple[bool, Optional[np.ndarray], Optional[np.ndarray]]:
        """Return the latest captured frame."""
        with self._lock:
            if self._latest_frame is not None:
                # Check if frame is stale (older than 2 seconds)
                if time.time() - self._last_frame_time > 2.0:
                    return False, None, None
                return True, self._latest_frame.copy(), (self._latest_depth.copy() if self._latest_depth is not None else None)
            return False, None, None


    # -------------------------------------------------------------------------
    #                           UNIFIED READ
    # -------------------------------------------------------------------------

    def read(self) -> Tuple[bool, Optional[np.ndarray], Optional[np.ndarray]]:
        """
        Read a frame from the camera.

        Returns:
            Tuple of (success, frame, depth_frame)
            - success: True if frame was read successfully
            - frame: BGR color frame (numpy array) or None
            - depth_frame: Depth frame (numpy array) or None
        """
        with self._lock:
            if self.pipeline:
                return self._read_realsense()
            return False, None, None

    def get_pipeline(self):
        """Get the RealSense pipeline."""
        return self.pipeline if self.camera_type == CAMERA_TYPE_REALSENSE else None

    def is_realsense(self) -> bool:
        """Check if this camera is a RealSense camera."""
        return self.camera_type == CAMERA_TYPE_REALSENSE

    def get_info(self) -> dict:
        """Get camera information."""
        return {
            "camera_id": self.camera_id,
            "type": self.camera_type,
            "serial": self.realsense_serial,
            "frame_size": self.frame_size,
            "fps": self.fps,
            "running": self._running,
        }


    # -------------------------------------------------------------------------
    #                        MP4 WRITER (DECOUPLED)
    # -------------------------------------------------------------------------

    def set_mp4_writer(self, writer):
        """Attach an MP4 writer to the capture loop for decoupled recording."""
        with self._mp4_lock:
            self._mp4_writer = writer
            self._mp4_paused = False
            self._mp4_frame_count = 0

    def clear_mp4_writer(self) -> int:
        """Detach MP4 writer and return total frames written."""
        with self._mp4_lock:
            self._mp4_writer = None
            self._mp4_paused = False
            count = self._mp4_frame_count
            return count

    def pause_mp4_writer(self):
        """Pause MP4 frame writing (for recording pause)."""
        with self._mp4_lock:
            self._mp4_paused = True

    def resume_mp4_writer(self):
        """Resume MP4 frame writing (for recording resume)."""
        with self._mp4_lock:
            self._mp4_paused = False

    def get_mp4_frame_count(self) -> int:
        """Get number of frames written to MP4 so far."""
        with self._mp4_lock:
            return self._mp4_frame_count


# =============================================================================
#                         GLOBAL CAMERA MANAGEMENT
# =============================================================================

camera_sources: Dict[int, CameraSource] = {}
camera_sources_lock = threading.Lock()


def get_camera_source(camera_id: int) -> CameraSource:
    """
    Get or create camera source for given ID.

    Camera startup is launched in a background thread so this function
    returns immediately without blocking the calling request. Callers
    must check ``camera.is_running()`` before using the source.
    """
    with camera_sources_lock:
        if camera_id not in camera_sources:
            camera = CameraSource(camera_id)
            camera_sources[camera_id] = camera
            # Start in background — do NOT block inside the lock
            t = threading.Thread(target=camera.start, daemon=True)
            t.start()
        return camera_sources[camera_id]


def shutdown_all_cameras():
    """Release all camera resources. Called on app shutdown."""
    print("[Camera] Releasing all camera resources...")
    
    # Get references under lock, but execute stop() outside lock
    cameras_to_stop = []
    with camera_sources_lock:
        cameras_to_stop = list(camera_sources.values())
        camera_sources.clear()
        
    for camera in cameras_to_stop:
        try:
            camera.stop()
        except Exception as e:
            print(f"[Camera] Error stopping camera {camera.camera_id}: {e}")
            
    print("[Camera] All cameras released")
