Conversion Pipeline
===================

Converts recorded RealSense .bag files to browser playable .mp4 using FFmpeg.
This is a post recording step since we dont want FFmpeg competing for CPU during capture.

How it works
------------

1. BAG file is replayed through pyrealsense2 in non realtime mode (fast as disk IO)
2. Color frames are extracted as BGR24 numpy arrays
3. Frames are piped to FFmpeg stdin as raw video
4. FFmpeg encodes them. Tries ``h264_nvenc`` first (Jetson NVENC hardware encoder)
   then falls back to ``libx264`` (CPU) if NVENC isnt available
5. Output written to ``<name>.mp4.converting`` temp file
6. Frame count validated: MP4 must have >= 95% of BAG frames
7. If validation passes temp file renamed to ``.mp4``, otherwise deleted and next encoder tried
8. Metadata sidecar updated with MP4 filename, frame count and conversion timestamp

Both cameras of a batch convert in parallel threads. Batches are sequential (one at a time).

Job lifecycle: ``pending -> converting -> done | failed | cancelled``

Safety
------

The temp file approach means you never end up with a partial .mp4 on disk. If the conversion
fails or is cancelled the temp file gets cleaned up. If a .mp4 already exists and ``force``
isnt set the conversion is skipped for that camera.

API reference
-------------

.. automodule:: conversion
   :members:
   :undoc-members:
   :show-inheritance:
