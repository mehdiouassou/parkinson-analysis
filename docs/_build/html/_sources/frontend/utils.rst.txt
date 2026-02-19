Frontend: Utilities & Config
============================

Configuration and helper functions.

Config
------

.. js:module:: src/config

.. js:attribute:: API_URL

   :type: string

   The base URL for the backend API.
   
   * Defaults to ``http://localhost:8000`` if ``VITE_API_URL`` environment variable is not set.

   .. code-block:: typescript

      export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

Types
-----

Common TypeScript interfaces used across the application.

.. js:class:: CameraInfo

   Represents a connected RealSense camera.

   .. js:attribute:: camera_id

      :type: number

   .. js:attribute:: type

      :type: string

   .. js:attribute:: serial

      :type: string | null

   .. js:attribute:: frame_size

      :type: [number, number]

   .. js:attribute:: fps

      :type: number

.. js:class:: ProcessingJob

   Represents a YOLOv8 analysis task.

   .. js:attribute:: job_id

      :type: string

   .. js:attribute:: status

      :type: 'pending' | 'processing' | 'completed' | 'error' | 'cancelled'

   .. js:attribute:: camera1_progress

      :type: number

      Progress percentage (0-100).
