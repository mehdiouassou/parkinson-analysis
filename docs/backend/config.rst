Configuration
=============

Environment variables, directory paths, device detection and video settings. Everything the
backend needs to know about the runtime environment lives here.

Environment variables
---------------------

- ``CAMERA_MODE``: ``auto`` (default), ``realsense``, or ``mock_bag``
- ``REMOTE_MODE``: set to ``true`` for Jetson remote access (sets host to 0.0.0.0)
- ``API_HOST``: override the API host directly
- ``BAG_FILE_CAM1`` / ``BAG_FILE_CAM2``: paths to .bag files for mock_bag mode

Video settings
--------------

- Resolution: 848x480 (hardcoded, D455 native)
- Dual camera FPS: 60fps target, 30fps fallback (USB bandwidth dependent)
- Single camera FPS: 60fps
- JPEG quality for streaming: 70
- Default FPS (for metadata fallback): 30

Device detection
----------------

``detect_realsense_devices()`` does a single pass query of connected RealSense devices.
No retries, no waits. If the device is there its instant, if not it returns empty.
Results are cached and can be refreshed with ``refresh_camera_detection()``.

Devices are mapped to logical camera IDs in order of detection:
camera 0 = first device (Front), camera 1 = second device (Side).

API reference
-------------

.. automodule:: config
   :members:
   :undoc-members:
   :show-inheritance:
