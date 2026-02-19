import { useState, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { API_URL } from '../config';

interface Batch {
  batch_id: string;
  camera1: string | null;  // MP4 for viewing
  camera2: string | null;
  camera1_hq: string | null;  // BAG for processing
  camera2_hq: string | null;
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

interface ProcessingJob {
  job_id: string;
  batch_id: string;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'cancelled';
  started_at: string;
  is_orphan?: boolean;
  camera1_progress: number;
  camera2_progress: number;
  camera1_status: string;
  camera2_status: string;
  camera1_step: string;
  camera2_step: string;
  camera1_result: string | null;
  camera2_result: string | null;
  camera1_error?: string;
  camera2_error?: string;
}

export default function Processing() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);
  const [currentJob, setCurrentJob] = useState<ProcessingJob | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasRecovered = useRef(false);
  const mountedRef = useRef(true);
  const isPollingInFlight = useRef(false);
  const isStarting = useRef(false);

  // Block in-app navigation while processing is active
  const blocker = useBlocker(isLoading);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      const leave = window.confirm('Processing is in progress. Are you sure you want to leave?');
      if (leave) {
        blocker.proceed();
      } else {
        blocker.reset();
      }
    }
  }, [blocker]);

  // fetch batches on mount
  useEffect(() => {
    fetchBatches();
  }, []);

  // check for active job after batches load
  useEffect(() => {
    const savedJobId = localStorage.getItem('processing_job_id');
    if (savedJobId && batches.length > 0 && !hasRecovered.current) {
      hasRecovered.current = true;
      recoverJobState(savedJobId);
    }
  }, [batches]);

  // save job id to localstorage when processing starts
  useEffect(() => {
    if (currentJob && (currentJob.status === 'processing' || currentJob.status === 'pending')) {
      localStorage.setItem('processing_job_id', currentJob.job_id);
    } else if (currentJob && ['completed', 'error', 'cancelled'].includes(currentJob.status)) {
      localStorage.removeItem('processing_job_id');
    }
  }, [currentJob]);

  // cleanup polling on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  // warn before closing or leaving if processing job is active
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (currentJob && (currentJob.status === 'processing' || currentJob.status === 'pending')) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentJob]);

  const fetchBatches = async () => {
    try {
      const res = await fetch(`${API_URL}/recordings/batches`);
      const data = await res.json();
      if (mountedRef.current) setBatches(data.batches);
    } catch (err) {
      console.error('Failed to fetch batches:', err);
      if (mountedRef.current) setError('Failed to load recordings');
    }
  };

  const recoverJobState = async (jobId: string) => {
    try {
      const res = await fetch(`${API_URL}/processing/status/${jobId}`);
      const data = await res.json();
      if (!mountedRef.current) return;

      if (data.success && data.job) {
        setCurrentJob(data.job);

        // find and select the batch for this job
        const batch = batches.find(b => b.batch_id === data.job.batch_id);
        if (batch) {
          setSelectedBatch(batch);
        }

        // resume polling if job is still active
        if (['pending', 'processing'].includes(data.job.status)) {
          setIsLoading(true);
          startStatusPolling(jobId);
        }
      } else {
        // job not found or invalid. clear localstorage
        localStorage.removeItem('processing_job_id');
      }
    } catch (err) {
      console.error('Failed to recover job state:', err);
      localStorage.removeItem('processing_job_id');
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

  const startProcessing = async () => {
    if (!selectedBatch) {
      setError('Please select a batch');
      return;
    }

    // Allow both complete and orphaned batches
    if (!selectedBatch.complete && !selectedBatch.orphaned) {
      setError('Please select a valid batch');
      return;
    }

    // Prevent double-submit
    if (isStarting.current || isLoading) return;
    isStarting.current = true;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/processing/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: selectedBatch.batch_id }),
      });

      const data = await res.json();
      if (!mountedRef.current) return;

      if (!data.success) {
        setError(data.message);
        setIsLoading(false);
        return;
      }

      // start polling for status
      startStatusPolling(data.job_id);
    } catch (err) {
      console.error('Failed to start processing:', err);
      if (mountedRef.current) {
        setError('Failed to start processing');
        setIsLoading(false);
      }
    } finally {
      isStarting.current = false;
    }
  };

  const startStatusPolling = (jobId: string) => {
    // clear any existing polling
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
    }

    // poll immediately
    pollJobStatus(jobId);

    // then poll every 500ms
    pollingRef.current = setInterval(() => {
      pollJobStatus(jobId);
    }, 500);
  };

  const pollJobStatus = async (jobId: string) => {
    // Prevent overlapping polls (if previous poll takes >500ms)
    if (isPollingInFlight.current) return;
    isPollingInFlight.current = true;

    try {
      const res = await fetch(`${API_URL}/processing/status/${jobId}`);
      const data = await res.json();
      if (!mountedRef.current) return;

      if (!data.success) {
        setError(data.message);
        stopPolling();
        return;
      }

      setCurrentJob(data.job);

      // stop polling if completed. error. or cancelled
      if (['completed', 'error', 'cancelled'].includes(data.job.status)) {
        stopPolling();
        setIsLoading(false);
      }
    } catch (err) {
      console.error('Failed to poll status:', err);
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

  const cancelProcessing = async () => {
    if (!currentJob) return;

    try {
      await fetch(`${API_URL}/processing/cancel/${currentJob.job_id}`, {
        method: 'POST',
      });
      stopPolling();
      setIsLoading(false);
      localStorage.removeItem('processing_job_id');
    } catch (err) {
      console.error('Failed to cancel processing:', err);
    }
  };

  const getProgressColor = (status: string) => {
    if (status === 'completed') return 'bg-clinical-ready';
    if (status === 'error') return 'bg-clinical-record';
    if (status === 'cancelled') return 'bg-clinical-neutral';
    return 'bg-clinical-blue';
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      processing: 'bg-clinical-blue/10 text-clinical-blue border border-clinical-blue/30',
      completed: 'bg-clinical-ready/10 text-clinical-ready border border-clinical-ready/30',
      error: 'bg-clinical-record/10 text-clinical-record border border-clinical-record/30',
      cancelled: 'bg-clinical-neutral/10 text-clinical-neutral border border-clinical-neutral/30',
      pending: 'bg-clinical-warning/10 text-clinical-warning border border-clinical-warning/30',
    };
    return styles[status] || 'bg-clinical-neutral/10 text-clinical-neutral border border-clinical-neutral/30';
  };

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
                const statusLabel = batch.complete
                  ? ' (Complete)'
                  : batch.orphaned
                  ? ` (Cam${batch.camera1_hq ? '1' : '2'} only)`
                  : ' (Empty)';
                return (
                  <option key={batch.batch_id} value={batch.batch_id}>
                    {dateLabel}{patientLabel} — {batch.batch_id}{statusLabel}
                  </option>
                );
              })}
            </select>
            <svg className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-clinical-text-secondary dark:text-clinical-text-dark-secondary pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
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
            {/* Patient metadata row */}
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
              <div className={`p-3 rounded border ${selectedBatch.camera1_hq ? 'bg-clinical-ready/5 border-clinical-ready/30' : 'bg-clinical-record/5 border-clinical-record/30'}`}>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 1 — Front</p>
                  {selectedBatch.camera1_type && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                      BAG
                    </span>
                  )}
                </div>
                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary truncate mt-1">
                  {selectedBatch.camera1_hq || 'Missing'}
                </p>
              </div>
              <div className={`p-3 rounded border ${selectedBatch.camera2_hq ? 'bg-clinical-ready/5 border-clinical-ready/30' : 'bg-clinical-record/5 border-clinical-record/30'}`}>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 2 — Side</p>
                  {selectedBatch.camera2_type && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                      BAG
                    </span>
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

      {/* Row 2: Processing status - expands to fill space */}
      <div className="flex-1 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded clinical-shadow p-4 min-h-0 overflow-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase tracking-wide">
            Processing Status
          </h3>
          {currentJob && (
            <span className={`px-3 py-1 rounded text-sm font-medium ${getStatusBadge(currentJob.status)}`}>
              {currentJob.status.toUpperCase()}
            </span>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-5 p-3 bg-clinical-record/5 border border-clinical-record/30 rounded text-clinical-record text-sm">
            {error}
          </div>
        )}

        {/* Progress bars */}
        <div className="space-y-6">
          {/* Camera 1 progress */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-base font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 1 — Front</span>
              <span className="text-base font-mono font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                {currentJob ? `${currentJob.camera1_progress}%` : '0%'}
              </span>
            </div>
            <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded h-3 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ease-out ${currentJob ? getProgressColor(currentJob.camera1_status) : 'bg-clinical-border'}`}
                style={{ width: `${currentJob?.camera1_progress || 0}%` }}
              />
            </div>
            <p className="mt-2 text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
              {currentJob?.camera1_step || 'Waiting to start...'}
            </p>
            {currentJob?.camera1_error && (
              <p className="mt-1.5 text-sm font-medium text-clinical-record">{currentJob.camera1_error}</p>
            )}
            {currentJob?.camera1_result && (
              <p className="mt-1.5 text-sm font-medium text-clinical-ready flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Saved: {currentJob.camera1_result}
              </p>
            )}
          </div>

          {/* Camera 2 progress */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-base font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 2 — Side</span>
              <span className="text-base font-mono font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                {currentJob ? `${currentJob.camera2_progress}%` : '0%'}
              </span>
            </div>
            <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded h-3 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ease-out ${currentJob ? getProgressColor(currentJob.camera2_status) : 'bg-clinical-border'}`}
                style={{ width: `${currentJob?.camera2_progress || 0}%` }}
              />
            </div>
            <p className="mt-2 text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
              {currentJob?.camera2_step || 'Waiting to start...'}
            </p>
            {currentJob?.camera2_error && (
              <p className="mt-1.5 text-sm font-medium text-clinical-record">{currentJob.camera2_error}</p>
            )}
            {currentJob?.camera2_result && (
              <p className="mt-1.5 text-sm font-medium text-clinical-ready flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Saved: {currentJob.camera2_result}
              </p>
            )}
          </div>
        </div>

        {/* Completion message */}
        {currentJob?.status === 'completed' && (
          <div className="mt-6 p-4 bg-clinical-ready/5 border border-clinical-ready/30 rounded">
            <p className="text-clinical-ready font-medium flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              Processing Complete
            </p>
            <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-sm mt-1">
              Results saved to /processed/ directory
            </p>
          </div>
        )}
      </div>

      {/* Row 3: Action buttons */}
      <div className="flex-shrink-0 bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded clinical-shadow p-4">
        <div className="flex justify-center gap-3">
          <button
            onClick={startProcessing}
            disabled={!(selectedBatch?.complete || selectedBatch?.orphaned) || isLoading}
            className="px-5 py-2 bg-clinical-blue hover:bg-clinical-blue-hover text-white rounded font-medium transition-colors disabled:bg-clinical-border dark:disabled:bg-clinical-dark-border disabled:text-clinical-text-secondary disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Processing...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                </svg>
                {selectedBatch?.orphaned ? 'Process Single Camera' : 'Start Processing'}
              </>
            )}
          </button>

          {isLoading && (
            <button
              onClick={cancelProcessing}
              className="px-5 py-2.5 bg-clinical-record hover:bg-clinical-record-hover text-white rounded font-medium transition-colors"
            >
              Cancel
            </button>
          )}
        </div>

        {!selectedBatch && (
          <p className="text-center text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-4">
            Select a batch to start processing
          </p>
        )}
        {selectedBatch && !selectedBatch.complete && !selectedBatch.orphaned && (
          <p className="text-center text-sm text-clinical-record mt-4">
            No camera files available for processing
          </p>
        )}
        {selectedBatch?.orphaned && (
          <p className="text-center text-sm text-clinical-warning mt-4">
            Single camera processing — Camera {selectedBatch.camera1_hq ? '1' : '2'} only
          </p>
        )}
      </div>
    </div>
  );
}
