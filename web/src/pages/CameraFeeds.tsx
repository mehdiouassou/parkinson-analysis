import { useState, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { API_URL } from '../config';

type RecordingState = 'idle' | 'initializing' | 'warming_up' | 'recording' | 'paused' | 'stopping';

interface CameraInfo {
  camera_id: number;
  type: string;
  serial: string | null;
  frame_size: [number, number];
  fps: number;
  running: boolean;
  recording_format: {
    high_quality: string;
    preview: string;
  };
}

export default function CameraFeeds() {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [patientId, setPatientId] = useState('');
  const [note, setNote] = useState('');
  const [cameraKey, setCameraKey] = useState(Date.now());
  const [camerasInfo, setCamerasInfo] = useState<CameraInfo[]>([]);
  const [isSwapped, setIsSwapped] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [detectedCount, setDetectedCount] = useState<number | null>(null);

  // Camera status: tracks only errors. Null = normal (streaming or waiting for first frame)
  const [camOffline, setCamOffline] = useState<Record<string, boolean>>({
    cam0: false,
    cam1: false,
  });

  // Recording live metrics (populated by status polling)
  const [recordingDuration, setRecordingDuration] = useState<number | null>(null);
  const [frameCounts, setFrameCounts] = useState<Record<string, number>>({});
  const [currentFilenames, setCurrentFilenames] = useState<Record<string, string>>({});
  const [warmupRemaining, setWarmupRemaining] = useState<number | null>(null);

  // Abort controller for cancelling in-flight requests on unmount
  const abortRef = useRef<AbortController | null>(null);
  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  const [isRestarting, setIsRestarting] = useState(false);

  // Refs for MJPEG <img> tags — used to explicitly close connections on unmount
  const cam0Ref = useRef<HTMLImageElement>(null);
  const cam1Ref = useRef<HTMLImageElement>(null);

  const { showToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  // Block in-app navigation while recording is active
  const blocker = useBlocker(recordingState !== 'idle');
  useEffect(() => {
    if (blocker.state === 'blocked') {
      const leave = window.confirm('Recording in progress. Are you sure you want to leave?');
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
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      // Force-close MJPEG connections so old gen_frames threads exit
      if (cam0Ref.current) cam0Ref.current.src = '';
      if (cam1Ref.current) cam1Ref.current.src = '';
    };
  }, []);

  // Connect MJPEG streams — runs on mount and when cameraKey changes (restart)
  useEffect(() => {
    if (cam0Ref.current) cam0Ref.current.src = `${API_URL}/camera/0?t=${cameraKey}`;
    if (cam1Ref.current) cam1Ref.current.src = `${API_URL}/camera/1?t=${cameraKey}`;
  }, [cameraKey]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Fetch camera info and hydrate recording state on mount
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    const fetchCameraInfo = async () => {
      try {
        const res = await fetch(`${API_URL}/cameras/info`, { signal: controller.signal });
        const data = await res.json();
        if (mountedRef.current && data.cameras) {
          setCamerasInfo(data.cameras);
          setDetectedCount(Object.keys(data.detected_devices || {}).length);
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') console.error('Failed to fetch camera info:', error);
      }
    };

    const hydrateRecordingState = async () => {
      try {
        const res = await fetch(`${API_URL}/recording/status`, { signal: controller.signal });
        const data = await res.json();
        if (mountedRef.current && (data.status === 'recording' || data.status === 'paused' || data.status === 'warming_up')) {
          setRecordingState(data.status as RecordingState);
          if (data.patient_id) setPatientId(data.patient_id);
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') console.error('Failed to fetch recording status:', error);
      }
    };

    const fetchSwapState = async () => {
      try {
        const res = await fetch(`${API_URL}/cameras/swap-state`, { signal: controller.signal });
        const data = await res.json();
        if (mountedRef.current) setIsSwapped(!!data.is_swapped);
      } catch (error: any) {
        if (error.name !== 'AbortError') console.error('Failed to fetch swap state:', error);
      }
    };

    fetchCameraInfo();
    hydrateRecordingState();
    fetchSwapState();
    setCameraKey(Date.now());

    return () => controller.abort();
  }, []);

  // Helper to get camera type label (RealSense-only system)
  const getCameraTypeLabel = (camIndex: number) => {
    const cam = camerasInfo.find(c => c.camera_id === camIndex);
    if (!cam) return '';
    return 'RealSense';
  };

  // Recording format info (RealSense-only: BAG + MP4)
  const getRecordingFormat = () => {
    return 'Files saved as BAG + MP4';
  };

  // Poll /recording/status every second while active to sync state and live metrics
  useEffect(() => {
    const shouldPoll =
      recordingState === 'warming_up' ||
      recordingState === 'recording' ||
      recordingState === 'paused';

    if (!shouldPoll) {
      setRecordingDuration(null);
      setWarmupRemaining(null);
      setFrameCounts({});
      setCurrentFilenames({});
      return;
    }

    let transitioned = false;
    const pollController = new AbortController();

    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/recording/status`, { signal: pollController.signal });
        const data = await res.json();
        if (!mountedRef.current) return;

        // Detect warm-up → recording transition
        if (data.status === 'recording' && recordingState === 'warming_up' && !transitioned) {
          transitioned = true;
          setRecordingState('recording');
          showToastRef.current('Recording started', 'success');
        }

        // Detect backend returning idle unexpectedly (e.g. backend restarted)
        if (data.status === 'idle') {
          setRecordingState('idle');
          return;
        }

        setRecordingDuration(data.duration ?? null);
        setWarmupRemaining(data.warmup_remaining ?? null);
        setFrameCounts(data.frame_counts ?? {});
        setCurrentFilenames(data.current_filenames ?? {});
      } catch (error: any) {
        if (error.name !== 'AbortError') console.error('Failed to poll recording status:', error);
      }
    };

    poll(); // immediate first tick
    const interval = setInterval(poll, 1000);
    return () => {
      clearInterval(interval);
      pollController.abort();
    };
  }, [recordingState]);

  // warn user before leaving page during recording
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (recordingState !== 'idle') {
        e.preventDefault();
        e.returnValue = 'Recording in progress. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [recordingState]);

  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const currentDate = clock.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const currentTime = clock.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  // api call handlers - track in-flight to prevent double-clicks
  const actionInFlight = useRef(false);
  // Separate ref for refresh so it never blocks record/pause/stop and vice-versa
  const refreshInFlight = useRef(false);

  const handleRecord = async () => {
    if (!patientId.trim()) {
      showToast('Please enter patient ID before recording', 'error');
      return;
    }
    if (detectedCount === 0) {
      showToast('No cameras connected. Plug in a camera and hit Refresh.', 'error');
      return;
    }
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setRecordingState('initializing');
    try {
      const res = await fetch(`${API_URL}/recording/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId }),
      });
      if (!mountedRef.current) return;
      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || 'Failed to start recording', 'error');
        setRecordingState('idle');
        return;
      }
      setRecordingState('warming_up');
      showToast('Warming up cameras…', 'success');
    } catch (error) {
      console.error('Failed to start recording:', error);
      if (mountedRef.current) {
        showToast('Failed to start recording', 'error');
        setRecordingState('idle');
      }
    } finally {
      actionInFlight.current = false;
    }
  };

  const handlePause = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      const res = await fetch(`${API_URL}/recording/pause`, { method: 'POST' });
      if (!mountedRef.current) return;
      if (res.ok) setRecordingState('paused');
      else showToast('Failed to pause recording', 'error');
    } catch (error) {
      console.error('Failed to pause recording:', error);
      if (mountedRef.current) showToast('Failed to pause recording', 'error');
    } finally {
      actionInFlight.current = false;
    }
  };

  const handleResume = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    try {
      const res = await fetch(`${API_URL}/recording/resume`, { method: 'POST' });
      if (!mountedRef.current) return;
      if (res.ok) setRecordingState('recording');
      else showToast('Failed to resume recording', 'error');
    } catch (error) {
      console.error('Failed to resume recording:', error);
      if (mountedRef.current) showToast('Failed to resume recording', 'error');
    } finally {
      actionInFlight.current = false;
    }
  };

  const handleSwapCameras = async () => {
    if (actionInFlight.current || isSwapping) return;
    actionInFlight.current = true;
    setIsSwapping(true);
    try {
      const res = await fetch(`${API_URL}/cameras/swap`, { method: 'POST' });
      if (!mountedRef.current) return;
      if (!res.ok) throw new Error('Swap failed');
      const data = await res.json();
      setIsSwapped(!!data.is_swapped);
      // Force-refresh both feed images so the swap is visible immediately
      setCameraKey(Date.now());
      showToast('Cameras swapped', 'success');
    } catch (error) {
      console.error('Failed to swap cameras:', error);
      if (mountedRef.current) showToast('Failed to swap cameras', 'error');
    } finally {
      actionInFlight.current = false;
      setIsSwapping(false);
    }
  };

  const handleStop = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setRecordingState('stopping');
    try {
      const res = await fetch(`${API_URL}/recording/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note })
      });
      const data = await res.json();
      if (!mountedRef.current) return;
      setRecordingState('idle');
      if (data.bag_files && data.bag_files.length > 0) {
        showToast(`Saved ${data.bag_files.length} recording(s)`, 'success');
      }
    } catch (error) {
      console.error('Failed to stop recording:', error);
      if (mountedRef.current) {
        showToast('Failed to stop recording', 'error');
        setRecordingState('idle');
      }
    } finally {
      actionInFlight.current = false;
    }
  };

  const handleRefresh = async () => {
    // Lightweight: just re-read camera info, no stop/restart
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setIsRefreshing(true);

    try {
      const res = await fetch(`${API_URL}/cameras/refresh`, { method: 'POST' });
      if (!res.ok) throw new Error('Refresh failed');

      const infoRes = await fetch(`${API_URL}/cameras/info`);
      if (!infoRes.ok) throw new Error('Failed to get camera info');
      const infoData = await infoRes.json();

      if (mountedRef.current) {
        setCamerasInfo(infoData.cameras || []);
        const found = Object.keys(infoData.detected_devices || {}).length;
        setDetectedCount(found);
        setCameraKey(Date.now());
        showToast(`${found} camera${found !== 1 ? 's' : ''} detected`, found > 0 ? 'success' : 'info');
      }
    } catch (error) {
      console.error('Failed to refresh cameras:', error);
      if (mountedRef.current) showToast('Failed to refresh cameras', 'error');
    } finally {
      if (mountedRef.current) setIsRefreshing(false);
      refreshInFlight.current = false;
    }
  };

  const handleRestart = async () => {
    // Hard restart: stop cameras, USB settle, re-detect, restart
    if (isRestarting || recordingState !== 'idle') return;
    setIsRestarting(true);
    setCamOffline({ cam0: false, cam1: false });

    try {
      showToast('Restarting cameras…', 'info');
      const res = await fetch(`${API_URL}/cameras/restart`, { method: 'POST' });
      if (!res.ok) throw new Error('Restart failed');
      const data = await res.json();

      // Re-fetch camera info
      const infoRes = await fetch(`${API_URL}/cameras/info`);
      if (infoRes.ok) {
        const infoData = await infoRes.json();
        if (mountedRef.current) {
          setCamerasInfo(infoData.cameras || []);
          const found = Object.keys(infoData.detected_devices || {}).length;
          setDetectedCount(found);
        }
      }

      if (mountedRef.current) {
        // Force reconnect the <img> tags by changing the key
        setCameraKey(Date.now());
        showToast(data.message || 'Cameras restarted', 'success');
      }
    } catch (error) {
      console.error('Failed to restart cameras:', error);
      if (mountedRef.current) showToast('Failed to restart cameras', 'error');
    } finally {
      if (mountedRef.current) setIsRestarting(false);
    }
  };

  return (
    <div className="h-full flex flex-col gap-2">
      {/* Compact info bar */}
      <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded p-3">
        <div className="flex flex-wrap items-center gap-4">
          {/* Patient inputs */}
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-clinical-text-secondary dark:text-clinical-text-dark-secondary whitespace-nowrap">Patient:</label>
            <input
              type="text"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="ID"
              disabled={recordingState !== 'idle'}
              className="w-32 px-2 py-1.5 text-sm bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border rounded text-clinical-text-primary dark:text-clinical-text-dark disabled:opacity-50"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-clinical-text-secondary dark:text-clinical-text-dark-secondary whitespace-nowrap">Note:</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Session Note"
              className="w-48 px-2 py-1.5 text-sm bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border rounded text-clinical-text-primary dark:text-clinical-text-dark"
            />
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-clinical-border dark:bg-clinical-dark-border" />

          {/* Date/Time */}
          <div className="flex flex-col items-start leading-tight">
            <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{currentDate}</span>
            <span className="text-sm font-mono font-semibold text-clinical-blue">{currentTime}</span>
          </div>

          {/* Divider */}
          <div className="h-6 w-px bg-clinical-border dark:bg-clinical-dark-border" />

          {/* Status section — badge + live metrics */}
          <div className="flex items-center gap-3 flex-wrap">
            <span
              className={`inline-flex items-center px-3 py-1 rounded text-sm font-medium ${recordingState === 'recording'
                ? 'bg-clinical-record/10 text-clinical-record border border-clinical-record/30'
                : recordingState === 'paused'
                  ? 'bg-clinical-warning/10 text-clinical-warning border border-clinical-warning/30'
                  : recordingState === 'warming_up'
                    ? 'bg-amber-500/10 text-amber-500 border border-amber-500/30'
                    : recordingState === 'initializing' || recordingState === 'stopping'
                      ? 'bg-clinical-warning/10 text-clinical-warning border border-clinical-warning/30'
                      : 'bg-clinical-ready/10 text-clinical-ready border border-clinical-ready/30'
                }`}
            >
              <span
                className={`w-2 h-2 rounded-full mr-2 ${recordingState === 'recording'
                  ? 'bg-clinical-record animate-pulse'
                  : recordingState === 'paused'
                    ? 'bg-clinical-warning'
                    : recordingState === 'warming_up'
                      ? 'bg-amber-500 animate-ping'
                      : recordingState === 'initializing' || recordingState === 'stopping'
                        ? 'bg-clinical-warning animate-pulse'
                        : 'bg-clinical-ready'
                  }`}
              />
              {recordingState === 'recording'
                ? 'REC'
                : recordingState === 'paused'
                  ? 'PAUSED'
                  : recordingState === 'warming_up'
                    ? 'WARMING UP'
                    : recordingState === 'initializing'
                      ? 'STARTING'
                      : recordingState === 'stopping'
                        ? 'STOPPING'
                        : 'READY'}
            </span>

            {/* Warm-up countdown */}
            {recordingState === 'warming_up' && (
              <span className="text-sm text-amber-500">
                Camera focus{warmupRemaining !== null ? ` · ${Math.ceil(warmupRemaining)}s` : ''}
              </span>
            )}

            {/* Live recording metrics */}
            {(recordingState === 'recording' || recordingState === 'paused') && (
              <>
                {recordingDuration !== null && (
                  <span className="font-mono text-sm font-semibold text-clinical-text-primary dark:text-clinical-text-dark">
                    {formatDuration(recordingDuration)}
                  </span>
                )}
                {Object.keys(frameCounts).length > 0 && (
                  <span className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                    {Object.values(frameCounts).reduce((a, b) => a + b, 0).toLocaleString()} frames
                  </span>
                )}
                {currentFilenames['cam0_mp4'] && (
                  <span className="hidden lg:block text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary font-mono truncate max-w-[260px]" title={currentFilenames['cam0_mp4']}>
                    {currentFilenames['cam0_mp4']}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* CAMERAS - Main content, takes all available space */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-2 min-h-0">
        {/* Camera 1 */}
        <div className="bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded overflow-hidden flex flex-col">
          <div className="px-2 py-1 border-b border-clinical-border dark:border-clinical-dark-border flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${camOffline.cam0 ? 'bg-clinical-record' : 'bg-clinical-ready'}`} />
              <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">CAM1 — Front</span>
              {getCameraTypeLabel(0) && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${getCameraTypeLabel(0) === 'RealSense' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>
                  {getCameraTypeLabel(0)}
                </span>
              )}
            </div>
            <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary font-mono">{camerasInfo.find(c => c.camera_id === 0)?.frame_size?.join('×') || '—'}</span>
          </div>
          <div className="flex-1 bg-neutral-900 flex items-center justify-center overflow-hidden relative min-h-0">
            <img
              ref={cam0Ref}
              alt=""
              className="w-full h-full object-contain"
              onLoad={() => setCamOffline(prev => ({ ...prev, cam0: false }))}
              onError={() => setCamOffline(prev => ({ ...prev, cam0: true }))}
            />
            {camOffline.cam0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-400">
                <svg className="w-10 h-10 mb-2 text-neutral-500" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z" />
                </svg>
                <span className="text-sm font-medium">Camera 1 Offline</span>
                <span className="text-xs mt-1 text-neutral-500">Click Restart to reconnect</span>
              </div>
            )}
            <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-sm text-white font-mono">
              CAM1 | FRONT
            </div>
            {(recordingState === 'warming_up' || recordingState === 'recording') && (
              <div className={`absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded ${recordingState === 'warming_up' ? 'bg-amber-500' : 'bg-clinical-record'
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full bg-white ${recordingState === 'warming_up' ? 'animate-ping' : 'animate-pulse'}`} />
                <span className="text-sm text-white font-medium">
                  {recordingState === 'warming_up' ? 'WARM UP' : 'REC'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Camera 2 */}
        <div className="bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded overflow-hidden flex flex-col">
          <div className="px-2 py-1 border-b border-clinical-border dark:border-clinical-dark-border flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${camOffline.cam1 ? 'bg-clinical-record' : 'bg-clinical-ready'}`} />
              <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">CAM2 — Side</span>
              {getCameraTypeLabel(1) && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${getCameraTypeLabel(1) === 'RealSense' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>
                  {getCameraTypeLabel(1)}
                </span>
              )}
            </div>
            <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary font-mono">{camerasInfo.find(c => c.camera_id === 1)?.frame_size?.join('×') || '—'}</span>
          </div>
          <div className="flex-1 bg-neutral-900 flex items-center justify-center overflow-hidden relative min-h-0">
            <img
              ref={cam1Ref}
              alt=""
              className="w-full h-full object-contain"
              onLoad={() => setCamOffline(prev => ({ ...prev, cam1: false }))}
              onError={() => setCamOffline(prev => ({ ...prev, cam1: true }))}
            />
            {camOffline.cam1 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-400">
                <svg className="w-10 h-10 mb-2 text-neutral-500" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z" />
                </svg>
                <span className="text-sm font-medium">Camera 2 Offline</span>
                <span className="text-xs mt-1 text-neutral-500">Click Restart to reconnect</span>
              </div>
            )}
            <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-sm text-white font-mono">
              CAM2 | SIDE
            </div>
            {(recordingState === 'warming_up' || recordingState === 'recording') && (
              <div className={`absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded ${recordingState === 'warming_up' ? 'bg-amber-500' : 'bg-clinical-record'
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full bg-white ${recordingState === 'warming_up' ? 'animate-ping' : 'animate-pulse'}`} />
                <span className="text-sm text-white font-medium">
                  {recordingState === 'warming_up' ? 'WARM UP' : 'REC'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded p-3">
        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* Record button */}
          <button
            onClick={handleRecord}
            disabled={recordingState !== 'idle'}
            className={`flex items-center px-5 py-2 rounded text-sm font-semibold transition-colors ${recordingState !== 'idle'
              ? 'bg-clinical-border dark:bg-clinical-dark-border text-clinical-text-secondary cursor-not-allowed'
              : 'bg-clinical-record hover:bg-clinical-record-hover text-white'
              }`}
          >
            {recordingState === 'initializing' ? (
              <>
                <svg className="w-5 h-5 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Starting...
              </>
            ) : (
              <>
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="6" />
                </svg>
                Record
              </>
            )}
          </button>

          {/* Pause/Resume button */}
          <button
            onClick={recordingState === 'paused' ? handleResume : handlePause}
            disabled={recordingState === 'idle' || recordingState === 'initializing' || recordingState === 'warming_up' || recordingState === 'stopping'}
            className={`flex items-center px-5 py-2 rounded text-sm font-semibold transition-colors ${recordingState === 'idle' || recordingState === 'initializing' || recordingState === 'warming_up' || recordingState === 'stopping'
              ? 'bg-clinical-border dark:bg-clinical-dark-border text-clinical-text-secondary cursor-not-allowed'
              : 'bg-clinical-warning hover:brightness-95 text-white'
              }`}
          >
            {recordingState === 'paused' ? (
              <>
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Resume
              </>
            ) : (
              <>
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
                Pause
              </>
            )}
          </button>

          {/* Stop button */}
          <button
            onClick={handleStop}
            disabled={recordingState === 'idle' || recordingState === 'initializing' || recordingState === 'stopping'}
            className={`flex items-center px-5 py-2 rounded text-sm font-semibold transition-colors ${recordingState === 'idle' || recordingState === 'initializing' || recordingState === 'stopping'
              ? 'bg-clinical-border dark:bg-clinical-dark-border text-clinical-text-secondary cursor-not-allowed'
              : 'bg-clinical-neutral hover:bg-clinical-neutral-hover text-white'
              }`}
          >
            {recordingState === 'stopping' ? (
              <>
                <svg className="w-5 h-5 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Stopping...
              </>
            ) : (
              <>
                <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
                Stop & Save
              </>
            )}
          </button>

          {/* Swap Cameras button */}
          <button
            onClick={handleSwapCameras}
            disabled={recordingState !== 'idle' || isSwapping}
            title="Swap physical camera assignment for CAM1 (Front) and CAM2 (Side)"
            className={`flex items-center px-4 py-2 rounded text-sm font-semibold transition-colors border ${isSwapped
              ? 'bg-clinical-warning/10 border-clinical-warning/40 text-clinical-warning hover:bg-clinical-warning/20'
              : 'bg-clinical-bg dark:bg-clinical-dark-bg border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:bg-clinical-border dark:hover:bg-clinical-dark-border'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
            </svg>
            {isSwapped ? 'Cameras Swapped' : 'Swap Cameras'}
          </button>

          {/* Refresh Cameras button — just re-reads info */}
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Re-read camera info (non-destructive)"
            className="flex items-center px-4 py-2 rounded text-sm font-semibold transition-colors border bg-clinical-bg dark:bg-clinical-dark-bg border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:bg-clinical-border dark:hover:bg-clinical-dark-border disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRefreshing ? (
              <>
                <svg className="w-4 h-4 mr-1.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Refreshing…
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </>
            )}
          </button>

          {/* Restart Cameras button — hard pipeline restart */}
          <button
            onClick={handleRestart}
            disabled={isRestarting || recordingState !== 'idle'}
            title="Hard restart: stop cameras, re-detect, restart pipelines"
            className="flex items-center px-4 py-2 rounded text-sm font-semibold transition-colors border bg-clinical-record/10 border-clinical-record/30 text-clinical-record hover:bg-clinical-record/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRestarting ? (
              <>
                <svg className="w-4 h-4 mr-1.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Restarting…
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
                </svg>
                Restart
              </>
            )}
          </button>

          <span className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary ml-4">
            {getRecordingFormat()}
          </span>
        </div>
      </div>
    </div>
  );
}
