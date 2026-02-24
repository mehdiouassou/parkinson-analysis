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

``get_camera_source(camera_id)`` is a pure getter that returns an existing ``CameraSource``
or creates an uninitialised placeholder. It never starts or restarts cameras.
Camera lifecycle is managed by ``startup_all_cameras()`` (called once on server boot)
and ``restart_all_cameras()`` (explicit user action via ``POST /cameras/restart``).
``shutdown_all_cameras()`` stops everything cleanly on app shutdown.

Recording uses a two-phase barrier synchronisation protocol. ``prepare_recording()`` stops
the old pipeline and builds a new config with recording enabled (slow, ~1--3 s per camera,
runs in parallel). ``commit_recording()`` waits at a ``threading.Barrier`` so all cameras
call ``pipeline.start()`` simultaneously (fast, ~100--300 ms). This reduces the
inter-camera start offset from ~2 s (sequential) to < 100 ms.

During recording, hardware timestamps (``color_frame.get_timestamp()``) are tracked for
post-hoc synchronisation analysis. The first and last timestamps, timestamp domain, and
frame count are stored in the metadata sidecar at recording stop.

API reference
-------------

.. automodule:: camera
   :members:
   :undoc-members:
   :show-inheritance:
