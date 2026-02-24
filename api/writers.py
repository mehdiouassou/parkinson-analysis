"""
Video Writer Utilities
======================

Writer classes used across the recording and conversion pipelines:

    - **BagWriter**: Wraps the RealSense SDK recorder for .bag (depth + RGB) capture.
      Used during live recording via :func:`camera.CameraSource.start_recording`.
    - **FFmpegWriter**: Pipes raw BGR24 frames to an FFmpeg subprocess that encodes
      browser-compatible H.264 MP4. Used by the post-recording conversion pipeline
      (:mod:`conversion`) and the ``/recordings/fix-mp4-codec`` maintenance route.
    - **create_mp4_writer**: Factory that prefers FFmpegWriter and falls back to
      OpenCV's ``VideoWriter`` when FFmpeg is unavailable.

.. note::
   During live recording only .bag files are written. MP4 files are produced
   *after* recording by the Conversion page (``POST /conversion/start``).
"""

import cv2
import subprocess
import threading
from typing import Tuple, Union, Optional

from config import (
    FFMPEG_AVAILABLE,
    imageio_ffmpeg,
    REALSENSE_AVAILABLE,
    rs,
    CAMERA_TYPE_REALSENSE,
)


# =============================================================================
#                         BAG WRITER (REALSENSE DEPTH + RGB)
# =============================================================================

class BagWriter:
    """
    RealSense BAG file writer for recording depth + RGB data.

    Uses the RealSense SDK's built-in recording capability.
    BAG files are used for processing (contains depth data for gait analysis).
    """

    def __init__(self, filepath: str, pipeline, config=None):
        """
        Initialize BAG writer.

        Args:
            filepath: Output file path (should end in .bag)
            pipeline: Active RealSense pipeline (must be started first)
            config: Optional RealSense config for recording settings
        """
        self.filepath = filepath
        self.pipeline = pipeline
        self.recorder = None
        self._opened = False
        self._lock = threading.Lock()

        if not REALSENSE_AVAILABLE or pipeline is None:
            print(f"[Writer] BAG recording not available: RealSense={REALSENSE_AVAILABLE}, pipeline={pipeline is not None}")
            return

        try:
            profile = pipeline.get_active_profile()
            device = profile.get_device()

            self.recorder = device.as_recorder()
            self.recorder.pause()  # Start paused, call resume() when ready

            self._opened = True
            print(f"[Writer] BAG recording initialized: {filepath}")
        except Exception as e:
            print(f"[Writer] BAG initialization failed: {e}")
            self._opened = False

    def isOpened(self) -> bool:
        """Check if writer is ready."""
        return self._opened

    def start_recording(self):
        """Start/resume recording."""
        if self.recorder:
            try:
                self.recorder.resume()
            except Exception as e:
                print(f"[Writer] BAG resume error: {e}")

    def pause_recording(self):
        """Pause recording."""
        if self.recorder:
            try:
                self.recorder.pause()
            except Exception as e:
                print(f"[Writer] BAG pause error: {e}")

    def write(self, frame):
        """
        Note: BAG files record automatically from pipeline.
        This method is a no-op for API compatibility.
        """
        pass

    def release(self):
        """Stop recording and close the BAG file."""
        with self._lock:
            if self.recorder:
                try:
                    self.recorder.pause()
                except:
                    pass
                self.recorder = None
            self._opened = False


def create_bag_writer(filepath: str, pipeline) -> Optional[BagWriter]:
    """
    Create BAG writer for RealSense recording.

    Args:
        filepath: Output file path (should end in .bag)
        pipeline: Active RealSense pipeline

    Returns:
        BagWriter instance or None if not available
    """
    if not REALSENSE_AVAILABLE or pipeline is None:
        return None

    try:
        writer = BagWriter(filepath, pipeline)
        if writer.isOpened():
            return writer
    except Exception as e:
        print(f"[Writer] Failed to create BAG writer: {e}")

    return None


def start_realsense_recording(filepath: str, serial: str = None) -> Tuple[any, any]:
    """
    Start a new RealSense pipeline configured for BAG recording.

    This is the recommended way to record BAG files - start a new pipeline
    with recording enabled from the beginning.

    Args:
        filepath: Output .bag file path
        serial: Optional device serial number

    Returns:
        Tuple of (pipeline, config) or (None, None) on failure
    """
    if not REALSENSE_AVAILABLE:
        return None, None

    try:
        pipeline = rs.pipeline()
        config = rs.config()

        if serial:
            config.enable_device(serial)

        config.enable_stream(rs.stream.color, 848, 480, rs.format.bgr8, 60)
        config.enable_stream(rs.stream.depth, 848, 480, rs.format.z16, 60)

        config.enable_record_to_file(filepath)

        profile = pipeline.start(config)

        print(f"[Writer] RealSense recording started: {filepath}")
        return pipeline, profile

    except Exception as e:
        print(f"[Writer] Failed to start RealSense recording: {e}")
        return None, None


def stop_realsense_recording(pipeline) -> bool:
    """
    Stop RealSense pipeline recording.

    Args:
        pipeline: Active recording pipeline

    Returns:
        True if stopped successfully
    """
    if pipeline is None:
        return False

    try:
        pipeline.stop()
        print("[Writer] RealSense recording stopped")
        return True
    except Exception as e:
        print(f"[Writer] Error stopping RealSense recording: {e}")
        return False


# =============================================================================
#                          FFMPEG WRITER (RECOMMENDED MP4)
# =============================================================================

class FFmpegWriter:
    """
    FFmpeg-based video writer for browser-compatible H.264 MP4.

    Uses libx264 encoder piped through stdin for reliable browser playback.
    This is the recommended writer for MP4 files.
    """

    def __init__(self, filepath: str, frame_size: Tuple[int, int], fps: int = 30):
        self.filepath = filepath
        self.width, self.height = frame_size
        self.fps = fps
        self.process = None
        self._opened = False
        self._start()

    def _start(self):
        """Start FFmpeg subprocess."""
        try:
            ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
            cmd = [
                ffmpeg_exe,
                '-y',                          # Overwrite output
                '-f', 'rawvideo',              # Input format
                '-vcodec', 'rawvideo',         # Input codec
                '-s', f'{self.width}x{self.height}',  # Frame size
                '-pix_fmt', 'bgr24',           # BGR from OpenCV
                '-r', str(self.fps),           # Frame rate
                '-i', '-',                     # Read from stdin
                '-c:v', 'libx264',             # H.264 encoder
                '-preset', 'fast',             # Encoding speed
                '-crf', '23',                  # Quality (lower = better)
                '-pix_fmt', 'yuv420p',         # Browser-compatible pixel format
                '-movflags', '+faststart',     # Enable streaming
                self.filepath
            ]
            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            self._opened = True
            print(f"[Writer] FFmpeg H.264 encoding: {self.filepath}")
        except Exception as e:
            print(f"[Writer] FFmpeg failed: {e}")
            self._opened = False

    def isOpened(self) -> bool:
        """Check if writer is ready."""
        return self._opened and self.process is not None

    def write(self, frame):
        """Write a frame to FFmpeg stdin."""
        if self.process and self.process.stdin:
            try:
                self.process.stdin.write(frame.tobytes())
            except (BrokenPipeError, OSError):
                pass

    def release(self):
        """Close FFmpeg process."""
        if self.process:
            try:
                if self.process.stdin:
                    self.process.stdin.close()
                self.process.wait(timeout=5)
            except:
                self.process.kill()
            self.process = None
            self._opened = False


def _create_mp4_writer_opencv(filepath: str, frame_size: Tuple[int, int], fps: int = 30) -> cv2.VideoWriter:
    """
    Create MP4 video writer using OpenCV (fallback when FFmpeg unavailable).

    Args:
        filepath: Output file path (should end in .mp4)
        frame_size: (width, height) tuple
        fps: Frames per second

    Returns:
        cv2.VideoWriter instance
    """
    width, height = frame_size

    for codec in ['avc1', 'H264', 'X264', 'mp4v']:
        fourcc = cv2.VideoWriter_fourcc(*codec)
        writer = cv2.VideoWriter(filepath, fourcc, fps, (width, height))
        if writer.isOpened():
            print(f"[Writer] OpenCV {codec} encoding: {filepath}")
            return writer
        writer.release()

    print(f"[Writer] Warning: No H.264 codec available, using default: {filepath}")
    return cv2.VideoWriter(filepath, -1, fps, (width, height))


def create_mp4_writer(filepath: str, frame_size: Tuple[int, int], fps: int = 30) -> Union[FFmpegWriter, cv2.VideoWriter]:
    """
    Create MP4 video writer for browser-compatible H.264.

    Prefers FFmpeg (more reliable) with OpenCV fallback.

    Args:
        filepath: Output file path (should end in .mp4)
        frame_size: (width, height) tuple
        fps: Frames per second

    Returns:
        FFmpegWriter or cv2.VideoWriter instance
    """
    if FFMPEG_AVAILABLE:
        writer = FFmpegWriter(filepath, frame_size, fps)
        if writer.isOpened():
            return writer

    return _create_mp4_writer_opencv(filepath, frame_size, fps)


