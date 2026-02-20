Utilities & Config
==================

Config
------

.. js:module:: src/config

.. js:attribute:: API_URL

   ``string`` — Backend base URL. Reads ``VITE_API_URL`` at build time; falls back to ``http://localhost:8000``.

   .. code-block:: typescript

      export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

Types
-----

.. js:class:: CameraInfo

   .. js:attribute:: camera_id

      ``number``

   .. js:attribute:: type

      ``string``

   .. js:attribute:: serial

      ``string | null``

   .. js:attribute:: frame_size

      ``[number, number]``

   .. js:attribute:: fps

      ``number``

.. js:class:: ProcessingJob

   .. js:attribute:: job_id

      ``string``

   .. js:attribute:: status

      ``'pending' | 'processing' | 'completed' | 'error' | 'cancelled'``

   .. js:attribute:: camera1_progress

      ``number`` — 0–100.

   .. js:attribute:: camera2_progress

      ``number`` — 0–100. ``-1`` if that camera was not part of the batch.
