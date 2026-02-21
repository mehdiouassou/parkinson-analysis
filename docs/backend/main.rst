Main Application (FastAPI)
==========================

The main FastAPI app. Defines all HTTP routes and wires together the recording state machine,
MJPEG streaming, conversion triggers and file management endpoints.

Key concepts
------------

**Recording state machine**: ``idle -> warming_up -> recording -> paused -> idle``.
State is tracked in a dict protected by a threading lock. Both cameras start and stop
in parallel threads to minimize inter camera offset.

**MJPEG streaming**: each camera has a generator (``gen_frames``) that reads the latest
captured frame, JPEG encodes it and yields it as multipart data. FPS is throttled to
30fps idle, 15fps during recording to save CPU and USB bandwidth on the Jetson.

**Sync tracking**: ``time.monotonic()`` timestamps are captured around pipeline restart
during record start. The inter camera offset is computed and stored in metadata sidecars.

**Pause/Resume**: calls the RealSense SDK recorder ``pause()``/``resume()`` on all
active cameras so the BAG file doesnt contain dead frames during pauses.

Routes overview
---------------

Recording:
  - ``POST /recording/start`` — start recording with warmup
  - ``POST /recording/stop`` — stop and save
  - ``POST /recording/pause`` — pause BAG writing on all cameras
  - ``POST /recording/resume`` — resume BAG writing
  - ``GET /recording/status`` — live metrics

Camera management:
  - ``GET /camera/{id}`` — MJPEG stream
  - ``GET /cameras/info`` — detected cameras
  - ``POST /cameras/refresh`` — re detect cameras
  - ``POST /cameras/swap`` — swap logical camera mapping

Quality analysis:
  - ``GET /recordings/frame-comparison/{batch_id}`` — sync analysis, drop rates, start offset

File management:
  - ``GET /recordings/batches`` — list batch pairs
  - ``GET /files/all`` — all files organized by type
  - ``DELETE /files/video/{batch_id}`` — delete batch

API reference
-------------

.. automodule:: main
   :members:
   :undoc-members:
   :show-inheritance:
