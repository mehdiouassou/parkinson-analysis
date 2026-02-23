import { useState, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { API_URL } from '../config';

interface Batch {
  batch_id: string;
  camera1: string | null;
  camera2: string | null;
  camera1_hq: string | null;
  camera2_hq: string | null;
  camera1_has_mp4: boolean;
  camera2_has_mp4: boolean;
  camera1_type: 'realsense' | null;
  camera2_type: 'realsense' | null;
  complete: boolean;
  orphaned: boolean;
  type: 'batch' | 'orphan';
  modified: string | null;
  patient_name?: string;
  patient_id?: string;
  recorded_at?: string;
}

interface ConversionCameraSlot {
  enabled: boolean;
  status: 'pending' | 'skipped' | 'converting' | 'done' | 'failed' | 'cancelled';
  progress: number;
  frames_written: number;
  total_frames: number;
  encoder: string | null;
  error: string | null;
  mp4_file: string | null;
  output_size_mb: number | null;
}

interface ConversionJob {
  job_id: string;
  batch_id: string;
  status: 'pending' | 'converting' | 'done' | 'failed' | 'cancelled';
  force: boolean;
  created_at: string;
  completed_at: string | null;
  camera1: ConversionCameraSlot | null;
  camera2: ConversionCameraSlot | null;
  cancelled: boolean;
}

export default function Conversion() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [currentJob, setCurrentJob] = useState<ConversionJob | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasRecovered = useRef(false);
  const mountedRef = useRef(true);
  const isPollingInFlight = useRef(false);
  const isStarting = useRef(false);

  // Block in-app navigation while converting
  const blocker = useBlocker(isLoading);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      const leave = window.confirm('Conversion is in progress. Are you sure you want to leave?');
      if (leave) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);

  useEffect(() => {
    fetchBatches();
  }, []);

  useEffect(() => {
    const savedJobId = localStorage.getItem('conversion_job_id');
    if (savedJobId && batches.length > 0 && !hasRecovered.current) {
      hasRecovered.current = true;
      recoverJobState(savedJobId);
    }
  }, [batches]);

  useEffect(() => {
    if (currentJob && (currentJob.status === 'converting' || currentJob.status === 'pending')) {
      localStorage.setItem('conversion_job_id', currentJob.job_id);
    } else if (currentJob && ['done', 'failed', 'cancelled'].includes(currentJob.status)) {
      localStorage.removeItem('conversion_job_id');
    }
  }, [currentJob]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (currentJob && (currentJob.status === 'converting' || currentJob.status === 'pending')) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentJob]);

  // Auto-enable force when both cameras already have MP4
  useEffect(() => {
    if (selectedBatch && selectedBatch.camera1_has_mp4 && selectedBatch.camera2_has_mp4) {
      setForce(true);
    } else {
      setForce(false);
    }
  }, [selectedBatch]);

  const fetchBatches = async () => {
    try {
      const res = await fetch(`${API_URL}/recordings/batches`);
      const data = await res.json();
      if (mountedRef.current) setBatches(data.batches || []);
    } catch (err) {
      console.error('Failed to fetch batches:', err);
      if (mountedRef.current) setError('Failed to load recordings');
    }
  };

  const recoverJobState = async (jobId: string) => {
    try {
      const res = await fetch(`${API_URL}/conversion/status/${jobId}`);
      const data = await res.json();
      if (!mountedRef.current) return;

      if (data.success && data.job) {
        setCurrentJob(data.job);
        const batch = batches.find((b) => b.batch_id === data.job.batch_id);
        if (batch) setSelectedBatch(batch);

        if (['pending', 'converting'].includes(data.job.status)) {
          setIsLoading(true);
          startStatusPolling(jobId);
        }
      } else {
        localStorage.removeItem('conversion_job_id');
      }
    } catch {
      localStorage.removeItem('conversion_job_id');
    }
  };

  const handleBatchSelect = (batchId: string) => {
    const batch = batches.find((b) => b.batch_id === batchId);
    if (batch) {
      setSelectedBatch(batch);
      setCurrentJob(null);
      setError(null);
    }
  };

  const canStartConversion = (): boolean => {
    if (!selectedBatch) return false;
    return !!(selectedBatch.camera1_hq || selectedBatch.camera2_hq);
  };

  const startConversion = async () => {
    if (!selectedBatch || isStarting.current || isLoading) return;
    isStarting.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/conversion/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: selectedBatch.batch_id, force }),
      });
      const data = await res.json();
      if (!mountedRef.current) return;

      if (!data.success) {
        setError(data.message);
        setIsLoading(false);
        return;
      }

      startStatusPolling(data.job_id);
    } catch {
      if (mountedRef.current) {
        setError('Failed to start conversion');
        setIsLoading(false);
      }
    } finally {
      isStarting.current = false;
    }
  };

  const startStatusPolling = (jobId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollJobStatus(jobId);
    pollingRef.current = setInterval(() => pollJobStatus(jobId), 500);
  };

  const pollJobStatus = async (jobId: string) => {
    if (isPollingInFlight.current) return;
    isPollingInFlight.current = true;

    try {
      const res = await fetch(`${API_URL}/conversion/status/${jobId}`);
      const data = await res.json();
      if (!mountedRef.current) return;

      if (!data.success) {
        setError(data.message);
        stopPolling();
        return;
      }

      setCurrentJob(data.job);

      if (['done', 'failed', 'cancelled'].includes(data.job.status)) {
        stopPolling();
        setIsLoading(false);
        // Refresh batches so has_mp4 flags update
        fetchBatches();
      }
    } catch {
      // Network hiccup — keep polling
    } finally {
      isPollingInFlight.current = false;
    }
  };

  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  const cancelConversion = async () => {
    if (!currentJob) return;
    try {
      await fetch(`${API_URL}/conversion/cancel/${currentJob.job_id}`, { method: 'POST' });
      stopPolling();
      setIsLoading(false);
      localStorage.removeItem('conversion_job_id');
    } catch {
      console.error('Failed to cancel conversion');
    }
  };

  // ---- Display helpers ----

  const getCamProgressColor = (status: string) => {
    if (status === 'done') return 'bg-clinical-ready';
    if (status === 'skipped') return 'bg-clinical-neutral';
    if (status === 'failed') return 'bg-clinical-record';
    if (status === 'cancelled') return 'bg-clinical-neutral';
    return 'bg-clinical-blue';
  };

  const getJobStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      converting: 'bg-clinical-blue/10 text-clinical-blue border border-clinical-blue/30',
      done: 'bg-clinical-ready/10 text-clinical-ready border border-clinical-ready/30',
      failed: 'bg-clinical-record/10 text-clinical-record border border-clinical-record/30',
      cancelled: 'bg-clinical-neutral/10 text-clinical-neutral border border-clinical-neutral/30',
      pending: 'bg-clinical-warning/10 text-clinical-warning border border-clinical-warning/30',
    };
    return styles[status] || 'bg-clinical-neutral/10 text-clinical-neutral border border-clinical-neutral/30';
  };

  const getCamStatusLabel = (slot: ConversionCameraSlot): string => {
    switch (slot.status) {
      case 'pending': return 'Waiting...';
      case 'converting':
        return slot.total_frames > 0
          ? `Converting — ${slot.frames_written.toLocaleString()} / ${slot.total_frames.toLocaleString()} frames`
          : 'Converting...';
      case 'skipped': return 'Skipped — MP4 already exists';
      case 'done': return `Done — ${slot.mp4_file || ''}${slot.output_size_mb != null ? ` (${slot.output_size_mb} MB)` : ''}`;
      case 'failed': return 'Failed';
      case 'cancelled': return 'Cancelled';
      default: return slot.status;
    }
  };

  const hasBag = (batch: Batch, cam: 1 | 2) =>
    cam === 1 ? !!batch.camera1_hq : !!batch.camera2_hq;

  const hasMp4 = (batch: Batch, cam: 1 | 2) =>
    cam === 1 ? batch.camera1_has_mp4 : batch.camera2_has_mp4;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Row 1: Batch selection */}
      <div className="bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded clinical-shadow p-4 flex-shrink-0">
        <h3 className="text-base font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase tracking-wide mb-4">
          Select Recording Batch
        </h3>
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <select
              value={selectedBatch?.batch_id || ''}
              onChange={(e) => handleBatchSelect(e.target.value)}
              disabled={isLoading}
              className="w-full px-4 pr-12 py-3 text-base bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border rounded text-clinical-text-primary dark:text-clinical-text-dark focus:ring-2 focus:ring-clinical-blue/30 focus:border-clinical-blue disabled:opacity-50 appearance-none cursor-pointer"
            >
              <option value="">Select a recording batch...</option>
              {batches.map((batch) => {
                const dateStr = batch.recorded_at || batch.modified;
                const dateLabel = dateStr
                  ? new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
                  : '—';
                const patientLabel = batch.patient_name ? ` — ${batch.patient_name}` : '';
                const camFlags = [
                  batch.camera1_hq ? `Cam1${batch.camera1_has_mp4 ? '✓' : ''}` : null,
                  batch.camera2_hq ? `Cam2${batch.camera2_has_mp4 ? '✓' : ''}` : null,
                ].filter(Boolean).join(' ');
                return (
                  <option key={batch.batch_id} value={batch.batch_id}>
                    {dateLabel}{patientLabel} — {batch.batch_id} [{camFlags}]
                  </option>
                );
              })}
            </select>
            <svg className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-clinical-text-secondary dark:text-clinical-text-dark-secondary pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
          <button
            onClick={fetchBatches}
            disabled={isLoading}
            className="px-5 py-3 text-base font-medium bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        {/* Selected batch info */}
        {selectedBatch && (
          <div className="mt-4">
            {selectedBatch.orphaned && (
              <div className="mb-3 px-3 py-2 bg-clinical-warning/10 border border-clinical-warning/30 rounded">
                <p className="text-sm text-clinical-warning font-medium">⚠ Orphaned Recording — Only one camera file available</p>
              </div>
            )}
            {(selectedBatch.patient_name || selectedBatch.patient_id) && (
              <div className="mb-3 flex items-center gap-3 flex-wrap">
                {selectedBatch.patient_name && (
                  <span className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                    Patient: <span className="font-medium text-clinical-text-primary dark:text-clinical-text-dark">{selectedBatch.patient_name}</span>
                  </span>
                )}
                {selectedBatch.patient_id && (
                  <span className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                    ID: <span className="font-medium text-clinical-text-primary dark:text-clinical-text-dark">{selectedBatch.patient_id}</span>
                  </span>
                )}
                {selectedBatch.recorded_at && (
                  <span className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                    Recorded: <span className="font-medium text-clinical-text-primary dark:text-clinical-text-dark">{new Date(selectedBatch.recorded_at).toLocaleString()}</span>
                  </span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              {/* Camera 1 */}
              <div className={`p-3 rounded border ${hasBag(selectedBatch, 1) ? 'bg-clinical-ready/5 border-clinical-ready/30' : 'bg-clinical-record/5 border-clinical-record/30'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 1 — Front</p>
                  {hasBag(selectedBatch, 1) && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">BAG</span>
                  )}
                  {hasMp4(selectedBatch, 1) && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-clinical-ready/20 text-clinical-ready">MP4 ✓</span>
                  )}
                </div>
                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary truncate mt-1">
                  {selectedBatch.camera1_hq || 'Missing'}
                </p>
              </div>
              {/* Camera 2 */}
              <div className={`p-3 rounded border ${hasBag(selectedBatch, 2) ? 'bg-clinical-ready/5 border-clinical-ready/30' : 'bg-clinical-record/5 border-clinical-record/30'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 2 — Side</p>
                  {hasBag(selectedBatch, 2) && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">BAG</span>
                  )}
                  {hasMp4(selectedBatch, 2) && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-clinical-ready/20 text-clinical-ready">MP4 ✓</span>
                  )}
                </div>
                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary truncate mt-1">
                  {selectedBatch.camera2_hq || 'Missing'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Row 2: Conversion status */}
      <div className="flex-1 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded clinical-shadow p-4 min-h-0 overflow-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase tracking-wide">
            Conversion Status
          </h3>
          {currentJob && (
            <span className={`px-3 py-1 rounded text-sm font-medium ${getJobStatusBadge(currentJob.status)}`}>
              {currentJob.status.toUpperCase()}
            </span>
          )}
        </div>

        {error && (
          <div className="mb-5 p-3 bg-clinical-record/5 border border-clinical-record/30 rounded text-clinical-record text-sm">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {[
            { label: 'Camera 1 — Front', slot: currentJob?.camera1 },
            { label: 'Camera 2 — Side', slot: currentJob?.camera2 },
          ].map(({ label, slot }) => (
            <div key={label}>
              <div className="flex justify-between items-center mb-2 gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-base font-medium text-clinical-text-primary dark:text-clinical-text-dark">{label}</span>
                  {slot?.encoder && (
                    <span className={`px-1.5 py-0.5 text-xs font-medium rounded ${!slot.encoder.startsWith('libx')
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                      }`}>
                      {!slot.encoder.startsWith('libx') ? 'HW Accel' : 'CPU'}
                    </span>
                  )}
                </div>
                <span className="text-base font-mono font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                  {slot ? `${slot.progress}%` : '—'}
                </span>
              </div>
              <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded h-3 overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ease-out ${slot ? getCamProgressColor(slot.status) : 'bg-clinical-border'}`}
                  style={{ width: `${slot?.progress ?? 0}%` }}
                />
              </div>
              <p className="mt-2 text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                {slot ? getCamStatusLabel(slot) : 'Waiting to start...'}
              </p>
              {slot?.error && (
                <p className="mt-1.5 text-sm font-medium text-clinical-record">{slot.error}</p>
              )}
              {slot?.status === 'done' && slot.mp4_file && (
                <p className="mt-1.5 text-sm font-medium text-clinical-ready flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {slot.mp4_file}
                  {slot.output_size_mb != null && (
                    <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary font-normal ml-1">({slot.output_size_mb} MB)</span>
                  )}
                </p>
              )}
            </div>
          ))}
        </div>

        {currentJob?.status === 'done' && (
          <div className="mt-6 p-4 bg-clinical-ready/5 border border-clinical-ready/30 rounded">
            <p className="text-clinical-ready font-medium flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Conversion Complete
            </p>
            <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-sm mt-1">
              MP4 files are ready for viewing and tagging.
            </p>
          </div>
        )}

        {currentJob?.status === 'failed' && (
          <div className="mt-6 p-4 bg-clinical-record/5 border border-clinical-record/30 rounded">
            <p className="text-clinical-record font-medium">Conversion failed</p>
            <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-sm mt-1">
              Check the error messages above. You can retry with Force re-convert enabled.
            </p>
          </div>
        )}
      </div>

      {/* Row 3: Action buttons */}
      <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded clinical-shadow p-4">
        {/* Force checkbox */}
        {selectedBatch && !isLoading && (
          <div className="flex justify-center mb-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                className="w-4 h-4 rounded border-clinical-border accent-clinical-blue"
              />
              <span className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                Force re-convert (overwrite existing MP4)
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-center gap-3">
          <button
            onClick={startConversion}
            disabled={!canStartConversion() || isLoading}
            className="px-5 py-2 bg-clinical-blue hover:bg-clinical-blue-hover text-white rounded font-medium transition-colors disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Converting...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                {selectedBatch?.orphaned ? 'Convert Single Camera' : 'Start Conversion'}
              </>
            )}
          </button>

          {isLoading && (
            <button
              onClick={cancelConversion}
              className="px-5 py-2 bg-clinical-record hover:bg-clinical-record-hover text-white rounded font-medium transition-colors"
            >
              Cancel
            </button>
          )}
        </div>

        {!selectedBatch && (
          <p className="text-center text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-4">
            Select a batch to start BAG→MP4 conversion
          </p>
        )}
        {selectedBatch && !canStartConversion() && (
          <p className="text-center text-sm text-clinical-record mt-4">
            No BAG files found for this batch
          </p>
        )}
        {selectedBatch?.orphaned && (
          <p className="text-center text-sm text-clinical-warning mt-4">
            Single camera — Camera {selectedBatch.camera1_hq ? '1' : '2'} only
          </p>
        )}
        {selectedBatch && !force && (selectedBatch.camera1_has_mp4 || selectedBatch.camera2_has_mp4) && !isLoading && (
          <p className="text-center text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-3">
            Cameras with an existing MP4 will be skipped. Enable <strong>Force re-convert</strong> to regenerate them.
          </p>
        )}
      </div>
    </div>
  );
}
