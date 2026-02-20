import { useState, useRef, useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { API_URL } from '../config';

// SVG Icons
const ClipboardIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
  </svg>
);

const SaveIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const PlayIcon = () => (
  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const PauseIcon = () => (
  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

const ChevronsLeftIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
  </svg>
);

const ChevronsRightIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
  </svg>
);

const XIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const FPS = 20; // assumed frame rate

interface VideoFile {
  name: string;
  size: number;
  modified: string;
  patient_name?: string;
  patient_id?: string;
  camera_type?: string;  // 'Front' | 'Side' | ''
}

interface ActionLog {
  id: number;
  frame: number;
  direction: number;  // 0=left. 1=right. 2=far to near. 3=near to far
  action: string;     // human readable
}

interface VideoMetadata {
  patient_name: string;
  patient_id: string;
}

type CameraType = 'sagittale' | 'frontale' | null;

// direction mappings. matching step_segmenter.html
const DIRECTIONS: Record<number, string> = {
  0: 'Left',
  1: 'Right',
  2: 'Far to Near',
  3: 'Near to Far',
};

export default function Tagging() {
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [cameraType, setCameraType] = useState<CameraType>(null);
  const [patientInfo, setPatientInfo] = useState<VideoMetadata | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [logIdCounter, setLogIdCounter] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isLoadExpanded, setIsLoadExpanded] = useState(true); // Collapsible load section
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mountedRef = useRef(true);
  const { showToast } = useToast();

  // Block in-app navigation with unsaved logs
  const blocker = useBlocker(actionLogs.length > 0);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      const leave = window.confirm('You have unsaved tagging data. Are you sure you want to leave?');
      if (leave) {
        blocker.proceed();
      } else {
        blocker.reset();
      }
    }
  }, [blocker]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Warn before leaving with unsaved action logs (browser close/refresh)
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (actionLogs.length > 0) {
        e.preventDefault();
        e.returnValue = 'You have unsaved tagging data. Are you sure you want to leave?';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [actionLogs.length]);

  // calculate current frame from time
  const currentFrame = Math.floor(currentTime * FPS);
  const totalFrames = Math.floor(duration * FPS);

  // Fetch available mp4 files on mount
  useEffect(() => {
    fetchVideoFiles();
  }, []);

  // Force the browser to reload the video whenever the selected file changes.
  // Using a key prop on <video> remounts the element, but load() is a belt-and-
  // suspenders fallback for cases where React reuses the DOM node.
  useEffect(() => {
    if (videoRef.current && selectedFile) {
      videoRef.current.load();
    }
  }, [selectedFile]);

  const fetchVideoFiles = async () => {
    try {
      const res = await fetch(`${API_URL}/recordings`);
      const data = await res.json();
      setVideoFiles(data.files || []);
    } catch (error) {
      console.error('Failed to fetch recordings:', error);
    }
  };

  const detectCameraType = (filename: string): CameraType => {
    // filename format: YYYY-MM-DD_HH-MM-SS_camera1or2.mp4
    if (filename.includes('_camera1.')) {
      return 'sagittale'; // side view. left and right
    } else if (filename.includes('_camera2.')) {
      return 'frontale'; // front view. far and near
    }
    return null;
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const addActionLog = (direction: number) => {
    const newLog: ActionLog = {
      id: logIdCounter,
      frame: currentFrame,
      direction,
      action: DIRECTIONS[direction],
    };
    setActionLogs((prev) => [...prev, newLog]);
    setLogIdCounter((prev) => prev + 1);
  };

  // playback speed control
  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  // copy logs to clipboard. matching step_segmenter format
  const copyToClipboard = () => {
    if (actionLogs.length === 0) {
      showToast('No actions to copy', 'error');
      return;
    }
    const csv = actionLogs.map(log => `${log.frame},${log.direction}`).join('\n');
    navigator.clipboard.writeText(csv).then(() => {
      showToast(`Copied ${actionLogs.length} entries to clipboard`, 'success');
    }).catch(() => {
      showToast('Failed to copy to clipboard', 'error');
    });
  };

  const handleFileSelect = async (filename: string) => {
    if (!filename) return;

    // Warn if there are unsaved logs before switching
    if (actionLogs.length > 0) {
      const confirmed = window.confirm('You have unsaved tagging data. Switch video and discard?');
      if (!confirmed) return;
    }

    setSelectedFile(filename);
    setVideoError(null);
    // Initial camera type from filename — may be overridden by metadata below
    setCameraType(detectCameraType(filename));
    setActionLogs([]);
    setLogIdCounter(1);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsLoadExpanded(false); // Auto-collapse after selecting

    // Fetch patient metadata and prefer server-recorded camera_view over
    // filename guessing (correct even when swap was active during recording).
    try {
      const res = await fetch(`${API_URL}/videos/${filename}/metadata`);
      if (!mountedRef.current) return;
      const data = await res.json();
      if (data.patient_name || data.patient_id) {
        setPatientInfo({
          patient_name: data.patient_name || '',
          patient_id: data.patient_id || '',
        });
      } else {
        setPatientInfo(null);
      }
      // Override camera type with authoritative value from metadata sidecar
      if (data.camera_view === 'Front') {
        setCameraType('sagittale');
      } else if (data.camera_view === 'Side') {
        setCameraType('frontale');
      }
    } catch {
      if (mountedRef.current) setPatientInfo(null);
    }
  };

  const handlePlayPause = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleVideoTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleVideoLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const handleVideoEnded = () => {
    setIsPlaying(false);
  };

  const handleVideoError = () => {
    setIsPlaying(false);
    setVideoError('Failed to load video. The file may be corrupted or in an unsupported format.');
  };

  const handleVideoStalled = () => {
    // Video is trying to load but stuck - not fatal, just log
    console.warn('Video stalled, buffering...');
  };

  // frame based navigation. does not add to log
  const skipFrames = (frameCount: number) => {
    if (videoRef.current) {
      const delta = frameCount / FPS;
      const newTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + delta));
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = Number(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleSaveCSV = async () => {
    if (actionLogs.length === 0) {
      showToast('No actions to save', 'error');
      return;
    }
    if (isSaving) return;
    setIsSaving(true);

    try {
      const res = await fetch(`${API_URL}/tagging/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoFile: selectedFile,
          logs: actionLogs,
        }),
      });
      if (!mountedRef.current) return;
      const data = await res.json();
      if (data.success) {
        showToast(`Tagging saved: ${data.filename}`, 'success');
      } else {
        showToast('Failed to save: ' + data.message, 'error');
      }
    } catch (error) {
      console.error('Failed to save tagging:', error);
      if (mountedRef.current) showToast('Failed to save tagging', 'error');
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  };

  const handleClearLogs = () => {
    setActionLogs([]);
    setLogIdCounter(1);
    setConfirmClear(false);
    showToast('Action logs cleared', 'info');
  };

  const handleDeleteLog = (logId: number) => {
    setActionLogs((prev) => prev.filter((log) => log.id !== logId));
  };

  // get action buttons based on camera type. matching step_segmenter directions
  const getActionButtons = () => {
    if (cameraType === 'sagittale') {
      // side view. left and right
      return [
        { label: '← LEFT', direction: 0, color: 'bg-clinical-blue hover:bg-clinical-blue-hover' },
        { label: 'RIGHT →', direction: 1, color: 'bg-clinical-blue hover:bg-clinical-blue-hover' },
      ];
    } else if (cameraType === 'frontale') {
      // front view. far to near and near to far
      return [
        { label: '↓ Far to Near', direction: 2, color: 'bg-clinical-ready hover:bg-clinical-ready-hover' },
        { label: '↑ Near to Far', direction: 3, color: 'bg-clinical-ready hover:bg-clinical-ready-hover' },
      ];
    }
    return [];
  };

  const actionButtons = getActionButtons();

  return (
    <div className="h-full flex flex-col gap-2">
      {/* Collapsible Load Recording bar */}
      <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded p-2">
        {isLoadExpanded ? (
          // Expanded: show dropdown and refresh
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsLoadExpanded(false)}
                className="px-2 py-1.5 text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:text-clinical-text-primary dark:hover:text-clinical-text-dark transition-colors"
                title="Collapse"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
              </button>
              <span className="text-sm font-medium text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Load Recording</span>
              <div className="flex-1 relative">
                <select
                  value={selectedFile || ''}
                  onChange={(e) => handleFileSelect(e.target.value)}
                  className="w-full px-3 pr-10 py-1.5 text-sm bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border rounded text-clinical-text-primary dark:text-clinical-text-dark appearance-none cursor-pointer"
                >
                  <option value="">Select a video file...</option>
                  {videoFiles.map((file) => {
                    const dateLabel = new Date(file.modified).toLocaleDateString(undefined, {
                      year: 'numeric', month: '2-digit', day: '2-digit',
                    });
                    const patientLabel = file.patient_name ? ` — ${file.patient_name}` : '';
                    const viewLabel = file.camera_type ? ` [${file.camera_type}]` : '';
                    return (
                      <option key={file.name} value={file.name}>
                        {dateLabel}{patientLabel}{viewLabel} — {file.name}
                      </option>
                    );
                  })}
                </select>
                <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-clinical-text-secondary dark:text-clinical-text-dark-secondary pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </div>
              <button
                onClick={fetchVideoFiles}
                className="px-3 py-1.5 text-sm font-medium bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
        ) : (
          // Collapsed: show summary bar with expand button
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setIsLoadExpanded(true)}
              className="px-2 py-1 text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:text-clinical-text-primary dark:hover:text-clinical-text-dark transition-colors"
              title="Expand"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            <span className="text-sm font-medium text-clinical-ready flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              {selectedFile}
            </span>
            {/* View type badge — derived from filename */}
            {cameraType && (
              <span className={`px-2 py-0.5 text-xs font-medium rounded border ${
                cameraType === 'sagittale'
                  ? 'bg-clinical-blue/10 text-clinical-blue border-clinical-blue/30'
                  : 'bg-clinical-ready/10 text-clinical-ready border-clinical-ready/30'
              }`}>
                {cameraType === 'sagittale' ? 'Cam 1 — Lateral/Sagittal (Left/Right)' : 'Cam 2 — Frontal (Far/Near)'}
              </span>
            )}
            {/* Patient info — prefer metadata fetched on select, fall back to list data */}
            {(() => {
              const activeFile = videoFiles.find(f => f.name === selectedFile);
              const name = patientInfo?.patient_name || activeFile?.patient_name || '';
              const id = patientInfo?.patient_id || activeFile?.patient_id || '';
              const date = activeFile?.modified
                ? new Date(activeFile.modified).toLocaleDateString()
                : '';
              if (!name && !id && !date) return null;
              return (
                <span className="px-2 py-0.5 text-xs font-medium rounded bg-clinical-blue/10 text-clinical-blue border border-clinical-blue/30">
                  {date && <span className="mr-1">{date}</span>}
                  {name && <span>Patient: {name}</span>}
                  {id && <span className="ml-1">| ID: {id}</span>}
                </span>
              );
            })()}
          </div>
        )}
      </div>

      {/* Main content: Video + Action Logs side by side */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-2 min-h-0">
        {/* Video player - takes 2/3 of space */}
        <div className="lg:col-span-2 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded overflow-hidden flex flex-col">
          <div className="px-2 py-1 border-b border-clinical-border dark:border-clinical-dark-border flex justify-between items-center flex-shrink-0">
            <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Video Playback</span>
            <span className="text-sm font-mono tabular-nums text-clinical-blue">
              Frame <span className="inline-block min-w-[6ch] text-right">{currentFrame}</span> / <span className="inline-block min-w-[6ch] text-left">{totalFrames}</span> <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">({formatTime(currentTime)} / {formatTime(duration)})</span>
            </span>
          </div>
          <div className="flex-1 bg-neutral-900 flex items-center justify-center relative min-h-0">
            {selectedFile ? (
              <>
                <video
                  key={selectedFile}
                  ref={videoRef}
                  src={`${API_URL}/videos/${selectedFile}`}
                  className="w-full h-full object-contain"
                  onTimeUpdate={handleVideoTimeUpdate}
                  onLoadedMetadata={handleVideoLoadedMetadata}
                  onEnded={handleVideoEnded}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onError={handleVideoError}
                  onStalled={handleVideoStalled}
                />
                {videoError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                    <div className="text-center text-neutral-300 px-6">
                      <svg className="w-10 h-10 mx-auto mb-2 text-clinical-record" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                      </svg>
                      <p className="text-sm">{videoError}</p>
                      <button
                        onClick={() => { setVideoError(null); videoRef.current?.load(); }}
                        className="mt-2 px-3 py-1 bg-clinical-blue text-white text-sm rounded hover:bg-clinical-blue-hover"
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center text-neutral-400">
                <svg className="w-12 h-12 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
                </svg>
                <p className="text-sm">No file loaded</p>
              </div>
            )}
          </div>
          <div className="px-2 py-1.5 bg-clinical-bg dark:bg-clinical-dark-bg flex-shrink-0">
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={1 / FPS}
              value={currentTime}
              onChange={handleSliderChange}
              className="w-full h-1.5 bg-clinical-border dark:bg-clinical-dark-border rounded appearance-none cursor-pointer accent-clinical-blue"
              disabled={!selectedFile}
            />
          </div>
        </div>

        {/* Action logs - takes 1/3 of space */}
        <div className="bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded overflow-hidden flex flex-col">
          <div className="px-2 py-1 border-b border-clinical-border dark:border-clinical-dark-border flex justify-between items-center flex-shrink-0">
            <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Action Logs</span>
            <div className="flex items-center gap-1">
              <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{actionLogs.length} entries</span>
              <button
                onClick={copyToClipboard}
                disabled={actionLogs.length === 0}
                className="px-1.5 py-1 text-xs bg-clinical-bg dark:bg-clinical-dark-border border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-bg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
              >
                <ClipboardIcon /> Copy
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto min-h-0">
            <table className="min-w-full divide-y divide-clinical-border dark:divide-clinical-dark-border text-sm">
              <thead className="bg-clinical-bg dark:bg-clinical-dark-bg sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Frame</th>
                  <th className="px-2 py-1.5 text-center text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Dir</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Direction</th>
                  <th className="px-2 py-1.5 text-center text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Del</th>
                </tr>
              </thead>
              <tbody className="bg-clinical-card dark:bg-clinical-dark-card divide-y divide-clinical-border dark:divide-clinical-dark-border">
                {actionLogs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-6 text-center text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-sm">
                      No actions logged yet
                    </td>
                  </tr>
                ) : (
                  actionLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors">
                      <td className="px-2 py-1.5 font-mono tabular-nums font-semibold text-clinical-blue">{log.frame}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{log.direction}</td>
                      <td className="px-2 py-1.5 text-clinical-text-primary dark:text-clinical-text-dark">{log.action}</td>
                      <td className="px-2 py-1.5 text-center">
                        <button
                          onClick={() => handleDeleteLog(log.id)}
                          className="text-clinical-record hover:text-clinical-record-hover p-1 rounded hover:bg-clinical-record/10 transition-colors"
                        >
                          <XIcon />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Compact controls bar */}
      <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded p-2">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {/* Log Action buttons */}
          {cameraType && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono tabular-nums text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase whitespace-nowrap">Log @ F<span className="inline-block min-w-[6ch] text-left">{currentFrame}</span>:</span>
              {actionButtons.map((btn) => (
                <button
                  key={btn.direction}
                  onClick={() => addActionLog(btn.direction)}
                  disabled={!selectedFile}
                  className={`px-4 py-1.5 text-white text-sm font-medium rounded transition-colors disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed ${btn.color}`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          )}
          
          {/* Divider */}
          <div className="h-6 w-px bg-clinical-border dark:bg-clinical-dark-border hidden lg:block" />
          
          {/* Playback speed */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Speed:</span>
            {[0.25, 0.5, 1, 2].map((rate) => (
              <button
                key={rate}
                onClick={() => changePlaybackRate(rate)}
                disabled={!selectedFile}
                className={`px-2 py-1 text-sm rounded transition-colors disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed ${
                  playbackRate === rate 
                    ? 'bg-clinical-blue text-white' 
                    : 'bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:bg-clinical-border dark:hover:bg-clinical-dark-border'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
          
          {/* Divider */}
          <div className="h-6 w-px bg-clinical-border dark:bg-clinical-dark-border hidden lg:block" />
          
          {/* Frame navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => skipFrames(-10)}
              disabled={!selectedFile}
              className="px-2 py-1 bg-clinical-neutral hover:bg-clinical-neutral/80 text-white text-sm rounded disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed transition-colors flex items-center gap-0.5"
            >
              <ChevronsLeftIcon /> -10f
            </button>
            <button
              onClick={() => skipFrames(-1)}
              disabled={!selectedFile}
              className="px-2 py-1 bg-clinical-neutral hover:bg-clinical-neutral/80 text-white text-sm rounded disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed transition-colors flex items-center gap-0.5"
            >
              <ChevronLeftIcon /> -1f
            </button>
            <button
              onClick={handlePlayPause}
              disabled={!selectedFile}
              className={`px-3 py-1 text-white text-sm rounded transition-colors disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed flex items-center gap-0.5 ${
                isPlaying 
                  ? 'bg-clinical-warning hover:bg-clinical-warning/80' 
                  : 'bg-clinical-ready hover:bg-clinical-ready-hover'
              }`}
            >
              {isPlaying ? <><PauseIcon /> Pause</> : <><PlayIcon /> Play</>}
            </button>
            <button
              onClick={() => skipFrames(1)}
              disabled={!selectedFile}
              className="px-2 py-1 bg-clinical-neutral hover:bg-clinical-neutral/80 text-white text-sm rounded disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed transition-colors flex items-center gap-0.5"
            >
              +1f <ChevronRightIcon />
            </button>
            <button
              onClick={() => skipFrames(10)}
              disabled={!selectedFile}
              className="px-2 py-1 bg-clinical-neutral hover:bg-clinical-neutral/80 text-white text-sm rounded disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed transition-colors flex items-center gap-0.5"
            >
              +10f <ChevronsRightIcon />
            </button>
          </div>
          
          {/* Divider */}
          <div className="h-6 w-px bg-clinical-border dark:bg-clinical-dark-border hidden lg:block" />
          
          {/* Save/Clear */}
          <div className="flex items-center gap-2">
            {confirmClear ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-clinical-record">Clear?</span>
                <button onClick={handleClearLogs} className="px-2 py-1 bg-clinical-record text-white text-xs rounded">Yes</button>
                <button onClick={() => setConfirmClear(false)} className="px-2 py-1 bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary text-xs rounded">No</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                disabled={actionLogs.length === 0}
                className="px-2 py-1 bg-clinical-neutral hover:bg-clinical-neutral/80 text-white text-sm rounded disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed transition-colors flex items-center gap-1"
              >
                <TrashIcon /> Clear Logs
              </button>
            )}
            <button
              onClick={handleSaveCSV}
              disabled={actionLogs.length === 0 || isSaving}
              className="px-2 py-1 bg-clinical-blue hover:bg-clinical-blue-hover text-white text-sm rounded disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            >
              <SaveIcon /> {isSaving ? 'Saving...' : 'Save as CSV'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
