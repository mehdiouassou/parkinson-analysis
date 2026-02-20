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

   .. js:function:: handleStop()

      *Async.* Calls ``POST /recording/stop``. State returns to ``idle``.

   .. js:function:: handleSwapCameras()

      *Async.* Calls ``POST /cameras/swap`` to flip the logical↔physical camera mapping.
      Useful when physical cameras are plugged into reversed ports.

Tagging
-------

.. js:class:: Tagging

   Video player and annotation tool.
   Located in ``src/pages/Tagging.tsx``.

   **State**

   .. js:attribute:: videoFiles

      ``VideoFile[]`` — MP4 recordings fetched from ``GET /recordings``.

   .. js:attribute:: actionLogs

      ``ActionLog[]`` — Tagged events for the current session (frame number + direction label).

   .. js:attribute:: playbackRate

      ``number`` — Current playback speed (default: ``1.0``).

   **Methods**

   .. js:function:: addActionLog(direction)

      :param number direction: Direction ID (0 = Left, 1 = Right, etc.)

      Appends a timestamped log entry at the current video frame.

   .. js:function:: copyToClipboard()

      Serialises ``actionLogs`` as ``frame,direction`` CSV and copies to clipboard.

   .. js:function:: detectCameraType(filename)

      :param string filename: Video filename.
      :returns: ``'sagittale'`` | ``'frontale'`` | ``null``

      Infers camera view from the filename suffix (``_camera1`` → frontale, ``_camera2`` → sagittale).

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

      ``Record<string, DownloadProgress>`` — Per-file download percentage and transfer speed.

   **Methods**

   .. js:function:: downloadFile(type, filename)

      *Async.*

      :param string type: ``'video'`` | ``'bag'`` | ``'csv'`` | ``'json'``
      :param string filename: Target filename.

      Streams large files (e.g. ``.bag``) to show live progress; small files use a direct link.

   .. js:function:: handleDeleteVideoBatch(batchId)

      *Async.* Deletes both camera recordings (``BAG`` + ``MP4`` + metadata) for a batch via
      ``DELETE /files/video/{batchId}``.
