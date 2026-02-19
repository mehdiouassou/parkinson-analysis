Frontend: Pages (React)
=======================

This section provides a detailed API reference for the main page components of the application.

CameraFeeds
-----------

.. js:class:: CameraFeeds

   The primary interface for clinical recording. Manages RealSense camera connections and recording lifecycle.
   Located in ``src/pages/CameraFeeds.tsx``.

   **State**

   .. js:attribute:: recordingState

      :type: 'idle' | 'initializing' | 'warming_up' | 'recording' | 'paused' | 'stopping'

      Current state of the recording process. Syncs with backend via ``/recording/status``.

   .. js:attribute:: camerasInfo

      :type: CameraInfo[]

      List of detected RealSense cameras fetched from ``/cameras/info``.

   .. js:attribute:: patientId

      :type: string

      Input value for the patient's unique identifier.

   .. js:attribute:: patientName

      :type: string

      Input value for the patient's name.

   **Methods**

   .. js:function:: handleRecord()

      *Async*

      Initiates the recording process.
      
      1. Validates ``patientId`` and ``patientName``.
      2. Sends POST request to ``/recording/start``.
      3. Updates state to ``warming_up``.

   .. js:function:: handleStop()

      *Async*

      Stops the current recording.
      
      1. Sends POST request to ``/recording/stop``.
      2. Updates state to ``stopping`` then ``idle``.

   .. js:function:: handleSwapCameras()

      *Async*

      Swaps the logical mapping of Camera 1 and Camera 2.
      Useful if physical cameras are plugged into reversed ports.

Tagging
-------

.. js:class:: Tagging

   Interactive video player and annotation tool.
   Located in ``src/pages/Tagging.tsx``.

   **State**

   .. js:attribute:: videoFiles

      :type: VideoFile[]

      List of available recording files fetched from ``/recordings``.

   .. js:attribute:: actionLogs

      :type: ActionLog[]

      Array of tagged events (e.g., "Tremor Start") for the current session.

   .. js:attribute:: playbackRate

      :type: number

      Current video playback speed (default: 1.0).

   **Methods**

   .. js:function:: addActionLog(direction)

      :param number direction: Direction ID (0=Left, 1=Right, etc.)

      Adds a new timestamped log entry at the current video frame.

   .. js:function:: copyToClipboard()

      Formats ``actionLogs`` as CSV and copies to the system clipboard.
      Format: ``frame,direction``.

   .. js:function:: detectCameraType(filename)

      :param string filename: The video filename.
      :returns: 'sagittale' | 'frontale' | null

      Infers the camera view based on the filename suffix (``_camera1`` vs ``_camera2``).

Processing
----------

.. js:class:: Processing

   Dashboard for managing offline analysis jobs.
   Located in ``src/pages/Processing.tsx``.

   **State**

   .. js:attribute:: batches

      :type: Batch[]

      List of recording sessions grouped by timestamp.

   .. js:attribute:: currentJob

      :type: ProcessingJob | null

      Details of the currently running or most recent analysis job.

   **Methods**

   .. js:function:: startProcessing()

      *Async*

      Triggers analysis for the selected batch.
      Sends POST to ``/processing/start``.

   .. js:function:: pollJobStatus(jobId)

      *Async*

      Periodically fetches job status from ``/processing/status/{jobId}``.
      Updates progress bars and handles completion/error states.

FileManager
-----------

.. js:class:: FileManager

   Utility for managing local files on the recording device.
   Located in ``src/pages/FileManager.tsx``.

   **State**

   .. js:attribute:: files

      :type: AllFiles

      Object containing lists of ``videos``, ``csvs``, and ``jsons``.

   .. js:attribute:: downloadProgress

      :type: Record<string, DownloadProgress>

      Tracks download percentage and speed for active file transfers.

   **Methods**

   .. js:function:: downloadFile(type, filename)

      *Async*

      :param string type: File category ('video' | 'bag' | 'csv' | 'json')
      :param string filename: Name of file to download

      Initiates a file download. Uses streams for large files (like ``.bag``) to show progress.

   .. js:function:: handleDeleteVideoBatch(batchId)

      *Async*

      Permanently deletes a pair of recordings (Front + Side) and their metadata.
