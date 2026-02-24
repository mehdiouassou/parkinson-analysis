Writers
=======

Writer classes used across the recording and conversion pipelines.

.. note::
   During live recording only ``.bag`` files are written (via the RealSense SDK recorder).
   The MP4 writer classes in this module are used by the post-recording Conversion pipeline
   and the ``/recordings/fix-mp4-codec`` maintenance endpoint.

Classes
-------

- **BagWriter** — wraps the RealSense SDK recorder device. Initialised in paused state;
  call ``start_recording()`` to begin writing. Frames are captured automatically by the
  pipeline so ``write()`` is a no-op (present for API compatibility).

- **FFmpegWriter** — pipes raw BGR24 frames to an FFmpeg subprocess encoding H.264 MP4.
  Used by the conversion pipeline and ``create_mp4_writer()`` factory.

- **create_mp4_writer()** — factory function that tries FFmpegWriter first and falls back
  to OpenCV ``VideoWriter`` when FFmpeg is unavailable.

- **start_realsense_recording()** / **stop_realsense_recording()** — convenience helpers
  for starting a new RealSense pipeline pre-configured for BAG recording.

API reference
-------------

.. automodule:: writers
   :members:
   :undoc-members:
   :show-inheritance:
