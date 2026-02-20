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

      ``CameraInfo[]`` — Detected RealSense cameras, fetched from ``GET /cameras/info``.

   .. js:attribute:: patientId

      ``string``

   .. js:attribute:: patientName

      ``string``

   **Methods**

   .. js:function:: handleRecord()

      *Async.* Validates ``patientId`` / ``patientName``, then calls ``POST /recording/start``.
      State transitions to ``warming_up`` (3-second auto-exposure stabilisation) then ``recording``.
      Both cameras are started in parallel on the backend to minimise the inter-camera start offset.

   .. js:function:: handleStop()

      *Async.* Calls ``POST /recording/stop``. State returns to ``idle``.
      Both cameras are stopped in parallel on the backend.

   .. js:function:: handleSwapCameras()

      *Async.* Calls ``POST /cameras/swap`` to flip the logical↔physical camera mapping.
      Useful when physical cameras are plugged into reversed ports.

Tagging
-------

.. js:class:: Tagging

   Video player and frame-accurate annotation tool.
   Located in ``src/pages/Tagging.tsx``.

   **State**

   .. js:attribute:: videoFiles

      ``VideoFile[]`` — MP4 recordings fetched from ``GET /recordings``.

   .. js:attribute:: selectedVideo

      ``VideoFile | null`` — Currently loaded video.

   .. js:attribute:: actionLogs

      ``ActionLog[]`` — Tagged events for the current session (frame number + direction label).

   .. js:attribute:: hasUnsavedChanges

      ``boolean`` — Set to ``true`` when tags are added/deleted, reset to ``false`` after a
      successful CSV save or a clear. Used as the sole gate for the "unsaved changes" navigation
      blocker (replaces the old ``actionLogs.length > 0`` check that incorrectly triggered after saving).

   .. js:attribute:: videoFps

      ``number`` — Actual recording FPS fetched from the sidecar metadata via
      ``GET /videos/{name}/metadata``. Falls back to ``30`` if the endpoint does not return an
      ``fps`` field. Used for frame-accurate seeking (step size, skip amount).

   .. js:attribute:: isVideoLoading

      ``boolean`` — ``true`` while the browser is buffering the video (between ``loadstart`` and
      ``canplay``). Drives the loading-spinner overlay.

   .. js:attribute:: playbackRate

      ``number`` — Current playback speed (default: ``1.0``).

   **Methods**

   .. js:function:: addActionLog(direction)

      :param number direction: Direction ID (0 = Left, 1 = Right, etc.)

      Appends a timestamped log entry at the current video frame.
      Sets ``hasUnsavedChanges = true``.

   .. js:function:: handleDeleteLog(index)

      :param number index: Index of the log entry to remove.

      Removes the entry at ``index`` from ``actionLogs``.
      Sets ``hasUnsavedChanges = true``.

   .. js:function:: handleSave()

      *Async.* POSTs the CSV payload to ``POST /tagging/save``.
      On success: sets ``hasUnsavedChanges = false`` so the navigation blocker is cleared.

   .. js:function:: handleClear()

      Clears ``actionLogs`` and sets ``hasUnsavedChanges = false``.

   .. js:function:: handleFileSelect(file)

      :param VideoFile file: The video selected in the picker.

      Loads the selected video, fetches its metadata (FPS, patient info, camera view),
      and resets ``hasUnsavedChanges`` to ``false`` for the new session.

   .. js:function:: copyToClipboard()

      Serialises ``actionLogs`` as ``frame,direction`` CSV and copies to clipboard.

   .. js:function:: detectCameraType(filename)

      :param string filename: Video filename.
      :returns: ``'sagittale'`` | ``'frontale'`` | ``null``

      Infers camera view from the filename suffix (``_camera1`` → frontale, ``_camera2`` → sagittale).

   .. note::

      The ``<video>`` element uses ``preload="metadata"`` so the browser eagerly loads duration and
      frame-count data. ``onLoadStart`` / ``onCanPlay`` / ``onWaiting`` events toggle
      ``isVideoLoading`` to show/hide a buffering spinner.

Processing
----------

.. js:class:: Processing

   Dashboard for managing offline YOLOv8 analysis jobs.
   Located in ``src/pages/Processing.tsx``.

   **State**

   .. js:attribute:: batches

      ``Batch[]`` — Recording sessions grouped by timestamp, fetched from ``GET /recordings/batches``.

   .. js:attribute:: currentJob

      ``ProcessingJob | null`` — Active or most-recently-completed job.

   **Methods**

   .. js:function:: startProcessing()

      *Async.* Sends ``POST /processing/start`` for the selected batch.
      Both cameras are processed in parallel on the backend.

   .. js:function:: pollJobStatus(jobId)

      *Async.* Polls ``GET /processing/status/{jobId}`` until the job reaches
      ``completed``, ``error``, or ``cancelled``. Updates per-camera progress bars.

FileManager
-----------

.. js:class:: FileManager

   File browser for recordings, tagging CSVs, and analysis JSONs.
   Located in ``src/pages/FileManager.tsx``.

   **State**

   .. js:attribute:: files

      ``AllFiles`` — Lists of ``videos``, ``csvs``, and ``jsons`` from ``GET /files/all``.

   .. js:attribute:: downloadProgress

      ``Record<string, DownloadProgress>`` — Per-file download percentage, bytes received/total,
      transfer speed, and cancel signal. Shown as a progress bar under each file entry.

   **Methods**

   .. js:function:: downloadFile(type, filename)

      *Async.*

      :param string type: ``'video'`` | ``'bag'`` | ``'csv'`` | ``'json'``
      :param string filename: Target filename.

      All file types are downloaded via a ``ReadableStream`` so progress is tracked in
      ``downloadProgress``. A cancel button aborts the stream mid-transfer.
      Progress bars are shown for both ``.bag`` (purple) and ``.mp4`` (blue) files.

   .. js:function:: handleDeleteVideoBatch(batchId)

      *Async.* Deletes both camera recordings (``BAG`` + ``MP4`` + metadata) for a batch via
      ``DELETE /files/video/{batchId}``.
