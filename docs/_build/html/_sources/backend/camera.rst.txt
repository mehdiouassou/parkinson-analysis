Camera Interface
================

The ``CameraSource`` class wraps the RealSense SDK and provides a unified interface for
live camera capture and .bag file playback. Each camera gets its own background capture thread
that continuously reads frames and stores the latest one for the MJPEG generator to pick up.

How it works
------------

On startup each camera tries to start at the configured resolution and FPS. For dual camera
setups it tries 60fps first then falls back to 30fps if USB bandwidth is insufficient.
Cameras are staggered by 0.5s on startup to avoid USB enumeration conflicts.

The capture loop runs in a daemon thread calling ``pipeline.wait_for_frames()`` with a 2s
timeout. Frames are converted to numpy arrays and stored atomically behind a lock. The MJPEG
generator and any other consumers just read the latest frame without blocking capture.

Recording uses the RealSense SDK ``enable_record_to_file`` which records directly to .bag
with zero frame drops. Starting recording requires a pipeline restart (stop the streaming
pipeline, restart with recording enabled). Same for stopping. This causes a brief interruption
in the MJPEG stream but the frontend handles it with retry logic.

Pause and resume use the SDK recorder device ``pause()``/``resume()`` without restarting the
pipeline. The capture thread keeps running (so streaming doesnt break) but no frames are
written to the BAG file.

Global management
-----------------

``get_camera_source(camera_id)`` lazily creates and starts cameras in background threads.
``shutdown_all_cameras()`` stops everything cleanly on app shutdown.

API reference
-------------

.. automodule:: camera
   :members:
   :undoc-members:
   :show-inheritance:
