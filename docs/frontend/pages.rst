Pages
=====

CameraFeeds
-----------

.. js:class:: CameraFeeds

   Recording interface. Manages RealSense camera connections and the recording lifecycle.
   Located in ``src/pages/CameraFeeds.tsx``.

   **State**

   .. js:attribute:: recordingState

      ``'idle' | 'initializing' | 'warming_up' | 'recording' | 'paused' | 'stopping'``

      Syncs with backend via ``GET /recording/status``.

   .. js:attribute:: camerasInfo

      ``CameraInfo[]`` — detected RealSense cameras from ``GET /cameras/info``.

   .. js:attribute:: patientId / patientName

      ``string`` — required before recording can start.

   **Methods**

   .. js:function:: handleRecord()

      Validates patient info then calls ``POST /recording/start``. State goes to
      ``warming_up`` (3s auto exposure stabilization) then ``recording``.
      Both cameras start BAG recording in parallel on the backend.

   .. js:function:: handlePause()

      Calls ``POST /recording/pause``. This pauses BAG writing on all cameras via the
      RealSense SDK recorder device. The pipeline stays running so the MJPEG preview
      doesnt break. No frames are written to the BAG during pause.

   .. js:function:: handleResume()

      Calls ``POST /recording/resume``. Resumes BAG writing on all cameras.

   .. js:function:: handleStop()

      Calls ``POST /recording/stop``. Both cameras stop in parallel. Metadata sidecars
      are written with patient info and inter camera sync data (start offset, pipeline
      restart times).

   .. js:function:: handleSwapCameras()

      Calls ``POST /cameras/swap`` to flip the logical to physical camera mapping.
      Useful when physical cameras are plugged into the wrong ports.

   .. js:function:: handleRefresh()

      Calls ``POST /cameras/refresh`` to re detect cameras after plug/unplug.
      Disabled during active recording (would kill the streams).

   **Camera feeds**

   Each camera feed is an ``<img>`` tag pointing at the MJPEG stream endpoint.
   On error it retries with exponential backoff (up to 10 retries). Connection status
   is shown as a colored dot next to the camera label.

   The MJPEG stream is FPS throttled on the backend: 30fps idle, 15fps during recording.

Tagging
-------

.. js:class:: Tagging

   Frame accurate video player for annotating movement events.
   Located in ``src/pages/Tagging.tsx``.

   **State**

   .. js:attribute:: actionLogs

      ``ActionLog[]`` — tagged events (frame number + direction label).

   .. js:attribute:: hasUnsavedChanges

      ``boolean`` — gates the navigation blocker. Reset after save or clear.

   .. js:attribute:: videoFps

      ``number`` — actual recording FPS from sidecar metadata. Falls back to 30.
      Used for frame accurate seeking.

   **Methods**

   .. js:function:: addActionLog(direction)

      Appends a log entry at the current video frame.

   .. js:function:: handleSave()

      POSTs the CSV payload to ``POST /tagging/save``.

   .. js:function:: detectCameraType(filename)

      Infers camera view from filename suffix (``_camera1`` = frontale, ``_camera2`` = sagittale).

   Two camera types have different tag directions:

   - **Sagittale (Side)**: Left/Right movement
   - **Frontale (Front)**: Far-to-Near/Near-to-Far movement

Conversion
----------

.. js:class:: Conversion

   Dashboard for BAG to MP4 conversion.
   Located in ``src/pages/Conversion.tsx``.

   Shows a batch dropdown, per camera progress bars with frame counts, encoder type badges
   (NVENC or x264) and completion status. Has a force re convert toggle for overwriting
   existing MP4s.

   .. js:function:: startConversion()

      Calls ``POST /conversion/start``. Polls status until done.

Processing
----------

.. js:class:: Processing

   Dashboard for YOLOv8 pose analysis jobs.
   Located in ``src/pages/Processing.tsx``.

   Select a batch, start processing, watch per camera progress bars.
   Both cameras process in parallel on the backend.

   .. js:function:: startProcessing()

      Calls ``POST /processing/start``. Polls status until done.

FileManager
-----------

.. js:class:: FileManager

   File browser with three tabs: videos (BAG + MP4 pairs grouped by batch),
   CSVs (tagging output), JSONs (processing reports).
   Located in ``src/pages/FileManager.tsx``.

   **Downloads**

   All downloads use ``ReadableStream`` for progress tracking with a cancel button.
   Shows separate progress bars for BAG (purple) and MP4 (blue) files.

   **Quality analysis modal**

   Opens from the quality button on each batch. Replays BAG files to count exact frames
   (can take up to 90s for large files) then shows:

   - **Score gauge** (0-100): 30pts recording start sync + 20pts frame count sync +
     25pts per camera drop rate
   - **Start offset**: how many ms apart the cameras started recording (from pipeline timestamps)
   - **MP4/BAG frame deltas**: frame count differences between cameras
   - **Per camera cards**: BAG frames, MP4 frames, drop rate, file sizes
   - **Sync quality badge**: excellent/good/fair/poor with "No HW sync cable" note
   - **Warning banner**: shows when the recording start offset is too high, explaining
     that MP4 files inherit the BAG offset
   - **Pipeline restart times**: how long each cameras pipeline took to restart

   .. js:function:: downloadFile(type, filename)

      Downloads via ``ReadableStream`` with progress tracking.

   .. js:function:: handleDeleteVideoBatch(batchId)

      Deletes BAG + MP4 + metadata for both cameras.
