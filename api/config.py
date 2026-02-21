"""
Configuration and constants for the Parkinson Camera API.

Environment Variables:
    CAMERA_MODE: Camera backend mode
        - auto:       Auto-detect RealSense cameras - DEFAULT
        - mock_bag:   Use .bag file playback with pyrealsense2 (for dev)
        - realsense:  Live RealSense cameras (desktop/laptop)

    BAG_FILE_CAM1: Path to .bag file for camera 1 (mock_bag mode)
    BAG_FILE_CAM2: Path to .bag file for camera 2 (mock_bag mode)

    REMOTE_MODE: Set to "true" for Jetson remote deployment
    API_HOST: Host for API (default localhost, use 0.0.0.0 for remote)

Camera Type Priority:
    - Camera 0 (CAM1/Front) is the first detected RealSense device
    - Camera 1 (CAM2/Side) is the second detected RealSense device

Recording Behavior:
    - RealSense cameras: .bag (depth + RGB) + .mp4 (RGB preview)
    - Viewing/Tagging always uses .mp4 stream
    - Processing uses .bag (RealSense depth + RGB)
"""

import os
from pathlib import Path
import threading

# Global system state
SYSTEM_STATE = {
    "is_refreshing_cameras": False,
    "last_refresh_time": 0
}
state_lock = threading.Lock()


# =============================================================================
#                              DEPLOYMENT CONFIGURATION
# =============================================================================

# Set to "true" when deploying on Jetson for remote access
REMOTE_MODE = os.environ.get("REMOTE_MODE", "false").lower() == "true"
API_HOST = os.environ.get("API_HOST", "0.0.0.0" if REMOTE_MODE else "localhost")

# =============================================================================
#                              CAMERA CONFIGURATION
# =============================================================================

# Camera mode: "auto" enables RealSense detection, "mock_bag" for dev playback
CAMERA_MODE = os.environ.get("CAMERA_MODE", "auto")

# Path to sample .bag files for mock_bag mode (download from Intel)
BAG_FILES = {
    0: os.environ.get("BAG_FILE_CAM1", ""),  # Camera 1: Front/Sagittale
    1: os.environ.get("BAG_FILE_CAM2", ""),  # Camera 2: Side/Frontale
}

# Camera type constants
CAMERA_TYPE_REALSENSE = "realsense"
CAMERA_TYPE_WEBCAM = "webcam"     # kept for backward-compat reading old metadata
CAMERA_TYPE_BAG_FILE = "bag_file"


# =============================================================================
#                              DIRECTORY PATHS
# =============================================================================

API_DIR = Path(__file__).parent

RECORDINGS_DIR = API_DIR / "recordings"
RECORDINGS_DIR.mkdir(exist_ok=True)

TAGGING_DIR = API_DIR / "tagging"
TAGGING_DIR.mkdir(exist_ok=True)

PROCESSED_DIR = API_DIR / "processed"
PROCESSED_DIR.mkdir(exist_ok=True)

MODELS_DIR = API_DIR.parent / "models"
MODELS_DIR.mkdir(exist_ok=True)


# =============================================================================
#                           OPTIONAL DEPENDENCIES
# =============================================================================

# PyRealSense2 - for Intel RealSense cameras
try:
    import pyrealsense2 as rs
    REALSENSE_AVAILABLE = True
    print("[Config] pyrealsense2 loaded successfully")
except ImportError:
    rs = None
    REALSENSE_AVAILABLE = False
    print("[Config] pyrealsense2 not available")

# imageio-ffmpeg - for H.264 encoding
try:
    import imageio_ffmpeg
    FFMPEG_AVAILABLE = True
    print("[Config] imageio-ffmpeg loaded successfully")
except ImportError:
    imageio_ffmpeg = None
    FFMPEG_AVAILABLE = False
    print("[Config] imageio-ffmpeg not available")


# =============================================================================
#                         REALSENSE DEVICE DETECTION
# =============================================================================

def detect_realsense_devices():
    """
    Detect connected RealSense devices (FAST, single pass).
    
    Returns:
        List of dicts with device info: [{"serial": "...", "name": "...", "usb_type": "..."}]
    """
    if not REALSENSE_AVAILABLE or rs is None:
        return []

    devices = []
    try:
        # Create context and query immediately - no retries, no waits.
        # If the device is there, this is instant. If not, it returns empty.
        ctx = rs.context()
        device_list = list(ctx.query_devices())

        for dev in device_list:
            try:
                serial = dev.get_info(rs.camera_info.serial_number)
                # Deduplicate by serial
                if any(d["serial"] == serial for d in devices):
                    continue
                    
                name = dev.get_info(rs.camera_info.name)
                # Check USB type (USB2 vs USB3 connection)
                usb_type = "unknown"
                if dev.supports(rs.camera_info.usb_type_descriptor):
                    usb_type = dev.get_info(rs.camera_info.usb_type_descriptor)
                
                devices.append({
                    "serial": serial,
                    "name": name,
                    "usb_type": usb_type
                })
                print(f"[Config] Found RealSense: {name} (S/N: {serial}, USB: {usb_type})")
            except Exception as e:
                print(f"[Config] Error reading device info: {e}")

    except Exception as e:
        print(f"[Config] Error querying RealSense devices: {e}")

    return devices


# Detected devices cache (populated on first access)
_detected_realsense = None
_realsense_count = 0


def get_realsense_count() -> int:
    """Get the number of detected RealSense cameras."""
    global _realsense_count
    if _detected_realsense is None:
        get_detected_cameras()
    return _realsense_count


def get_detected_cameras():
    """
    Get all detected RealSense cameras with their logical IDs.

    Returns mapping of camera_id -> camera_info::

        {
            0: {"type": "realsense", "serial": "...", "name": "..."},
            1: {"type": "realsense", "serial": "...", "name": "..."}
        }

    Camera 0 = Front/Sagittale (first detected device)
    Camera 1 = Side/Frontale  (second detected device)
    """

    global _detected_realsense, _realsense_count

    if _detected_realsense is None:
        _detected_realsense = detect_realsense_devices()
        _realsense_count = len(_detected_realsense)

    cameras = {}
    cam_id = 0

    for rs_dev in _detected_realsense:
        cameras[cam_id] = {
            "type": CAMERA_TYPE_REALSENSE,
            "serial": rs_dev["serial"],
            "name": rs_dev["name"],
            "usb_type": rs_dev["usb_type"]
        }
        cam_id += 1

    return cameras


def get_camera_type(camera_id: int) -> str:
    """
    Get the type of camera at given logical ID.

    Args:
        camera_id: Camera index (0 = Front/Sagittale, 1 = Side/Frontale)

    Returns:
        Camera type constant: CAMERA_TYPE_REALSENSE or CAMERA_TYPE_BAG_FILE
    """
    if CAMERA_MODE == "mock_bag":
        return CAMERA_TYPE_BAG_FILE

    # All live modes use RealSense
    cameras = get_detected_cameras()
    if camera_id in cameras:
        return cameras[camera_id]["type"]

    # Not found → treat as offline RealSense (no fallback to webcam)
    return CAMERA_TYPE_REALSENSE


def refresh_camera_detection():
    """Force re-detection of cameras. Call when cameras may have changed."""
    global _detected_realsense, _realsense_count
    
    print("[Config] Refreshing camera detection...")
    new_devices = detect_realsense_devices()
    
    _detected_realsense = new_devices
    _realsense_count = len(new_devices)
    print("[Config] Camera detection refreshed")


# Perform initial detection on module load
if CAMERA_MODE in ("auto", "realsense"):
    print("[Config] Detecting RealSense cameras...")
    cameras = get_detected_cameras()
    if cameras:
        for cam_id, info in cameras.items():
            print(f"[Config] Camera {cam_id}: {info['type']} ({info.get('name', '')})")
    else:
        print("[Config] No RealSense cameras detected")


# =============================================================================
#                              VIDEO SETTINGS
# =============================================================================

DEFAULT_FPS = 30
DEFAULT_FRAME_SIZE = (848, 480)
JPEG_QUALITY = 70  # For streaming preview

# Multi-camera RealSense settings
# Two D455 cameras on USB 3.1 Gen2 Type-A ports (10 Gbps each)
# D455 supported FPS at 848x480: 5, 15, 30, 60, 90
# With dedicated USB 3.1 Gen2 ports per camera, 60fps should be achievable.
# Falls back to 30fps if USB bandwidth is insufficient.
REALSENSE_MULTI_CAM_WIDTH = 848
REALSENSE_MULTI_CAM_HEIGHT = 480
REALSENSE_MULTI_CAM_FPS = 60   # Target 60fps per camera on USB 3.1 Gen2
REALSENSE_MULTI_CAM_FPS_FALLBACK = 30  # Fallback if 60fps fails
REALSENSE_SINGLE_CAM_FPS = 60  # 60 FPS for single camera on USB 3.x
