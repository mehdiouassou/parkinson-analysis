# Parkinson Analysis Monorepo

This repository contains the complete **Parkinson Analysis** system, a clinical tool for recording, processing, and analyzing patient motion (gait/posture) using computer vision.

---

## Project Overview

**Parkinson Analysis** is a dual-camera system designed to capture simultaneous sagittal and frontal views of patients. It utilizes **YOLOv8-Pose** for skeletal tracking and computes clinical metrics (step length, cadence, tremor, etc.).

Il progetto è diviso in due parti:
- **Frontend:** React + TypeScript
- **Backend:** Python + FastAPI
Le due parti comunicano via HTTP REST API.

---

## Structure

```
/                # Monorepo root
├── api/         # Python FastAPI backend
├── web/         # React frontend
├── models/      # Model files (.pt, .engine, etc.)
├── requirements/# Dependency management
├── deploy/      # Deployment scripts
├── docs/        # Documentation (Sphinx/React)
```

---

## Technology Stack

### Frontend
- React 19.2.0 — UI components
- TypeScript 5.9 — Static typing
- Vite 7.3.1 — Fast build tool
- Tailwind CSS 3.4 — Utility-first CSS
- react-router-dom 7.13 — Routing

### Backend
- Python 3.x (<= 3.12) — Main server language
- FastAPI — Modern, fast REST API framework

---

## Quick Start

### Backend (API)
**Requires Python 3.12 or lower!**
```sh
cd api
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r ../requirements/desktop.txt  # or jetson.txt on Jetson
uvicorn main:app --reload
```

### Frontend (Web)
```sh
cd web
npm install
npm run dev
```

## Documentation
- See `docs/` for backend and frontend documentation.
- See `models/README.md` for model management.
- See `deploy/` for deployment scripts and Jetson artifact strategy.

## Notes
- Do NOT commit hardware-specific .engine files or large venvs.
- Use sparse checkout for Jetson deployments to avoid downloading node_modules.
