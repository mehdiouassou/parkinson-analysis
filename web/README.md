# Parkinson Analysis Frontend

React dashboard for controlling RealSense cameras, recording sessions, tagging videos frame by frame, converting BAG files to MP4, running YOLOv8 analysis and managing all the output files.

## Tech Stack

- React 19 + TypeScript
- Vite (build tool)
- Tailwind CSS (styling)
- React Router 7 (routing)

## Pages

| Page | What it does |
|---|---|
| **Camera Feeds** | Live MJPEG preview from both cameras, recording controls, patient info, camera swap |
| **Tagging** | Frame accurate video player for annotating movement events (turns, freezing, etc) |
| **Conversion** | Triggers BAG to MP4 conversion, shows per camera progress bars and encoder info |
| **Processing** | Triggers YOLOv8 pose analysis, shows per camera progress |
| **File Manager** | Browse/download/delete recordings and reports, quality analysis modal with sync data |

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Configuration

API endpoint is set in `src/config.ts`. Default is `http://localhost:8000`. Override with `VITE_API_URL` env var at build time.
