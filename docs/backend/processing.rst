Processing Pipeline (YOLOv8)
============================

Runs YOLOv8-Pose inference on recorded video to extract skeletal keypoints and calculate
motion metrics. Results are saved as JSON reports in ``api/processed/``.

What it does
------------

1. Loads BAG or MP4 file (prefers BAG for depth data access)
2. Runs YOLOv8-Pose frame by frame, extracting 17 COCO keypoints
3. Calculates inter frame motion vectors (how much each keypoint moved)
4. Detects tremor via nose jitter variance analysis
5. Saves per session JSON report with all metrics

Both cameras of a batch are processed in parallel threads. Progress is tracked per camera
and exposed via the ``GET /processing/status/{job_id}`` endpoint.

The pipeline prefers a TensorRT ``.engine`` file for inference and falls back to the
PyTorch ``.pt`` model if no engine is available. On Jetson the engine gives much better
throughput.

API reference
-------------

.. automodule:: processing
   :members:
   :undoc-members:
   :show-inheritance:
