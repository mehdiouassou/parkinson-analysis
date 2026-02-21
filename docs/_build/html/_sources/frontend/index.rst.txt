Frontend
========

React 19 + TypeScript application in ``web/``. Talks to the FastAPI backend over
``VITE_API_URL`` (default ``http://localhost:8000``).

Built with Vite and styled with Tailwind CSS. Uses React Router 7 for page navigation.

Dev server
----------

.. code-block:: bash

   cd web
   npm install
   npm run dev

Production build
----------------

.. code-block:: bash

   cd web
   npm run build

Output goes to ``web/dist/``.

Pages overview
--------------

- **Camera Feeds** — live MJPEG preview, recording controls, patient info, camera swap
- **Tagging** — frame accurate video player for annotating movement events
- **Conversion** — BAG to MP4 conversion with per camera progress bars
- **Processing** — YOLOv8 pose analysis with per camera progress
- **File Manager** — file browser, downloads, quality analysis modal with sync data
