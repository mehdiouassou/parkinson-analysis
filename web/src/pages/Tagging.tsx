import { useState, useRef, useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { API_URL } from '../config';

// ─── Icons ────────────────────────────────────────────────────────────────────

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

const MaximizeIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
  </svg>
);

const MinimizeIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
  </svg>
);

// ─── Constants / Types ────────────────────────────────────────────────────────

const DEFAULT_FPS = 30;

interface VideoFile {
  name: string;
  size: number;
  modified: string;
  recorded_at?: string;
  patient_id?: string;
  note?: string;
  camera_type?: string;
}

interface ActionLog {
  id: number;
  frame: number;
  direction: number;
  action: string;
}

interface VideoMetadata {
  patient_id: string;
  fps?: number;
}

type CameraType = 'sagittale' | 'frontale' | null;

const DIRECTIONS: Record<number, string> = {
  0: 'Left',
  1: 'Right',
  2: 'Far to Near',
  3: 'Near to Far',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Tagging() {
  // ── Video / playback state ──────────────────────────────────────────────────
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [cameraType, setCameraType] = useState<CameraType>(null);
  const [patientInfo, setPatientInfo] = useState<VideoMetadata | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [videoFps, setVideoFps] = useState(DEFAULT_FPS);

  // ── Tagging state ───────────────────────────────────────────────────────────
  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [logIdCounter, setLogIdCounter] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // ── UI / layout state ───────────────────────────────────────────────────────
  const [isLoadExpanded, setIsLoadExpanded] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [splitPercent, setSplitPercent] = useState(67);   // video pane width %

  // ── Seek bar hover state ────────────────────────────────────────────────────
  const [seekHovering, setSeekHovering] = useState(false);
  const [seekHoverX, setSeekHoverX] = useState(0);
  const [seekHoverTime, setSeekHoverTime] = useState(0);

  // ── Refs ────────────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const mountedRef = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);   // flex row for resize
  const seekBarRef = useRef<HTMLDivElement>(null);
  // 'none' | 'resize' | 'seek'
  const dragModeRef = useRef<string>('none');

  const { showToast } = useToast();

  // ── Derived ─────────────────────────────────────────────────────────────────
  const currentFrame = Math.floor(currentTime * videoFps);
  const totalFrames = Math.floor(duration * videoFps);
  // Action log pane is compact when the video pane is wide
  const isCompactLog = splitPercent > 74;

  // ── Navigation guard ────────────────────────────────────────────────────────
  const blocker = useBlocker(hasUnsavedChanges);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      const leave = window.confirm('You have unsaved tagging data. Are you sure you want to leave?');
      if (leave) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'You have unsaved tagging data.';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  // ── Global mouse drag handler (resize + seek) ────────────────────────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragModeRef.current === 'resize' && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        setSplitPercent(Math.max(35, Math.min(85, pct)));
      } else if (dragModeRef.current === 'seek' && seekBarRef.current && duration > 0) {
        const rect = seekBarRef.current.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const t = ratio * duration;
        if (videoRef.current) videoRef.current.currentTime = t;
        setCurrentTime(t);
      }
    };
    const handleMouseUp = () => { dragModeRef.current = 'none'; };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [duration]);

  // ── Escape to exit fullscreen ────────────────────────────────────────────────
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isFullscreen]);

  // ── Data fetching ────────────────────────────────────────────────────────────
  useEffect(() => { fetchVideoFiles(); }, []);

  useEffect(() => {
    if (videoRef.current && selectedFile) {
      setIsVideoLoading(true);
      videoRef.current.load();

      // Safety timeout: if the video is still "loading" after 8 seconds,
      // auto-retry the load. This handles the case where the first request
      // stalls and onCanPlay/onLoadedMetadata never fire.
      const timeout = setTimeout(() => {
        if (mountedRef.current && videoRef.current) {
          const vid = videoRef.current;
          if (vid.readyState < 2) {
            console.warn('[Tagging] Video load timeout — retrying');
            vid.load();
          } else {
            // readyState >= HAVE_CURRENT_DATA — video is fine, just dismiss spinner
            setIsVideoLoading(false);
          }
        }
      }, 8000);

      return () => clearTimeout(timeout);
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

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const detectCameraType = (filename: string): CameraType => {
    if (filename.includes('_camera1.') || filename.includes('_CF')) return 'frontale';
    if (filename.includes('_camera2.') || filename.includes('_CS')) return 'sagittale';
    return null;
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const addActionLog = (direction: number) => {
    setActionLogs(prev => [...prev, { id: logIdCounter, frame: currentFrame, direction, action: DIRECTIONS[direction] }]);
    setLogIdCounter(prev => prev + 1);
    setHasUnsavedChanges(true);
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const copyToClipboard = () => {
    if (actionLogs.length === 0) { showToast('No actions to copy', 'error'); return; }
    const csv = actionLogs.map(log => `${log.frame},${log.direction}`).join('\n');
    navigator.clipboard.writeText(csv)
      .then(() => showToast(`Copied ${actionLogs.length} entries to clipboard`, 'success'))
      .catch(() => showToast('Failed to copy to clipboard', 'error'));
  };

  const handleFileSelect = async (filename: string) => {
    if (!filename) return;
    if (hasUnsavedChanges) {
      const confirmed = window.confirm('You have unsaved tagging data. Switch video and discard?');
      if (!confirmed) return;
    }
    setSelectedFile(filename);
    setVideoError(null);
    setIsVideoLoading(true);
    setCameraType(detectCameraType(filename));
    setActionLogs([]);
    setHasUnsavedChanges(false);
    setLogIdCounter(1);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setVideoFps(DEFAULT_FPS);
    setIsLoadExpanded(false);
    try {
      const res = await fetch(`${API_URL}/videos/${filename}/metadata`);
      if (!mountedRef.current) return;
      const data = await res.json();
      setPatientInfo(data.patient_id
        ? { patient_id: data.patient_id || '', fps: data.fps || undefined }
        : null
      );
      if (data.fps && data.fps > 0) setVideoFps(data.fps);
      if (data.camera_view === 'Front') setCameraType('frontale');
      else if (data.camera_view === 'Side') setCameraType('sagittale');
    } catch {
      if (mountedRef.current) setPatientInfo(null);
    }
  };

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (isPlaying) videoRef.current.pause();
    else videoRef.current.play();
    setIsPlaying(!isPlaying);
  };

  const skipFrames = (frameCount: number) => {
    if (!videoRef.current) return;
    const newTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + frameCount / videoFps));
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleSaveCSV = async () => {
    if (actionLogs.length === 0) { showToast('No actions to save', 'error'); return; }
    if (isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${API_URL}/tagging/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoFile: selectedFile, logs: actionLogs }),
      });
      if (!mountedRef.current) return;
      const data = await res.json();
      if (data.success) {
        showToast(`Tagging saved: ${data.filename}`, 'success');
        setHasUnsavedChanges(false);
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
    setHasUnsavedChanges(false);
    showToast('Action logs cleared', 'info');
  };

  const handleDeleteLog = (logId: number) => {
    setActionLogs(prev => {
      const next = prev.filter(log => log.id !== logId);
      if (next.length === 0) setHasUnsavedChanges(false);
      return next;
    });
  };

  const getActionButtons = () => {
    if (cameraType === 'sagittale') return [
      { label: '← LEFT', direction: 0, color: 'bg-clinical-blue hover:bg-clinical-blue-hover' },
      { label: 'RIGHT →', direction: 1, color: 'bg-clinical-blue hover:bg-clinical-blue-hover' },
    ];
    if (cameraType === 'frontale') return [
      { label: '↓ Far to Near', direction: 2, color: 'bg-clinical-ready hover:bg-clinical-ready-hover' },
      { label: '↑ Near to Far', direction: 3, color: 'bg-clinical-ready hover:bg-clinical-ready-hover' },
    ];
    return [];
  };

  const actionButtons = getActionButtons();

  // ── Shared JSX fragments ──────────────────────────────────────────────────────

  // Video element (same ref used in both layouts — only one renders at a time)
  const videoArea = (darkBg = false) => (
    <div className={`flex-1 ${darkBg ? 'bg-black' : 'bg-neutral-900'} flex items-center justify-center relative min-h-0`}>
      {selectedFile ? (
        <>
          <video
            key={selectedFile}
            ref={videoRef}
            src={`${API_URL}/videos/${selectedFile}`}
            className="w-full h-full object-contain"
            preload="auto"
            onLoadStart={() => setIsVideoLoading(true)}
            onLoadedMetadata={() => { if (videoRef.current) { setDuration(videoRef.current.duration); setIsVideoLoading(false); } }}
            onCanPlay={() => setIsVideoLoading(false)}
            onPlaying={() => setIsVideoLoading(false)}
            onTimeUpdate={() => { if (videoRef.current) setCurrentTime(videoRef.current.currentTime); }}
            onWaiting={() => setIsVideoLoading(true)}
            onEnded={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onError={() => { setIsPlaying(false); setIsVideoLoading(false); setVideoError('Failed to load video. The file may be corrupted or in an unsupported format.'); }}
            onStalled={() => console.warn('Video stalled, buffering...')}
          />
          {isVideoLoading && !videoError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
              <div className="flex flex-col items-center gap-2">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-clinical-blue" />
                <span className="text-xs text-neutral-300">Loading...</span>
              </div>
            </div>
          )}
          {videoError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80">
              <div className="text-center text-neutral-300 px-6">
                <svg className="w-10 h-10 mx-auto mb-2 text-clinical-record" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
                <p className="text-sm">{videoError}</p>
                <button
                  onClick={() => { setVideoError(null); setIsVideoLoading(true); videoRef.current?.load(); }}
                  className="mt-2 px-3 py-1 bg-clinical-blue text-white text-sm rounded hover:bg-clinical-blue-hover"
                >Retry</button>
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
          <p className="text-xs mt-1 text-neutral-500">Select a video from the picker above</p>
        </div>
      )}
    </div>
  );

  // Custom seek bar — renders inside either panel
  const seekBar = (dark = false) => (
    <div className={`px-3 pt-2 pb-2.5 flex-shrink-0 ${dark ? 'bg-transparent' : 'bg-clinical-bg dark:bg-clinical-dark-bg'}`}>
      <div
        ref={seekBarRef}
        className={`relative h-8 flex items-center cursor-pointer select-none group ${!selectedFile ? 'opacity-40 pointer-events-none' : ''}`}
        onMouseDown={(e) => {
          if (!selectedFile || !duration || !seekBarRef.current) return;
          dragModeRef.current = 'seek';
          const rect = seekBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const t = ratio * duration;
          if (videoRef.current) videoRef.current.currentTime = t;
          setCurrentTime(t);
          e.preventDefault();
        }}
        onMouseEnter={() => setSeekHovering(true)}
        onMouseLeave={() => setSeekHovering(false)}
        onMouseMove={(e) => {
          if (!seekBarRef.current || !duration) return;
          const rect = seekBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          setSeekHoverX(e.clientX - rect.left);
          setSeekHoverTime(ratio * duration);
        }}
      >
        {/* Track background */}
        <div
          className={`absolute inset-x-0 h-1.5 rounded-full ${dark ? 'bg-white/20' : 'bg-clinical-border dark:bg-clinical-dark-border'}`}
          style={{ top: '50%', transform: 'translateY(-50%)' }}
        >
          {/* Progress fill */}
          <div
            className="absolute inset-y-0 left-0 bg-clinical-blue rounded-full"
            style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
          />
        </div>

        {/* Action log markers */}
        {duration > 0 && actionLogs.map(log => {
          const pct = Math.min(99.5, (log.frame / videoFps / duration) * 100);
          // blue for left/right (sagittale), green for far/near (frontale)
          // High contrast colors: Neon Orange for left/right, Neon Green for far/near
          const color = log.direction < 2 ? '#FF5F1F' : '#39FF14';
          return (
            <div
              key={log.id}
              className="absolute pointer-events-none rounded-sm"
              style={{
                left: `${pct}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: '2px',
                height: '10px',
                backgroundColor: color,
                opacity: 0.9,
              }}
            />
          );
        })}

        {/* Thumb — always visible, scales on hover */}
        <div
          className="absolute w-3 h-3 bg-white border-2 border-clinical-blue rounded-full shadow pointer-events-none group-hover:scale-125 transition-transform duration-100"
          style={{
            left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />

        {/* Hover time tooltip */}
        {seekHovering && duration > 0 && (
          <div
            className="absolute pointer-events-none z-10"
            style={{ left: seekHoverX, bottom: 'calc(50% + 12px)' }}
          >
            <div className="relative -translate-x-1/2 bg-gray-800 text-white text-xs font-mono px-2 py-0.5 rounded shadow-lg whitespace-nowrap">
              {formatTime(seekHoverTime)}
              {/* Tooltip arrow */}
              <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Controls bar content — shared between normal and fullscreen
  const controlsContent = (dark = false) => {
    const divider = <div className={`h-6 w-px hidden lg:block ${dark ? 'bg-white/10' : 'bg-clinical-border dark:bg-clinical-dark-border'}`} />;
    const secondaryBtn = `px-2 py-1 text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-0.5 ${dark
      ? 'bg-white/10 hover:bg-white/20 text-white disabled:bg-white/5'
      : 'bg-clinical-neutral hover:bg-clinical-neutral/80 text-white disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary'
      }`;
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        {/* Log action buttons */}
        {cameraType && (
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono tabular-nums uppercase whitespace-nowrap ${dark ? 'text-white/60' : 'text-clinical-text-secondary dark:text-clinical-text-dark-secondary'}`}>
              Log @ F<span className="inline-block min-w-[6ch] text-left">{currentFrame}</span>:
            </span>
            {actionButtons.map(btn => (
              <button
                key={btn.direction}
                onClick={() => addActionLog(btn.direction)}
                disabled={!selectedFile}
                className={`px-4 py-1.5 text-white text-sm font-medium rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${btn.color}`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        )}

        {divider}

        {/* Playback speed */}
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-medium uppercase ${dark ? 'text-white/60' : 'text-clinical-text-secondary dark:text-clinical-text-dark-secondary'}`}>Speed:</span>
          {[0.25, 0.5, 1, 2].map(rate => (
            <button
              key={rate}
              onClick={() => changePlaybackRate(rate)}
              disabled={!selectedFile}
              className={`px-2 py-1 text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${playbackRate === rate
                ? 'bg-clinical-blue text-white'
                : dark
                  ? 'bg-white/10 hover:bg-white/20 text-white/80 disabled:bg-white/5'
                  : 'bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:bg-clinical-border dark:hover:bg-clinical-dark-border'
                }`}
            >{rate}x</button>
          ))}
        </div>

        {divider}

        {/* Frame navigation */}
        <div className="flex items-center gap-1">
          <button onClick={() => skipFrames(-10)} disabled={!selectedFile} className={secondaryBtn}><ChevronsLeftIcon /> -10f</button>
          <button onClick={() => skipFrames(-1)} disabled={!selectedFile} className={secondaryBtn}><ChevronLeftIcon /> -1f</button>
          <button
            onClick={handlePlayPause}
            disabled={!selectedFile}
            className={`px-3 py-1 text-white text-sm rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-0.5 ${isPlaying ? 'bg-clinical-warning hover:bg-clinical-warning/80' : 'bg-clinical-ready hover:bg-clinical-ready-hover'
              }`}
          >
            {isPlaying ? <><PauseIcon /> Pause</> : <><PlayIcon /> Play</>}
          </button>
          <button onClick={() => skipFrames(1)} disabled={!selectedFile} className={secondaryBtn}>+1f <ChevronRightIcon /></button>
          <button onClick={() => skipFrames(10)} disabled={!selectedFile} className={secondaryBtn}>+10f <ChevronsRightIcon /></button>
        </div>

        {divider}

        {/* Save / Clear */}
        <div className="flex items-center gap-2">
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <span className={`text-xs ${dark ? 'text-red-400' : 'text-clinical-record'}`}>Clear?</span>
              <button onClick={handleClearLogs} className="px-2 py-1 bg-clinical-record text-white text-xs rounded">Yes</button>
              <button onClick={() => setConfirmClear(false)} className={`px-2 py-1 text-xs rounded ${dark ? 'bg-white/10 text-white' : 'bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary'}`}>No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              disabled={actionLogs.length === 0}
              className={secondaryBtn}
            ><TrashIcon /> Clear Logs</button>
          )}
          <button
            onClick={handleSaveCSV}
            disabled={actionLogs.length === 0 || isSaving}
            className="px-2 py-1 bg-clinical-blue hover:bg-clinical-blue-hover text-white text-sm rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          >
            <SaveIcon /> {isSaving ? 'Saving...' : 'Save as CSV'}
          </button>
        </div>
      </div>
    );
  };

  // ── Action log table ──────────────────────────────────────────────────────────
  const actionLogTable = (
    <div className="flex-1 overflow-auto min-h-0">
      {isCompactLog ? (
        // Compact: drop Direction text column when pane is narrow
        <table className="min-w-full divide-y divide-clinical-border dark:divide-clinical-dark-border">
          <thead className="bg-clinical-bg dark:bg-clinical-dark-bg sticky top-0">
            <tr>
              <th className="px-1.5 py-1 text-left text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Frame</th>
              <th className="px-1.5 py-1 text-center text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Dir</th>
              <th className="px-1.5 py-1 text-center text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase">Del</th>
            </tr>
          </thead>
          <tbody className="bg-clinical-card dark:bg-clinical-dark-card divide-y divide-clinical-border dark:divide-clinical-dark-border">
            {actionLogs.length === 0 ? (
              <tr><td colSpan={3} className="px-2 py-4 text-center text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">No actions</td></tr>
            ) : actionLogs.map(log => (
              <tr key={log.id} className="hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors">
                <td className="px-1.5 py-1 font-mono tabular-nums text-xs font-semibold text-clinical-blue">{log.frame}</td>
                <td className="px-1.5 py-1 text-center font-mono text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{log.direction}</td>
                <td className="px-1.5 py-1 text-center">
                  <button onClick={() => handleDeleteLog(log.id)} className="text-clinical-record hover:text-clinical-record-hover p-0.5 rounded hover:bg-clinical-record/10 transition-colors"><XIcon /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        // Full: all four columns
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
              <tr><td colSpan={4} className="px-2 py-6 text-center text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-sm">No actions logged yet</td></tr>
            ) : actionLogs.map(log => (
              <tr key={log.id} className="hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors">
                <td className="px-2 py-1.5 font-mono tabular-nums font-semibold text-clinical-blue">{log.frame}</td>
                <td className="px-2 py-1.5 text-center font-mono text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{log.direction}</td>
                <td className="px-2 py-1.5 text-clinical-text-primary dark:text-clinical-text-dark">{log.action}</td>
                <td className="px-2 py-1.5 text-center">
                  <button onClick={() => handleDeleteLog(log.id)} className="text-clinical-record hover:text-clinical-record-hover p-1 rounded hover:bg-clinical-record/10 transition-colors"><XIcon /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────────

  // ── Single return — fullscreen and normal share the same <video> DOM node ────
  return (
    <div className={isFullscreen
      ? 'fixed inset-0 z-50 bg-black flex flex-col overflow-hidden'
      : 'h-full flex flex-col gap-2'
    }>

      {/* ── Load Recording bar (hidden in fullscreen) ── */}
      {!isFullscreen && (
        <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded p-2">
          {isLoadExpanded ? (
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
                    {videoFiles.map(file => {
                      const dateLabel = new Date(file.modified).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
                      const parts = [
                        file.patient_id,
                        file.note,
                        file.name.replace('.mp4', ''),
                        file.camera_type ? `[${file.camera_type}]` : ''
                      ].filter(Boolean);
                      
                      return <option key={file.name} value={file.name}>{dateLabel} — {parts.join(' - ')}</option>;
                    })}
                  </select>
                  <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-clinical-text-secondary dark:text-clinical-text-dark-secondary pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
                <button
                  onClick={fetchVideoFiles}
                  className="px-3 py-1.5 text-sm font-medium bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border transition-colors"
                >Refresh</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => setIsLoadExpanded(true)} className="px-2 py-1 text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:text-clinical-text-primary dark:hover:text-clinical-text-dark transition-colors" title="Expand">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              <span className="text-sm font-medium text-clinical-ready flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                {selectedFile}
              </span>
              {cameraType && (
                <span className={`px-2 py-0.5 text-xs font-medium rounded border ${cameraType === 'sagittale' ? 'bg-clinical-blue/10 text-clinical-blue border-clinical-blue/30' : 'bg-clinical-ready/10 text-clinical-ready border-clinical-ready/30'}`}>
                  {cameraType === 'frontale' ? 'Cam 1 — Frontal (Far/Near)' : 'Cam 2 — Lateral/Sagittal (Left/Right)'}
                </span>
              )}
              <span className="px-2 py-0.5 text-xs font-mono rounded bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{videoFps} fps</span>
              {(() => {
                const activeFile = videoFiles.find(f => f.name === selectedFile);
                const id = patientInfo?.patient_id || activeFile?.patient_id || '';
                const date = activeFile?.modified ? new Date(activeFile.modified).toLocaleDateString() : '';
                if (!id && !date) return null;
                return (
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-clinical-blue/10 text-clinical-blue border border-clinical-blue/30">
                    {date && <span className="mr-1">{date}</span>}
                    {id && <span>ID: {id}</span>}
                  </span>
                );
              })()}
              {hasUnsavedChanges && <span className="px-2 py-0.5 text-xs font-medium rounded bg-clinical-warning/10 text-clinical-warning border border-clinical-warning/30">Unsaved</span>}
            </div>
          )}
        </div>
      )}

      {/* ── Main row ── */}
      <div ref={containerRef} className="flex-1 flex min-h-0" style={{ gap: 0 }}>

        {/* Video pane — expands to full width in fullscreen */}
        <div
          className={isFullscreen
            ? 'flex-1 flex flex-col min-h-0 min-w-0 relative overflow-hidden'
            : 'flex flex-col min-h-0 min-w-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded overflow-hidden'
          }
          style={isFullscreen ? undefined : { width: `${splitPercent}%` }}
        >
          {/* Fullscreen overlays: frame counter (top-left) + exit button (top-right) */}
          {isFullscreen && (
            <>
              <div className="absolute top-3 left-4 z-10 font-mono text-white/70 text-xs bg-black/50 px-2 py-1 rounded backdrop-blur-sm select-none pointer-events-none">
                F&nbsp;{currentFrame}&nbsp;/&nbsp;{totalFrames}&ensp;{formatTime(currentTime)}&nbsp;/&nbsp;{formatTime(duration)}
              </div>
              <button
                onClick={() => setIsFullscreen(false)}
                className="absolute top-3 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 bg-black/60 hover:bg-black/80 text-white text-sm rounded-lg border border-white/20 transition-colors backdrop-blur-sm"
                title="Exit fullscreen (Esc)"
              >
                <MinimizeIcon /> Exit fullscreen
              </button>
            </>
          )}

          {/* Normal header: title + frame counter + fullscreen button */}
          {!isFullscreen && (
            <div className="px-2 py-1 border-b border-clinical-border dark:border-clinical-dark-border flex justify-between items-center flex-shrink-0">
              <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Video Playback</span>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono tabular-nums text-clinical-blue">
                  F&nbsp;<span className="inline-block min-w-[5ch] text-right">{currentFrame}</span>&nbsp;/&nbsp;<span className="inline-block min-w-[5ch] text-left">{totalFrames}</span>
                  <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary ml-1">({formatTime(currentTime)} / {formatTime(duration)})</span>
                </span>
                <button
                  onClick={() => setIsFullscreen(true)}
                  disabled={!selectedFile}
                  className="p-1 text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:text-clinical-text-primary dark:hover:text-clinical-text-dark disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg"
                  title="Enter fullscreen"
                >
                  <MaximizeIcon />
                </button>
              </div>
            </div>
          )}

          {/* Video — same element in both modes, so playback position is never lost */}
          {videoArea(isFullscreen)}

          {/* Seek bar */}
          {seekBar()}
        </div>

        {/* Drag-to-resize handle (hidden in fullscreen) */}
        {!isFullscreen && (
          <div
            className="flex-shrink-0 relative cursor-col-resize group"
            style={{ width: '8px' }}
            onMouseDown={(e) => { dragModeRef.current = 'resize'; e.preventDefault(); }}
            title="Drag to resize"
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-clinical-border dark:bg-clinical-dark-border group-hover:bg-clinical-blue group-active:bg-clinical-blue transition-colors" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              {[0, 1, 2].map(i => <div key={i} className="w-0.5 h-2 bg-clinical-blue rounded-full" />)}
            </div>
          </div>
        )}

        {/* Action log pane (hidden in fullscreen) */}
        {!isFullscreen && (
          <div className="flex-1 min-w-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded overflow-hidden flex flex-col">
            <div className="px-2 py-1 border-b border-clinical-border dark:border-clinical-dark-border flex justify-between items-center flex-shrink-0">
              <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Action Logs</span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{actionLogs.length} entries</span>
                <button
                  onClick={copyToClipboard}
                  disabled={actionLogs.length === 0}
                  className="px-1.5 py-1 text-xs bg-clinical-bg dark:bg-clinical-dark-border border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-bg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                >
                  <ClipboardIcon />{!isCompactLog && ' Copy'}
                </button>
              </div>
            </div>
            {actionLogTable}
          </div>
        )}
      </div>

      {/* ── Controls bar ── */}
      <div className={`flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card p-2 ${isFullscreen ? 'border-t border-clinical-border dark:border-clinical-dark-border' : 'border border-clinical-border dark:border-clinical-dark-border rounded'}`}>
        {controlsContent()}
      </div>
    </div>
  );
}
