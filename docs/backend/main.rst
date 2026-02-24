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
30fps idle, 10fps during recording to save CPU and USB bandwidth on the Jetson.

**Sync tracking**: ``time.monotonic()`` timestamps are captured around pipeline restart
during record start. The inter camera offset is computed and stored in metadata sidecars.

**Pause/Resume**: calls the RealSense SDK recorder ``pause()``/``resume()`` on all
active cameras so the BAG file doesnt contain dead frames during pauses.

Routes overview
---------------

Recording:
  - ``POST /recording/start`` — start recording with 3 s warmup
  - ``POST /recording/stop`` — stop and save BAG files with metadata sidecars
  - ``POST /recording/pause`` — pause BAG writing on all cameras
  - ``POST /recording/resume`` — resume BAG writing
  - ``GET /recording/status`` — live metrics (status, duration, warmup countdown)

Camera management:
  - ``GET /camera/{id}`` — MJPEG stream (id 0 or 1)
  - ``GET /cameras/info`` — detected cameras with serials and formats
  - ``POST /cameras/restart`` — hard restart all cameras (stop, USB settle, re-detect, start)
  - ``POST /cameras/swap`` — toggle logical-to-physical camera mapping
  - ``GET /cameras/swap-state`` — get current swap state

System:
  - ``GET /system/info`` — system capabilities (camera mode, FFmpeg, active cameras)
  - ``GET /health`` — health check

Quality analysis:
  - ``GET /recordings/frame-comparison/{batch_id}`` — per-camera sync analysis, drop rates, start offset

File listing:
  - ``GET /recordings`` — list MP4 files for tagging
  - ``GET /recordings/batches`` — list recording batches (camera pairs + orphans)
  - ``GET /files/all`` — all files organised by type (videos, CSVs, JSONs)

Video serving:
  - ``GET /videos/{video_name}`` — serve video with range-request support
  - ``GET /videos/{video_name}/metadata`` — read video metadata (sidecar or ffprobe)

Tagging:
  - ``POST /tagging/save`` — save tagging logs as CSV

Conversion:
  - ``POST /conversion/start`` — start BAG-to-MP4 conversion for a batch
  - ``GET /conversion/status/{job_id}`` — conversion job status
  - ``POST /conversion/cancel/{job_id}`` — cancel a conversion job
  - ``GET /conversion/jobs`` — list all conversion jobs

Processing:
  - ``POST /processing/start`` — start YOLOv8 pose analysis for a batch
  - ``GET /processing/status/{job_id}`` — processing job status
  - ``POST /processing/cancel/{job_id}`` — cancel a processing job
  - ``GET /processing/jobs`` — list all processing jobs
  - ``POST /recordings/fix-mp4-codec`` — re-encode all MP4s to browser-compatible H.264

File deletion:
  - ``DELETE /files/video/{batch_id}`` — delete entire batch (both cameras)
  - ``DELETE /files/video/single/{filename}`` — delete a single video file
  - ``DELETE /files/csv/{filename}`` — delete a CSV file
  - ``DELETE /files/json/{filename}`` — delete a JSON file

Downloads:
  - ``GET /files/download/video/{filename}`` — download MP4
  - ``GET /files/download/bag/{filename}`` — download BAG
  - ``GET /files/download/csv/{filename}`` — download CSV
  - ``GET /files/download/json/{filename}`` — download JSON
  - ``GET /files/view/json/{filename}`` — view JSON content inline

API reference
-------------

.. automodule:: main
   :members:
   :undoc-members:
   :show-inheritance:
