Parkinson Analysis Documentation
================================

.. toctree::
   :maxdepth: 2
   :caption: Backend API Reference

   backend/main
   backend/processing
   backend/camera
   backend/config
   backend/models
   backend/writers

.. toctree::
   :maxdepth: 2
   :caption: Frontend Documentation

   frontend/index
   frontend/pages
   frontend/components
   frontend/utils

API Endpoints (Swagger UI)
==========================

The backend provides interactive API documentation via Swagger UI.
Once the server is running, you can access it at:

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

Introduction
============

This documentation provides a comprehensive API reference for the **Parkinson Analysis** backend.
The backend is built with **Python 3.12 (or lower)** and **FastAPI**, handling video processing using **YOLOv8** and camera inputs.

.. note::
   Ensure you have installed all dependencies from ``requirements/desktop.txt`` or ``requirements/jetson.txt`` before building docs.

Indices and tables
==================

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`
