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
    REALSENSE_MULTI_CAM_FPS_FALLBACK,
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
        self._restarting = False  # Guard against concurrent restart attempts
        self._last_restart_attempt = 0.0  # Timestamp for throttled auto-restart

        # Hardware timestamp tracking for sync analysis
        self._first_hw_timestamp = None
        self._last_hw_timestamp = None
        self._hw_timestamp_domain = None
        self._recording_frame_count = 0

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
        # Quick check under lock — if already running, bail out immediately
        with self._lock:
            if self._running:
                return True

        if not REALSENSE_AVAILABLE:
            print(f"[Camera {self.camera_id}] RealSense not available, cannot start")
            return False

        # If camera is not in the detection cache, fail silently.
        # Detection refresh is ONLY done by the /cameras/refresh endpoint
        # to prevent concurrent USB enumeration (thundering herd).
        detected = get_detected_cameras()
        if self.camera_type == CAMERA_TYPE_REALSENSE and self.camera_id not in detected:
            print(f"[Camera {self.camera_id}] Not in detection cache, skipping.")
            return False

        # Update serial from cache in case it changed
        if self.camera_id in detected:
            self.realsense_serial = detected[self.camera_id].get("serial")

        self._stop_event.clear()

        # _start_realsense runs WITHOUT the lock so that read()
        # calls from concurrent gen_frames() threads are not blocked
        # during the (slow) pipeline startup.
        success = self._start_realsense(bag_path)
        if success:
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

    def prepare_recording(self, bag_path: str) -> Optional[object]:
        """
        Phase 1 of synchronized recording start (SLOW — ~1-3s).

        Stops the current streaming pipeline and builds a new rs.config
        with recording enabled, but does NOT start the new pipeline yet.
        Call commit_recording() afterwards to actually start recording.

        This separation allows multiple cameras to prepare independently
        and then start simultaneously via a threading.Barrier.

        Args:
            bag_path: Path to .bag file to record to

        Returns:
            Prepared (pipeline, config) tuple, or None on failure
        """
        if self.camera_type != CAMERA_TYPE_REALSENSE:
            print(f"[Camera {self.camera_id}] BAG recording only supported for live RealSense cameras")
            return None

        if self._recording:
            print(f"[Camera {self.camera_id}] Already recording to {self._recording_path}")
            return None

        print(f"[Camera {self.camera_id}] Preparing recording (stopping old pipeline)...")

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

        # Build new config with recording enabled
        num_cameras = get_realsense_count()
        if num_cameras >= 2:
            configs_to_try = [
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_MULTI_CAM_FPS),
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_MULTI_CAM_FPS_FALLBACK),
            ]
        else:
            configs_to_try = [
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_SINGLE_CAM_FPS),
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_MULTI_CAM_FPS),
            ]

        for width, height, fps in configs_to_try:
            try:
                pipeline = rs.pipeline()
                config = rs.config()

                if self.realsense_serial:
                    config.enable_device(self.realsense_serial)

                config.enable_stream(rs.stream.color, width, height, rs.format.bgr8, fps)
                config.enable_stream(rs.stream.depth, width, height, rs.format.z16, fps)
                config.enable_record_to_file(bag_path)

                # Validate that config can resolve before returning
                if config.can_resolve(pipeline):
                    print(f"[Camera {self.camera_id}] Prepared config: {width}x{height}@{fps}fps -> {bag_path}")
                    return (pipeline, config, bag_path)
                else:
                    print(f"[Camera {self.camera_id}] Config {width}x{height}@{fps} cannot resolve, trying next")

            except Exception as e:
                print(f"[Camera {self.camera_id}] Config {width}x{height}@{fps} failed during prepare: {e}")

        print(f"[Camera {self.camera_id}] All configs failed during prepare")
        return None

    def commit_recording(self, prepared) -> bool:
        """
        Phase 2 of synchronized recording start (FAST — ~100-300ms).

        Takes the prepared (pipeline, config) from prepare_recording()
        and starts the pipeline. This is the part that should be
        synchronized across cameras via a threading.Barrier.

        Args:
            prepared: Tuple of (pipeline, config, bag_path) from prepare_recording()

        Returns:
            True if recording started successfully
        """
        if prepared is None:
            return False

        pipeline, config, bag_path = prepared

        try:
            profile = pipeline.start(config)

            # Increase frame queue capacity to absorb disk I/O spikes
            try:
                for sensor in profile.get_device().query_sensors():
                    if sensor.supports(rs.option.frames_queue_size):
                        opt_range = sensor.get_option_range(rs.option.frames_queue_size)
                        desired = 64
                        capped = min(desired, int(opt_range.max))
                        if capped > int(opt_range.default):
                            sensor.set_option(rs.option.frames_queue_size, capped)
            except Exception as e:
                print(f"[Camera {self.camera_id}] Warning: Could not increase frames_queue_size: {e}")

            # Read actual stream profile
            color_stream = profile.get_stream(rs.stream.color)
            if color_stream:
                video_stream = color_stream.as_video_stream_profile()
                self.frame_size = (video_stream.width(), video_stream.height())
                self.fps = video_stream.fps()

            with self._lock:
                self.pipeline = pipeline
                self._recording = True
                self._recording_path = bag_path
                self._running = True

            # Reset HW timestamp tracking for this recording
            self._first_hw_timestamp = None
            self._last_hw_timestamp = None
            self._hw_timestamp_domain = None
            self._recording_frame_count = 0

            # Start capture thread
            self._stop_event.clear()
            self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
            self._capture_thread.start()

            print(f"[Camera {self.camera_id}] Recording committed: {self.frame_size} @ {self.fps}fps [RECORDING]")
            return True

        except Exception as e:
            print(f"[Camera {self.camera_id}] commit_recording failed: {e}")
            try:
                pipeline.stop()
            except:
                pass
            return False

    def start_recording(self, bag_path: str) -> bool:
        """
        Start BAG recording by restarting pipeline with recording enabled.

        Legacy single-step API: combines prepare + commit.
        For synchronized multi-camera recording, use prepare_recording()
        followed by commit_recording() with a threading.Barrier.

        Args:
            bag_path: Path to .bag file to record to

        Returns:
            True if recording started successfully
        """
        prepared = self.prepare_recording(bag_path)
        if prepared is None:
            return False
        return self.commit_recording(prepared)

    def pause_recording(self) -> bool:
        """
        Pause BAG recording using the RealSense recorder device.

        The pipeline stays running (capture thread continues) but frames
        are no longer written to the BAG file. Call resume_recording() to
        continue writing.

        Returns:
            True if pause was successful
        """
        if not self._recording or not self.pipeline:
            return False

        try:
            device = self.pipeline.get_active_profile().get_device()
            recorder = device.as_recorder()
            recorder.pause()
            print(f"[Camera {self.camera_id}] BAG recording paused")
            return True
        except Exception as e:
            print(f"[Camera {self.camera_id}] Failed to pause recording: {e}")
            return False

    def resume_recording(self) -> bool:
        """
        Resume a paused BAG recording.

        Returns:
            True if resume was successful
        """
        if not self._recording or not self.pipeline:
            return False

        try:
            device = self.pipeline.get_active_profile().get_device()
            recorder = device.as_recorder()
            recorder.resume()
            print(f"[Camera {self.camera_id}] BAG recording resumed")
            return True
        except Exception as e:
            print(f"[Camera {self.camera_id}] Failed to resume recording: {e}")
            return False

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

        self._stop_event.clear()
        success = self._start_realsense(quick_restart=True)
        if success:
            self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
            self._capture_thread.start()

        return recorded_path


    # -------------------------------------------------------------------------
    #                    HARDWARE TIMESTAMP ACCESSORS
    # -------------------------------------------------------------------------

    def get_first_hw_timestamp(self) -> Optional[float]:
        """Get the hardware timestamp of the first frame captured during recording."""
        return self._first_hw_timestamp

    def get_last_hw_timestamp(self) -> Optional[float]:
        """Get the hardware timestamp of the last frame captured during recording."""
        return self._last_hw_timestamp

    def get_hw_timestamp_domain(self) -> Optional[str]:
        """Get the timestamp domain (e.g. 'hardware_clock', 'system_time')."""
        return self._hw_timestamp_domain

    def get_recording_frame_count(self) -> int:
        """Get the number of frames captured during the current/last recording."""
        return self._recording_frame_count


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
            if not quick_restart:
                # reduced delay
                delay = 0.5
                print(f"[Camera {self.camera_id}] Waiting {delay}s for staggered startup...")
                time.sleep(delay)
            else:
                print(f"[Camera {self.camera_id}] Skipping staggered delay for quick restart")

        actual_bag_path = bag_path or BAG_FILES.get(self.camera_id)
        is_bag_mode = self.camera_type == CAMERA_TYPE_BAG_FILE and actual_bag_path and os.path.exists(actual_bag_path)

        if num_cameras >= 2:
            # Two D455 cameras on USB 3.1 Gen2 — try 60fps first, fallback to 30
            configs_to_try = [
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_MULTI_CAM_FPS),
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_MULTI_CAM_FPS_FALLBACK),
            ]
        else:
            # Single camera can use full USB 3.x bandwidth
            configs_to_try = [
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_SINGLE_CAM_FPS),
                (REALSENSE_MULTI_CAM_WIDTH, REALSENSE_MULTI_CAM_HEIGHT, REALSENSE_MULTI_CAM_FPS),
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

                # Increase frame queue capacity to prevent silent frame drops during disk I/O spikes
                try:
                    for sensor in profile.get_device().query_sensors():
                        if sensor.supports(rs.option.frames_queue_size):
                            opt_range = sensor.get_option_range(rs.option.frames_queue_size)
                            desired = 64
                            capped = min(desired, int(opt_range.max))
                            if capped > int(opt_range.default):
                                sensor.set_option(rs.option.frames_queue_size, capped)
                except Exception as e:
                    print(f"[Camera {self.camera_id}] Warning: Could not increase frames_queue_size: {e}")

                # Reduce stabilization time
                if is_bag_mode or quick_restart:
                    stabilize_time = 0.0
                    stabilize_frames = 0
                else:
                    stabilize_time = 0.2
                    stabilize_frames = 2
                    print(f"[Camera {self.camera_id}] Waiting for sensor to stabilize...")

                if stabilize_time > 0:
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

        Tracks hardware timestamps for the first and last frame during
        recording, enabling post-hoc synchronisation between cameras.
        """
        print(f"[Camera {self.camera_id}] Capture loop started")
        error_count = 0
        
        while not self._stop_event.is_set() and self.pipeline:
            try:
                # Use try_wait_for_frames with a shorter timeout for more responsive
                # frame consumption — reduces the chance of the internal queue
                # overflowing during I/O spikes.
                success, frames = self.pipeline.try_wait_for_frames(100)
                if not success or not frames:
                    continue

                color_frame = frames.get_color_frame()
                depth_frame = frames.get_depth_frame()

                if not color_frame:
                    continue

                # Track hardware timestamps for sync analysis during recording
                if self._recording:
                    try:
                        ts = color_frame.get_timestamp()
                        domain = color_frame.get_frame_timestamp_domain()
                        if self._first_hw_timestamp is None:
                            self._first_hw_timestamp = ts
                            self._hw_timestamp_domain = str(domain)
                        self._last_hw_timestamp = ts
                        self._recording_frame_count += 1
                    except Exception:
                        pass

                # Convert to numpy arrays immediately
                frame_data = np.asanyarray(color_frame.get_data())
                depth_data = np.asanyarray(depth_frame.get_data()) if depth_frame else None

                # Update latest frame atomically
                with self._lock:
                    self._latest_frame = frame_data
                    self._latest_depth = depth_data
                    self._last_frame_time = time.time()

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




# =============================================================================
#                         GLOBAL CAMERA MANAGEMENT
# =============================================================================

camera_sources: Dict[int, CameraSource] = {}
camera_sources_lock = threading.Lock()


def get_camera_source(camera_id: int) -> CameraSource:
    """
    Get camera source for given ID.

    Pure getter — never starts or restarts cameras.  Camera lifecycle
    is managed by startup_all_cameras() (on boot) and
    restart_all_cameras() (explicit user action).
    """
    with camera_sources_lock:
        if camera_id in camera_sources:
            return camera_sources[camera_id]

        # Create an uninitialised placeholder so callers always get an object
        camera = CameraSource(camera_id)
        camera_sources[camera_id] = camera
        return camera


def startup_all_cameras():
    """Start all detected cameras.  Called once on server boot."""
    detected = get_detected_cameras()
    if not detected:
        print("[Camera] No cameras detected — nothing to start")
        return

    print(f"[Camera] Starting {len(detected)} camera(s) on boot...")

    for cam_id in sorted(detected.keys()):
        with camera_sources_lock:
            if cam_id not in camera_sources:
                camera_sources[cam_id] = CameraSource(cam_id)
            camera = camera_sources[cam_id]

        # Start in background threads with stagger delay built into _start_realsense
        t = threading.Thread(target=camera.start, daemon=True)
        t.start()


def restart_all_cameras():
    """
    Hard restart: stop all → USB settle → re-detect → restart.

    This is the "nuclear option" triggered ONLY by explicit user click
    on the Restart button.  NOT called during page navigation.
    """
    print("[Camera] === HARD RESTART requested ===")

    # 1. Stop all running cameras
    cameras = []
    with camera_sources_lock:
        cameras = list(camera_sources.values())
        camera_sources.clear()

    for camera in cameras:
        try:
            camera.stop()
        except Exception as e:
            print(f"[Camera] Error stopping camera {camera.camera_id}: {e}")

    # 2. USB settle — cameras need time after pipeline.stop()
    print("[Camera] Waiting for USB settle (3s)...")
    time.sleep(3.0)

    # 3. Re-detect (with retry built into refresh_camera_detection)
    refresh_camera_detection()

    # 4. Start all detected cameras
    startup_all_cameras()

    print("[Camera] === HARD RESTART complete ===")


def shutdown_all_cameras():
    """Release all camera resources. Called on app shutdown only."""
    print("[Camera] Shutting down all cameras...")

    cameras = []
    with camera_sources_lock:
        cameras = list(camera_sources.values())
        camera_sources.clear()

    for camera in cameras:
        try:
            camera.stop()
        except Exception as e:
            print(f"[Camera] Error stopping camera {camera.camera_id}: {e}")

    print("[Camera] All cameras shut down")

