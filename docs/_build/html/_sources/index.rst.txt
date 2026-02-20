Parkinson Analysis
==================

FastAPI backend and React frontend for dual-camera Parkinson's motion analysis.
Recordings are processed with YOLOv8-Pose; results are saved as JSON in ``api/processed/``.

Interactive API docs (Swagger UI) are at ``http://localhost:8000/docs`` when the backend is running.

.. note::
   Install dependencies before building: ``pip install -r requirements/desktop.txt``

----

.. toctree::
   :maxdepth: 2
   :caption: Backend

   backend/main
   backend/processing
   backend/camera
   backend/config
   backend/models
   backend/writers

.. toctree::
   :maxdepth: 2
   :caption: Frontend

   frontend/index
   frontend/pages
   frontend/components
   frontend/utils

----

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`
