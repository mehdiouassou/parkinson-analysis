Processing Pipeline (YOLOv8)
============================

Runs YOLOv8-Pose inference on recorded video to extract skeletal keypoints and calculate
motion metrics. Results are saved as JSON reports in ``api/processed/``.

What it does
------------

1. Loads BAG or MP4 file (prefers BAG for depth data access)
2. Runs YOLOv8-Pose frame by frame, extracting 17 COCO keypoints
3. Calculates inter-frame motion vectors (how much each keypoint moved)
4. Detects tremor via nose jitter variance analysis
5. Saves per-session JSON report with all metrics
6. Updates the metadata sidecar with processing duration

Both cameras of a batch are processed in parallel threads. Progress is tracked per camera
and exposed via the ``GET /processing/status/{job_id}`` endpoint.

The pipeline prefers a TensorRT ``.engine`` file for inference and falls back to the
PyTorch ``.pt`` model if no engine is available. On Jetson the engine gives much better
throughput. If neither file exists, Ultralytics will attempt to download ``yolov8n-pose.pt``
on first use.

BagFileReader
-------------

``BagFileReader`` provides a ``cv2.VideoCapture``-compatible interface for reading frames
from RealSense ``.bag`` files. It replays the BAG at maximum speed (non-realtime) and
converts colour frames to BGR numpy arrays.  Used internally by ``process_video()``
when a BAG file is available.

ANALYSIS_CONFIG
---------------

A single configuration dictionary at the top of ``processing.py`` controls all tuneable
pipeline parameters without touching any other code.  Key entries:

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Key
     - Default
     - Description
   * - ``yolo_device``
     - ``0``
     - GPU device ID for YOLO inference (``0`` = first GPU, ``"cpu"`` = CPU-only).
   * - ``yolo_verbose``
     - ``False``
     - Print per-frame inference details.
   * - ``motion_keypoints``
     - 5 head kps
     - Subset of head keypoints used for motion calculation.
       Available: ``"nose"``, ``"left_eye"``, ``"right_eye"``, ``"ears"``.
   * - ``tremor_thresholds``
     - mild/mod/sev
     - Nose-jitter variance thresholds that map to severity labels
       (None / Mild / Moderate / Severe).
   * - ``movement_score_scale``
     - ``5.0``
     - Divides ``avg_motion`` to produce a 0--1 movement score.
   * - ``landmark_sample_every_n_frames``
     - ``10``
     - How often a landmark sample is saved to the JSON output.
   * - ``max_frame_data_in_report``
     - ``50``
     - Maximum ``frame_data`` entries written to the JSON report.
   * - ``progress_update_every_n_frames``
     - ``10``
     - How often the UI progress bar is updated.
   * - ``bag_frame_timeout_ms``
     - ``5000``
     - Timeout (ms) waiting for the next BAG frame.

Output naming
-------------

Analysis reports follow the standardised naming convention::

    {batch_id}_{CF|CS}_{patient_id}_{note}_analysis.json

where ``CF`` = Camera Frontale (camera 1) and ``CS`` = Camera Sagittale (camera 2).

API reference
-------------

.. automodule:: processing
   :members:
   :undoc-members:
   :show-inheritance:
