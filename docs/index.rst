Parkinson Analysis
==================

Dual camera motion analysis tool for Parkinson's assessment. Records synchronized video from
two Intel RealSense D455 cameras on an NVIDIA Jetson AGX Orin, converts recordings to MP4,
and runs YOLOv8-Pose for skeletal keypoint extraction.

Interactive API docs (Swagger UI) are at ``http://localhost:8000/docs`` when the backend is running.

.. note::
   Install dependencies before building docs: ``pip install -r docs/requirements.txt``


How it all fits together
------------------------

The system is split into a FastAPI backend (``api/``) and a React frontend (``web/``).
The backend handles everything hardware related: camera detection, BAG recording, conversion,
processing. The frontend is just a dashboard that talks to the backend over REST.

**Recording flow**: user clicks record, 3 second warmup, both cameras start BAG recording in
parallel threads, MJPEG preview throttled to 15fps during recording, user clicks stop, metadata
sidecars written.

**Conversion flow**: BAG files replayed at max speed, frames piped to FFmpeg, tries NVENC first
then falls back to x264, frame count validated, temp file renamed to .mp4 on success.

**Processing flow**: YOLOv8 pose inference on each frame, keypoints extracted, motion vectors
calculated, tremor detected, JSON report saved.


Multi camera sync (no sync cable)
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Both cameras start in parallel threads and we capture ``time.monotonic()`` timestamps around the
pipeline restart to measure the actual inter camera start offset. This gets stored in the metadata
sidecar and shown in the quality analysis page. Typical offset is under 500ms.

The pause/resume system uses the RealSense SDK recorder device ``pause()``/``resume()`` for real
BAG pausing (no dead frames written during pause).

Streaming is throttled to 30fps idle, 15fps during recording to save CPU and USB bandwidth.


Known limitations
^^^^^^^^^^^^^^^^^

- No hardware sync cable means no frame level synchronization between cameras
- USB bandwidth is tight with two D455 cameras at 60fps (falls back to 30 if needed)
- Pipeline restart on record start/stop causes brief MJPEG interruption
- BAG files are large (several GB per minute at 60fps with depth)
- Conversion is post recording by design (no FFmpeg during capture)


----

.. toctree::
   :maxdepth: 2
   :caption: Backend

   backend/main
   backend/camera
   backend/config
   backend/conversion
   backend/processing
   backend/models
   backend/writers

.. toctree::
   :maxdepth: 2
   :caption: Frontend

   frontend/index
   frontend/pages
   frontend/components
   frontend/utils

----

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`
