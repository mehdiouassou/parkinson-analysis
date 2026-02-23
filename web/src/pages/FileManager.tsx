import { useState, useEffect, useRef } from 'react';
import { useToast } from '../components/Toast';
import { API_URL } from '../config';

interface VideoFile {
  name: string;
  size: number;
}

interface DownloadProgress {
  received: number;
  total: number;
  speed: number;
  percentage: number;
}

interface VideoBatch {
  batch_id: string;
  camera1: VideoFile | null;
  camera2: VideoFile | null;
  camera1_size: number;        // Combined BAG+MP4
  camera2_size: number;
  camera1_hq_size: number;     // BAG size
  camera2_hq_size: number;
  camera1_mp4_size: number;
  camera2_mp4_size: number;
  camera1_bag_name: string | null;  // BAG filename for direct download
  camera2_bag_name: string | null;
  camera1_type: 'realsense' | null;
  camera2_type: 'realsense' | null;
  modified: string;
  patient_name?: string;
  patient_id?: string;
  recorded_at?: string;
}

interface FileInfo {
  name: string;
  size: number;
  modified: string;
}

interface CameraQuality {
  bag_exists: boolean;
  mp4_exists: boolean;
  mp4_frames: number | null;
  mp4_frames_from_sidecar: number | null;
  bag_frames?: number | null;
  bag_frames_source?: string;
  bag_expected_frames?: number | null;
  bag_dropped_frames?: number | null;
  real_fps?: number | null;
  frame_difference: number | null;
  drop_rate_percent: number | null;
  fps: number;
  bag_size_mb?: number;
  mp4_size_mb?: number;
  recording_started_at?: string | null;
  recording_stopped_at?: string | null;
  inter_camera_offset_ms?: number;
  pipeline_restart_ms?: number;
  first_hw_timestamp?: number | null;
  last_hw_timestamp?: number | null;
  hw_timestamp_domain?: string | null;
  frames_at_stop?: number | null;
}

interface QualitySync {
  cam1_mp4_frames: number;
  cam2_mp4_frames: number;
  frame_count_difference: number;
  time_offset_seconds: number;
  in_sync: boolean;
  // BAG-level sync (pre-conversion)
  cam1_bag_frames?: number;
  cam2_bag_frames?: number;
  bag_frame_count_difference?: number;
  bag_time_offset_seconds?: number;
  // Recording start offset (ground truth from pipeline timestamps)
  recording_start_offset_ms?: number;
  cam1_pipeline_restart_ms?: number;
  cam2_pipeline_restart_ms?: number;
  sync_quality?: 'excellent' | 'good' | 'fair' | 'poor';
  warning?: string;
}

interface QualityData {
  batch_id: string;
  cameras: {
    camera1: CameraQuality;
    camera2: CameraQuality;
  };
  sync: QualitySync | null;
}

interface AllFiles {
  videos: VideoBatch[];
  csvs: FileInfo[];
  jsons: FileInfo[];
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

export default function FileManager() {
  const [files, setFiles] = useState<AllFiles>({ videos: [], csvs: [], jsons: [] });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'videos' | 'csvs' | 'jsons'>('videos');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [downloadControllers, setDownloadControllers] = useState<Record<string, AbortController>>({});
  const mountedRef = useRef(true);
  const { showToast } = useToast();

  // Cleanup on unmount - abort all active downloads
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort all active downloads
      Object.values(downloadControllers).forEach(c => c.abort());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear delete confirmation when switching tabs
  useEffect(() => {
    setDeleteConfirm(null);
  }, [activeTab]);

  const cancelDownload = (filename: string) => {
    const controller = downloadControllers[filename];
    if (controller) {
      controller.abort();
      setDownloadControllers(prev => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
    }
  };

  // Quality analysis modal state
  const [qualityBatchId, setQualityBatchId] = useState<string | null>(null);
  const [qualityData, setQualityData] = useState<QualityData | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityElapsed, setQualityElapsed] = useState(0);

  // File viewer modal state
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewContent, setViewContent] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'csv' | 'json' | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Close modals on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (qualityBatchId) {
          setQualityBatchId(null);
          setQualityData(null);
        } else if (viewingFile) {
          setViewingFile(null);
          setViewContent(null);
          setViewType(null);
        }
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [viewingFile, qualityBatchId]);

  // Tick elapsed time while quality analysis is running
  useEffect(() => {
    if (!qualityLoading) {
      setQualityElapsed(0);
      return;
    }
    setQualityElapsed(0);
    const interval = setInterval(() => setQualityElapsed(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, [qualityLoading]);

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/files/all`);
      const data = await res.json();
      if (mountedRef.current) setFiles({
        videos: data.videos || [],
        csvs: data.csvs || [],
        jsons: data.jsons || [],
      });
    } catch (error) {
      console.error('Failed to fetch files:', error);
    }
    if (mountedRef.current) setLoading(false);
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  const handleDeleteVideoBatch = async (batchId: string) => {
    try {
      const res = await fetch(`${API_URL}/files/video/${batchId}`, { method: 'DELETE' });
      const result = await res.json();
      if (result.success) {
        showToast(`Deleted batch ${batchId}`, 'success');
        fetchFiles();
      } else {
        showToast('Failed to delete: ' + (result.message || result.errors?.join(', ')), 'error');
      }
    } catch (error) {
      console.error('Delete failed:', error);
      showToast('Delete failed', 'error');
    }
    setDeleteConfirm(null);
  };

  const handleDeleteSingleVideo = async (filename: string) => {
    try {
      const res = await fetch(`${API_URL}/files/video/single/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const result = await res.json();
      if (result.success) {
        showToast(`Deleted ${filename}`, 'success');
        fetchFiles();
      } else {
        showToast('Failed to delete: ' + result.message, 'error');
      }
    } catch (error) {
      console.error('Delete failed:', error);
      showToast('Delete failed', 'error');
    }
    setDeleteConfirm(null);
  };

  const handleDeleteCsv = async (filename: string) => {
    try {
      const res = await fetch(`${API_URL}/files/csv/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const result = await res.json();
      if (result.success) {
        showToast(`Deleted ${filename}`, 'success');
        fetchFiles();
      } else {
        showToast('Failed to delete: ' + result.message, 'error');
      }
    } catch (error) {
      console.error('Delete failed:', error);
      showToast('Delete failed', 'error');
    }
    setDeleteConfirm(null);
  };

  const handleDeleteJson = async (filename: string) => {
    try {
      const res = await fetch(`${API_URL}/files/json/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const result = await res.json();
      if (result.success) {
        showToast(`Deleted ${filename}`, 'success');
        fetchFiles();
      } else {
        showToast('Failed to delete: ' + result.message, 'error');
      }
    } catch (error) {
      console.error('Delete failed:', error);
      showToast('Delete failed', 'error');
    }
    setDeleteConfirm(null);
  };



  const downloadFile = async (type: 'video' | 'bag' | 'csv' | 'json', filename: string) => {
    // Prevent starting duplicate download
    if (downloadControllers[filename]) return;

    const controller = new AbortController();
    setDownloadControllers(prev => ({ ...prev, [filename]: controller }));
    setDownloadingFiles(prev => new Set(prev).add(filename));

    try {
      const url = `${API_URL}/files/download/${type}/${encodeURIComponent(filename)}`;

      // Use streaming with progress tracking for all file types so the user
      // always sees a progress bar, whether downloading a BAG, MP4, CSV, or JSON.
      showToast(`Starting download of ${filename}...`, 'info');
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) throw new Error('Download failed');

      const contentLength = res.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      if (!res.body) throw new Error('ReadableStream not supported');

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastUpdate = Date.now();
      let lastReceived = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          chunks.push(value);
          received += value.length;
        }

        const now = Date.now();
        // Update progress every 200ms to avoid too many React renders
        if (now - lastUpdate > 200) {
          const elapsed = (now - lastUpdate) / 1000;
          const bytesSinceLast = received - lastReceived;
          const speed = elapsed > 0 ? bytesSinceLast / elapsed : 0;

          if (mountedRef.current) {
            setDownloadProgress(prev => ({
              ...prev,
              [filename]: {
                received,
                total,
                speed,
                percentage: total ? Math.round((received / total) * 100) : 0
              }
            }));
          }

          lastUpdate = now;
          lastReceived = received;
        }
      }

      // Only trigger browser download if still mounted
      if (mountedRef.current) {
        const blob = new Blob(chunks as BlobPart[]);
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);
      }

      if (mountedRef.current) showToast(`Downloaded ${filename}`, 'success');

      // Cleanup on success
      setTimeout(() => {
        if (mountedRef.current) {
          setDownloadProgress(prev => {
            const next = { ...prev };
            delete next[filename];
            return next;
          });
        }
      }, 2000);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        if (mountedRef.current) {
          showToast('Download cancelled', 'info');
          setDownloadProgress(prev => {
            const next = { ...prev };
            delete next[filename];
            return next;
          });
        }
      } else {
        console.error('Download failed:', error);
        if (mountedRef.current) {
          showToast(`Failed to download ${filename}`, 'error');
          setTimeout(() => {
            if (mountedRef.current) {
              setDownloadProgress(prev => {
                const next = { ...prev };
                delete next[filename];
                return next;
              });
            }
          }, 2000);
        }
      }
    } finally {
      if (mountedRef.current) {
        setDownloadingFiles(prev => {
          const next = new Set(prev);
          next.delete(filename);
          return next;
        });
        setDownloadControllers(prev => {
          const next = { ...prev };
          delete next[filename];
          return next;
        });
      }
    }
  };

  const viewFile = async (type: 'csv' | 'json', filename: string) => {
    setViewLoading(true);
    setViewingFile(filename);
    setViewType(type);
    setViewContent(null);

    try {
      const url = `${API_URL}/files/download/${type}/${encodeURIComponent(filename)}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error('Failed to load file');
      }

      const text = await res.text();
      setViewContent(text);
    } catch (error) {
      console.error('View failed:', error);
      showToast(`Failed to load ${filename}`, 'error');
      closeViewer();
    }

    setViewLoading(false);
  };

  const closeViewer = () => {
    setViewingFile(null);
    setViewContent(null);
    setViewType(null);
  };

  const handleQualityCheck = async (batchId: string) => {
    setQualityBatchId(batchId);
    setQualityData(null);
    setQualityLoading(true);
    try {
      const res = await fetch(`${API_URL}/recordings/frame-comparison/${encodeURIComponent(batchId)}`);
      if (!res.ok) throw new Error('Failed to load quality data');
      const data: QualityData = await res.json();
      if (mountedRef.current) setQualityData(data);
    } catch (error) {
      console.error('Quality check failed:', error);
      showToast('Failed to load quality data', 'error');
      if (mountedRef.current) setQualityBatchId(null);
    }
    if (mountedRef.current) setQualityLoading(false);
  };

  const closeQualityModal = () => {
    setQualityBatchId(null);
    setQualityData(null);
  };

  // Parse CSV into rows and columns
  const parseCSV = (text: string): { headers: string[]; rows: string[][] } => {
    const lines = text.trim().split('\n');
    if (lines.length === 0) return { headers: [], rows: [] };

    const headers = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(line => line.split(',').map(cell => cell.trim()));

    return { headers, rows };
  };

  // Syntax highlight JSON
  const highlightJSON = (json: string): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    let key = 0;

    // Match different JSON tokens
    const regex = /("[^"]*")\s*:|"[^"]*"|\b(true|false|null)\b|-?\d+\.?\d*([eE][+-]?\d+)?|[{}\[\],:]|\s+/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(json)) !== null) {
      // Add any unmatched text
      if (match.index > lastIndex) {
        elements.push(<span key={key++}>{json.slice(lastIndex, match.index)}</span>);
      }

      const token = match[0];

      if (match[1]) {
        // Key (property name with colon)
        elements.push(
          <span key={key++}>
            <span className="text-purple-400">{match[1]}</span>
            <span className="text-clinical-text-secondary">:</span>
          </span>
        );
      } else if (token.startsWith('"')) {
        // String value
        elements.push(<span key={key++} className="text-emerald-400">{token}</span>);
      } else if (token === 'true' || token === 'false') {
        // Boolean
        elements.push(<span key={key++} className="text-amber-400">{token}</span>);
      } else if (token === 'null') {
        // Null
        elements.push(<span key={key++} className="text-rose-400">{token}</span>);
      } else if (/^-?\d/.test(token)) {
        // Number
        elements.push(<span key={key++} className="text-cyan-400">{token}</span>);
      } else if (token === '{' || token === '}') {
        // Braces
        elements.push(<span key={key++} className="text-yellow-300">{token}</span>);
      } else if (token === '[' || token === ']') {
        // Brackets
        elements.push(<span key={key++} className="text-pink-300">{token}</span>);
      } else {
        // Punctuation, whitespace
        elements.push(<span key={key++}>{token}</span>);
      }

      lastIndex = regex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < json.length) {
      elements.push(<span key={key++}>{json.slice(lastIndex)}</span>);
    }

    return elements;
  };

  const tabs = [
    {
      id: 'videos' as const, label: 'Videos', count: files.videos.length, icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )
    },
    {
      id: 'csvs' as const, label: 'CSV Files', count: files.csvs.length, icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      )
    },
    {
      id: 'jsons' as const, label: 'JSON Files', count: files.jsons.length, icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      )
    },
  ];

  return (
    <div className="h-full flex flex-col bg-clinical-card dark:bg-clinical-dark-card border border-clinical-border dark:border-clinical-dark-border rounded clinical-shadow p-4">
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div>
          <h2 className="text-xl font-bold text-clinical-text-primary dark:text-clinical-text-dark">File Manager</h2>
          <p className="text-base text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">Manage recordings and analysis data</p>
        </div>
        <button
          onClick={fetchFiles}
          className="px-5 py-3 text-base font-medium bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary dark:text-clinical-text-dark-secondary rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border transition-colors flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-clinical-border dark:border-clinical-dark-border mb-4 flex-shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === tab.id
              ? 'text-clinical-blue border-b-2 border-clinical-blue'
              : 'text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:text-clinical-text-primary dark:hover:text-clinical-text-dark'
              }`}
          >
            {tab.icon}
            {tab.label}
            <span className={`ml-1 px-2.5 py-1 text-sm font-medium rounded ${activeTab === tab.id
              ? 'bg-clinical-blue/10 text-clinical-blue'
              : 'bg-clinical-bg dark:bg-clinical-dark-bg text-clinical-text-secondary dark:text-clinical-text-dark-secondary'
              }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-clinical-blue mx-auto"></div>
            <p className="mt-4 text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Loading files...</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto min-h-0">
          {/* Videos tab */}
          {activeTab === 'videos' && (
            <div className="space-y-3">
              {files.videos.length === 0 ? (
                <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-center py-8">No video recordings found</p>
              ) : (
                files.videos.map((batch) => (
                  <div
                    key={batch.batch_id}
                    className="border border-clinical-border dark:border-clinical-dark-border rounded p-4 hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-clinical-text-primary dark:text-clinical-text-dark">{batch.batch_id}</h3>
                        {(batch.patient_name || batch.patient_id) && (
                          <p className="text-sm font-medium text-clinical-blue mt-0.5">
                            {batch.patient_name}
                            {batch.patient_name && batch.patient_id && <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary font-normal"> · </span>}
                            {batch.patient_id && <span className="font-mono text-clinical-text-secondary dark:text-clinical-text-dark-secondary font-normal">{batch.patient_id}</span>}
                          </p>
                        )}
                        <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">
                          {formatDate(batch.modified)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Quality Analysis button */}
                        <button
                          onClick={() => handleQualityCheck(batch.batch_id)}
                          className="px-3 py-1.5 bg-clinical-blue/10 text-clinical-blue text-sm rounded hover:bg-clinical-blue/20 transition-colors flex items-center gap-1.5"
                          title="Analyse sync quality between cameras"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                          </svg>
                          Quality
                        </button>
                        {deleteConfirm === batch.batch_id ? (
                          <>
                            <span className="text-sm text-clinical-record mr-2">Delete both files?</span>
                            <button
                              onClick={() => handleDeleteVideoBatch(batch.batch_id)}
                              className="px-3 py-1 bg-clinical-record text-white text-sm rounded hover:bg-clinical-record-hover transition-colors"
                            >
                              Yes
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-3 py-1 bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary text-sm rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border transition-colors"
                            >
                              No
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(batch.batch_id)}
                            className="px-3 py-1.5 bg-clinical-record/10 text-clinical-record text-sm rounded hover:bg-clinical-record/20 transition-colors"
                          >
                            Delete Batch
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-4">
                      {/* Camera 1 */}
                      <div className="bg-clinical-bg dark:bg-clinical-dark-bg rounded p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 1</span>
                              {batch.camera1_type && (
                                <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                                  RealSense
                                </span>
                              )}
                            </div>
                            {batch.camera1 ? (
                              <>
                                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{formatFileSize(batch.camera1_size)}</p>
                                <p className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-0.5">
                                  BAG: {formatFileSize(batch.camera1_hq_size || 0)} | MP4: {formatFileSize(batch.camera1_mp4_size || 0)}
                                </p>
                              </>
                            ) : (
                              <p className="text-sm text-clinical-record">Missing</p>
                            )}
                          </div>
                          {batch.camera1 && (
                            <div className="flex gap-1 flex-wrap justify-end">
                              <button
                                onClick={() => downloadFile('video', batch.camera1!.name)}
                                disabled={downloadingFiles.has(batch.camera1!.name)}
                                className="px-2 py-1 bg-clinical-blue/10 text-clinical-blue text-sm rounded hover:bg-clinical-blue/20 disabled:opacity-50 transition-colors"
                                title="Download MP4 preview"
                              >
                                {downloadingFiles.has(batch.camera1!.name) ? '...' : 'MP4'}
                              </button>
                              {batch.camera1_bag_name && (
                                <button
                                  onClick={() => downloadFile('bag', batch.camera1_bag_name!)}
                                  disabled={downloadingFiles.has(batch.camera1_bag_name!)}
                                  className="px-2 py-1 bg-purple-500/10 text-purple-500 text-sm rounded hover:bg-purple-500/20 disabled:opacity-50 transition-colors"
                                  title="Download BAG (RealSense depth+RGB)"
                                >
                                  {downloadingFiles.has(batch.camera1_bag_name!) ? '...' : 'BAG'}
                                </button>
                              )}
                              {deleteConfirm === `cam1-${batch.batch_id}` ? (
                                <button
                                  onClick={() => handleDeleteSingleVideo(batch.camera1!.name)}
                                  className="px-2 py-1 bg-clinical-record text-clinical-bg text-sm rounded hover:bg-clinical-record/90 transition-colors"
                                >
                                  Confirm
                                </button>
                              ) : (
                                <button
                                  onClick={() => setDeleteConfirm(`cam1-${batch.batch_id}`)}
                                  className="px-2 py-1 bg-clinical-record/10 text-clinical-record text-sm rounded hover:bg-clinical-record/20 transition-colors"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        {/* MP4 download progress for Camera 1 */}
                        {batch.camera1 && downloadProgress[batch.camera1.name] && (
                          <div className="mt-3 border-t border-clinical-border dark:border-clinical-dark-border pt-2">
                            <div className="flex justify-between text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary mb-1">
                              <span>Downloading MP4... {downloadProgress[batch.camera1.name].percentage}%</span>
                              <div className="flex items-center gap-2">
                                <span>
                                  {formatFileSize(downloadProgress[batch.camera1.name].received)} / {formatFileSize(downloadProgress[batch.camera1.name].total)}
                                  <span className="mx-1 text-clinical-border dark:text-clinical-dark-border">|</span>
                                  {formatSpeed(downloadProgress[batch.camera1.name].speed)}
                                </span>
                                <button
                                  onClick={() => cancelDownload(batch.camera1!.name)}
                                  className="p-0.5 rounded-full hover:bg-clinical-record/10 text-clinical-text-secondary hover:text-clinical-record transition-colors"
                                  title="Cancel download"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-clinical-blue h-full transition-all duration-300 ease-out"
                                style={{ width: `${downloadProgress[batch.camera1.name].percentage}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {/* BAG download progress for Camera 1 */}
                        {batch.camera1_bag_name && downloadProgress[batch.camera1_bag_name] && (
                          <div className="mt-3 border-t border-clinical-border dark:border-clinical-dark-border pt-2">
                            <div className="flex justify-between text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary mb-1">
                              <span>Downloading BAG... {downloadProgress[batch.camera1_bag_name].percentage}%</span>
                              <div className="flex items-center gap-2">
                                <span>
                                  {formatFileSize(downloadProgress[batch.camera1_bag_name].received)} / {formatFileSize(downloadProgress[batch.camera1_bag_name].total)}
                                  <span className="mx-1 text-clinical-border dark:text-clinical-dark-border">|</span>
                                  {formatSpeed(downloadProgress[batch.camera1_bag_name].speed)}
                                </span>
                                <button
                                  onClick={() => cancelDownload(batch.camera1_bag_name!)}
                                  className="p-0.5 rounded-full hover:bg-clinical-record/10 text-clinical-text-secondary hover:text-clinical-record transition-colors"
                                  title="Cancel download"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-purple-500 h-full transition-all duration-300 ease-out"
                                style={{ width: `${downloadProgress[batch.camera1_bag_name].percentage}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Camera 2 */}
                      <div className="bg-clinical-bg dark:bg-clinical-dark-bg rounded p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">Camera 2</span>
                              {batch.camera2_type && (
                                <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                                  RealSense
                                </span>
                              )}
                            </div>
                            {batch.camera2 ? (
                              <>
                                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{formatFileSize(batch.camera2_size)}</p>
                                <p className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-0.5">
                                  BAG: {formatFileSize(batch.camera2_hq_size || 0)} | MP4: {formatFileSize(batch.camera2_mp4_size || 0)}
                                </p>
                              </>
                            ) : (
                              <p className="text-sm text-clinical-record">Missing</p>
                            )}
                          </div>
                          {batch.camera2 && (
                            <div className="flex gap-1 flex-wrap justify-end">
                              <button
                                onClick={() => downloadFile('video', batch.camera2!.name)}
                                disabled={downloadingFiles.has(batch.camera2!.name)}
                                className="px-2 py-1 bg-clinical-blue/10 text-clinical-blue text-sm rounded hover:bg-clinical-blue/20 disabled:opacity-50 transition-colors"
                                title="Download MP4 preview"
                              >
                                {downloadingFiles.has(batch.camera2!.name) ? '...' : 'MP4'}
                              </button>
                              {batch.camera2_bag_name && (
                                <button
                                  onClick={() => downloadFile('bag', batch.camera2_bag_name!)}
                                  disabled={downloadingFiles.has(batch.camera2_bag_name!)}
                                  className="px-2 py-1 bg-purple-500/10 text-purple-500 text-sm rounded hover:bg-purple-500/20 disabled:opacity-50 transition-colors"
                                  title="Download BAG (RealSense depth+RGB)"
                                >
                                  {downloadingFiles.has(batch.camera2_bag_name!) ? '...' : 'BAG'}
                                </button>
                              )}
                              {deleteConfirm === `cam2-${batch.batch_id}` ? (
                                <button
                                  onClick={() => handleDeleteSingleVideo(batch.camera2!.name)}
                                  className="px-2 py-1 bg-clinical-record text-clinical-bg text-sm rounded hover:bg-clinical-record/90 transition-colors"
                                >
                                  Confirm
                                </button>
                              ) : (
                                <button
                                  onClick={() => setDeleteConfirm(`cam2-${batch.batch_id}`)}
                                  className="px-2 py-1 bg-clinical-record/10 text-clinical-record text-sm rounded hover:bg-clinical-record/20 transition-colors"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        {/* MP4 download progress for Camera 2 */}
                        {batch.camera2 && downloadProgress[batch.camera2.name] && (
                          <div className="mt-3 border-t border-clinical-border dark:border-clinical-dark-border pt-2">
                            <div className="flex justify-between text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary mb-1">
                              <span>Downloading MP4... {downloadProgress[batch.camera2.name].percentage}%</span>
                              <div className="flex items-center gap-2">
                                <span>
                                  {formatFileSize(downloadProgress[batch.camera2.name].received)} / {formatFileSize(downloadProgress[batch.camera2.name].total)}
                                  <span className="mx-1 text-clinical-border dark:text-clinical-dark-border">|</span>
                                  {formatSpeed(downloadProgress[batch.camera2.name].speed)}
                                </span>
                                <button
                                  onClick={() => cancelDownload(batch.camera2!.name)}
                                  className="p-0.5 rounded-full hover:bg-clinical-record/10 text-clinical-text-secondary hover:text-clinical-record transition-colors"
                                  title="Cancel download"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-clinical-blue h-full transition-all duration-300 ease-out"
                                style={{ width: `${downloadProgress[batch.camera2.name].percentage}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {/* BAG download progress for Camera 2 */}
                        {batch.camera2_bag_name && downloadProgress[batch.camera2_bag_name] && (
                          <div className="mt-3 border-t border-clinical-border dark:border-clinical-dark-border pt-2">
                            <div className="flex justify-between text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary mb-1">
                              <span>Downloading BAG... {downloadProgress[batch.camera2_bag_name].percentage}%</span>
                              <div className="flex items-center gap-2">
                                <span>
                                  {formatFileSize(downloadProgress[batch.camera2_bag_name].received)} / {formatFileSize(downloadProgress[batch.camera2_bag_name].total)}
                                  <span className="mx-1 text-clinical-border dark:text-clinical-dark-border">|</span>
                                  {formatSpeed(downloadProgress[batch.camera2_bag_name].speed)}
                                </span>
                                <button
                                  onClick={() => cancelDownload(batch.camera2_bag_name!)}
                                  className="p-0.5 rounded-full hover:bg-clinical-record/10 text-clinical-text-secondary hover:text-clinical-record transition-colors"
                                  title="Cancel download"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <div className="w-full bg-clinical-border dark:bg-clinical-dark-border rounded-full h-1.5 overflow-hidden">
                              <div
                                className="bg-purple-500 h-full transition-all duration-300 ease-out"
                                style={{ width: `${downloadProgress[batch.camera2_bag_name].percentage}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* CSV tab */}
          {activeTab === 'csvs' && (
            <div className="space-y-2">
              {files.csvs.length === 0 ? (
                <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-center py-10 text-base">No CSV files found</p>
              ) : (
                <table className="w-full">
                  <thead className="bg-clinical-bg dark:bg-clinical-dark-bg">
                    <tr>
                      <th className="px-4 py-4 text-left text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Filename</th>
                      <th className="px-4 py-4 text-left text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Size</th>
                      <th className="px-4 py-4 text-left text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Modified</th>
                      <th className="px-4 py-4 text-right text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-clinical-border dark:divide-clinical-dark-border">
                    {files.csvs.map((file) => (
                      <tr key={file.name} className="hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors">
                        <td className="px-4 py-4 text-base text-clinical-text-primary dark:text-clinical-text-dark font-medium">{file.name}</td>
                        <td className="px-4 py-4 text-base text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{formatFileSize(file.size)}</td>
                        <td className="px-4 py-4 text-base text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{formatDate(file.modified)}</td>
                        <td className="px-4 py-4 text-right">
                          {deleteConfirm === `csv-${file.name}` ? (
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-sm font-medium text-clinical-record">Delete?</span>
                              <button
                                onClick={() => handleDeleteCsv(file.name)}
                                className="px-3 py-1.5 bg-clinical-record text-white text-sm font-medium rounded hover:bg-clinical-record-hover transition-colors"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-3 py-1.5 bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary text-sm font-medium rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border transition-colors"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => viewFile('csv', file.name)}
                                className="px-3 py-1.5 bg-clinical-ready/10 text-clinical-ready text-sm font-medium rounded hover:bg-clinical-ready/20 transition-colors"
                              >
                                View
                              </button>
                              <button
                                onClick={() => downloadFile('csv', file.name)}
                                disabled={downloadingFiles.has(file.name)}
                                className="px-3 py-1.5 bg-clinical-blue/10 text-clinical-blue text-sm font-medium rounded hover:bg-clinical-blue/20 disabled:opacity-50 transition-colors"
                              >
                                {downloadingFiles.has(file.name) ? 'Downloading...' : 'Download'}
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(`csv-${file.name}`)}
                                className="px-2 py-1 bg-clinical-record/10 text-clinical-record text-sm rounded hover:bg-clinical-record/20 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* JSON tab */}
          {activeTab === 'jsons' && (
            <div className="space-y-2">
              {files.jsons.length === 0 ? (
                <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-center py-10 text-base">No JSON files found</p>
              ) : (
                <table className="w-full">
                  <thead className="bg-clinical-bg dark:bg-clinical-dark-bg">
                    <tr>
                      <th className="px-4 py-4 text-left text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Filename</th>
                      <th className="px-4 py-4 text-left text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Size</th>
                      <th className="px-4 py-4 text-left text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Modified</th>
                      <th className="px-4 py-4 text-right text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-clinical-border dark:divide-clinical-dark-border">
                    {files.jsons.map((file) => (
                      <tr key={file.name} className="hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors">
                        <td className="px-4 py-4 text-base text-clinical-text-primary dark:text-clinical-text-dark font-medium">{file.name}</td>
                        <td className="px-4 py-4 text-base text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{formatFileSize(file.size)}</td>
                        <td className="px-4 py-4 text-base text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{formatDate(file.modified)}</td>
                        <td className="px-4 py-4 text-right">
                          {deleteConfirm === `json-${file.name}` ? (
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-sm font-medium text-clinical-record">Delete?</span>
                              <button
                                onClick={() => handleDeleteJson(file.name)}
                                className="px-3 py-1.5 bg-clinical-record text-white text-sm font-medium rounded hover:bg-clinical-record-hover transition-colors"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-3 py-1.5 bg-clinical-bg dark:bg-clinical-dark-bg border border-clinical-border dark:border-clinical-dark-border text-clinical-text-secondary text-sm font-medium rounded hover:bg-clinical-border dark:hover:bg-clinical-dark-border transition-colors"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => viewFile('json', file.name)}
                                className="px-3 py-1.5 bg-clinical-ready/10 text-clinical-ready text-sm font-medium rounded hover:bg-clinical-ready/20 transition-colors"
                              >
                                View
                              </button>
                              <button
                                onClick={() => downloadFile('json', file.name)}
                                disabled={downloadingFiles.has(file.name)}
                                className="px-3 py-1.5 bg-clinical-blue/10 text-clinical-blue text-sm font-medium rounded hover:bg-clinical-blue/20 disabled:opacity-50 transition-colors"
                              >
                                {downloadingFiles.has(file.name) ? 'Downloading...' : 'Download'}
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(`json-${file.name}`)}
                                className="px-3 py-1.5 bg-clinical-record/10 text-clinical-record text-sm font-medium rounded hover:bg-clinical-record/20 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

        </div>
      )}

      {/* Storage summary */}
      <div className="mt-4 pt-4 border-t border-clinical-border dark:border-clinical-dark-border flex-shrink-0">
        <h3 className="text-sm font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary uppercase tracking-wide mb-3">Storage Summary</h3>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-clinical-blue/5 dark:bg-clinical-blue/10 rounded p-4 border border-clinical-blue/20">
            <p className="text-sm text-clinical-blue font-medium">Videos Total</p>
            <p className="text-xl font-semibold text-clinical-text-primary dark:text-clinical-text-dark mt-1">
              {formatFileSize(
                files.videos.reduce((acc, b) => acc + b.camera1_size + b.camera2_size, 0)
              )}
            </p>
            <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">{files.videos.length} batches</p>
            <div className="mt-2 text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary space-y-0.5">
              <p>BAG: {formatFileSize(files.videos.reduce((acc, b) => acc + (b.camera1_hq_size || 0) + (b.camera2_hq_size || 0), 0))}</p>
              <p>MP4: {formatFileSize(files.videos.reduce((acc, b) => acc + (b.camera1_mp4_size || 0) + (b.camera2_mp4_size || 0), 0))}</p>
            </div>
          </div>
          <div className="bg-clinical-ready/5 dark:bg-clinical-ready/10 rounded p-4 border border-clinical-ready/20">
            <p className="text-sm text-clinical-ready font-medium">CSV Files</p>
            <p className="text-xl font-semibold text-clinical-text-primary dark:text-clinical-text-dark mt-1">
              {formatFileSize(files.csvs.reduce((acc, f) => acc + f.size, 0))}
            </p>
            <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">{files.csvs.length} files</p>
          </div>
          <div className="bg-clinical-warning/5 dark:bg-clinical-warning/10 rounded p-4 border border-clinical-warning/20">
            <p className="text-sm text-clinical-warning font-medium">JSON Files</p>
            <p className="text-xl font-semibold text-clinical-text-primary dark:text-clinical-text-dark mt-1">
              {formatFileSize(files.jsons.reduce((acc, f) => acc + f.size, 0))}
            </p>
            <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">{files.jsons.length} files</p>
          </div>
          <div className="bg-clinical-record/5 dark:bg-clinical-record/10 rounded p-4 border border-clinical-record/20">
            <p className="text-sm text-clinical-record font-medium">Total Storage</p>
            <p className="text-xl font-semibold text-clinical-text-primary dark:text-clinical-text-dark mt-1">
              {formatFileSize(
                files.videos.reduce((acc, b) => acc + b.camera1_size + b.camera2_size, 0) +
                files.csvs.reduce((acc, f) => acc + f.size, 0) +
                files.jsons.reduce((acc, f) => acc + f.size, 0)
              )}
            </p>
            <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">All files</p>
          </div>
        </div>
      </div>

      {/* Quality Analysis Modal */}
      {qualityBatchId && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={closeQualityModal}
        >
          <div
            className="bg-clinical-card dark:bg-clinical-dark-card rounded-xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-clinical-border dark:border-clinical-dark-border">
              <div className="flex items-center gap-2.5">
                <span className="px-2 py-0.5 text-xs font-bold tracking-wider rounded bg-clinical-blue/10 text-clinical-blue">QUALITY</span>
                <h2 className="text-sm font-semibold font-mono text-clinical-text-primary dark:text-clinical-text-dark truncate">{qualityBatchId}</h2>
              </div>
              <button
                onClick={closeQualityModal}
                className="p-1.5 rounded text-clinical-text-secondary hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-5">
              {qualityLoading ? (() => {
                const batch = files.videos.find(b => b.batch_id === qualityBatchId);
                const fmtSize = (bytes: number) =>
                  bytes >= 1073741824
                    ? `${(bytes / 1073741824).toFixed(1)} GB`
                    : `${(bytes / 1048576).toFixed(0)} MB`;
                const bag1 = batch?.camera1_hq_size ? fmtSize(batch.camera1_hq_size) : null;
                const bag2 = batch?.camera2_hq_size ? fmtSize(batch.camera2_hq_size) : null;
                const sizeHint = bag1 && bag2 ? `${bag1} + ${bag2}` : bag1 ?? bag2 ?? null;
                return (
                  <div className="py-6 space-y-4">
                    <div className="text-center space-y-1">
                      <p className="text-sm font-medium text-clinical-text-primary dark:text-clinical-text-dark">
                        Replaying BAG files — counting exact frames
                      </p>
                      <p className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                        {sizeHint ? `Analysing ${sizeHint} of depth data` : 'Reading depth recordings'}{'. Large files can take up to 90 s.'}
                      </p>
                    </div>
                    <div className="relative h-1.5 bg-clinical-border dark:bg-clinical-dark-border rounded-full overflow-hidden">
                      <div className="absolute inset-y-0 w-1/3 bg-clinical-blue rounded-full animate-shimmer" />
                    </div>
                    <div className="flex items-center justify-between text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                      <span className="font-mono tabular-nums">{qualityElapsed}s elapsed</span>
                      <span>
                        {qualityElapsed < 10 ? 'Opening pipeline…'
                          : qualityElapsed < 40 ? 'Counting frames…'
                            : qualityElapsed < 70 ? 'Almost there…'
                              : 'Finalising…'}
                      </span>
                    </div>
                  </div>
                );
              })() : qualityData ? (() => {
                const { cameras, sync } = qualityData;

                // 0-100 score: 30pts recording start sync + 20pts frame count sync + 25pts per camera drop rate
                const startOffMs = sync?.recording_start_offset_ms ?? 0;
                const startSyncPts = sync ? Math.max(0, 30 - Math.round(startOffMs / 500 * 30)) : 30;
                const timeOff = sync?.time_offset_seconds ?? 0;
                const frameSyncPts = sync ? Math.max(0, 20 - Math.round(timeOff * 20)) : 20;
                const drop1 = cameras.camera1?.drop_rate_percent ?? 0;
                const drop2 = cameras.camera2?.drop_rate_percent ?? 0;
                const cam1Pts = Math.max(0, 25 - Math.round(drop1 * 5));
                const cam2Pts = Math.max(0, 25 - Math.round(drop2 * 5));
                const score = Math.min(100, startSyncPts + frameSyncPts + cam1Pts + cam2Pts);

                const scoreLabel = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : score >= 25 ? 'Poor' : 'Critical';
                const scoreHex = score >= 75 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';
                const scoreText = score >= 75 ? 'text-green-500' : score >= 50 ? 'text-amber-500' : 'text-red-500';
                const scoreBg = score >= 75 ? 'bg-green-500/10' : score >= 50 ? 'bg-amber-500/10' : 'bg-red-500/10';
                const syncQuality = sync?.sync_quality;

                const r = 54;
                const circ = 2 * Math.PI * r;
                const dashOffset = circ - (score / 100) * circ;

                return (
                  <div className="space-y-4">
                    {/* Gauge + metrics row */}
                    <div className="flex items-center gap-5">
                      {/* Radial gauge */}
                      <div className="flex-shrink-0">
                        <svg width="140" height="140" viewBox="0 0 140 140">
                          {/* Track */}
                          <circle
                            cx="70" cy="70" r={r}
                            fill="none" stroke="currentColor" strokeWidth="10"
                            className="text-clinical-border dark:text-clinical-dark-border"
                          />
                          {/* Progress arc */}
                          <circle
                            cx="70" cy="70" r={r}
                            fill="none"
                            stroke={scoreHex}
                            strokeWidth="10"
                            strokeLinecap="round"
                            strokeDasharray={`${circ} ${circ}`}
                            strokeDashoffset={dashOffset}
                            transform="rotate(-90 70 70)"
                          />
                          {/* Score number */}
                          <text
                            x="70" y="68"
                            textAnchor="middle" dominantBaseline="middle"
                            fontSize="32" fontWeight="700"
                            fill={scoreHex}
                          >{score}</text>
                          {/* Label */}
                          <text
                            x="70" y="92"
                            textAnchor="middle" dominantBaseline="middle"
                            fontSize="12" fontWeight="500"
                            fill="#9ca3af"
                          >{scoreLabel}</text>
                        </svg>
                      </div>

                      {/* Metrics */}
                      <div className="flex-1 space-y-2">
                        {sync && (
                          <>
                            {/* Recording start offset — ground truth from pipeline timestamps */}
                            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-clinical-bg dark:bg-clinical-dark-bg">
                              <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Start offset</span>
                              <span className={`font-mono font-semibold text-sm ${startOffMs <= 100 ? 'text-green-500' : startOffMs <= 500 ? 'text-amber-500' : 'text-red-500'
                                }`}>{startOffMs.toFixed(0)}ms</span>
                            </div>
                            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-clinical-bg dark:bg-clinical-dark-bg">
                              <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">MP4 Frame Δ</span>
                              <span className={`font-mono font-semibold text-sm ${scoreText}`}>{sync.frame_count_difference}</span>
                            </div>
                            {sync.bag_frame_count_difference != null && (
                              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-clinical-bg dark:bg-clinical-dark-bg">
                                <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">BAG Frame Δ</span>
                                <span className={`font-mono font-semibold text-sm ${scoreText}`}>{sync.bag_frame_count_difference}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-clinical-bg dark:bg-clinical-dark-bg">
                              <span className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Cam 1 / Cam 2</span>
                              <span className="font-mono text-xs text-clinical-text-primary dark:text-clinical-text-dark">{sync.cam1_mp4_frames} / {sync.cam2_mp4_frames}</span>
                            </div>
                          </>
                        )}
                        {/* Sync quality badge */}
                        {syncQuality && (
                          <div className={`px-3 py-1.5 rounded-lg text-xs font-bold text-center uppercase tracking-wider ${syncQuality === 'excellent' ? 'bg-green-500/10 text-green-500'
                            : syncQuality === 'good' ? 'bg-green-500/10 text-green-400'
                              : syncQuality === 'fair' ? 'bg-amber-500/10 text-amber-500'
                                : 'bg-red-500/10 text-red-500'
                            }`}>
                            {syncQuality} sync
                          </div>
                        )}
                        {/* Score breakdown */}
                        <div className={`px-3 py-1.5 rounded-lg text-xs font-medium text-center ${scoreBg} ${scoreText}`}>
                          {sync ? `Start ${startSyncPts}/30 · Frames ${frameSyncPts}/20` : 'No sync data'} · Cam1 {cam1Pts}/25 · Cam2 {cam2Pts}/25
                        </div>
                      </div>
                    </div>

                    {/* Per-camera cards */}
                    <div className="grid grid-cols-2 gap-3">
                      {(['camera1', 'camera2'] as const).map((camKey, i) => {
                        const cam = cameras[camKey] as CameraQuality | undefined;
                        if (!cam) return (
                          <div key={camKey} className="rounded-lg p-3 border border-clinical-border dark:border-clinical-dark-border">
                            <p className="text-xs font-bold text-clinical-text-secondary dark:text-clinical-text-dark-secondary mb-1">Camera {i + 1}</p>
                            <p className="text-xs text-red-500">No data</p>
                          </div>
                        );
                        const dropOk = (cam.drop_rate_percent ?? 0) <= 1;
                        const dropFair = (cam.drop_rate_percent ?? 0) <= 5;
                        const dropColor = dropOk ? 'text-green-500' : dropFair ? 'text-amber-500' : 'text-red-500';
                        return (
                          <div key={camKey} className="rounded-lg p-3 border border-clinical-border dark:border-clinical-dark-border space-y-1.5">
                            <p className="text-xs font-bold text-clinical-text-primary dark:text-clinical-text-dark mb-2">Camera {i + 1}</p>
                            <div className="flex justify-between text-xs">
                              <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">MP4 frames</span>
                              <span className="font-mono font-semibold text-clinical-text-primary dark:text-clinical-text-dark">{cam.mp4_frames?.toLocaleString() ?? '—'}</span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">BAG frames</span>
                              <span className="font-mono text-clinical-text-primary dark:text-clinical-text-dark">
                                {cam.bag_frames != null
                                  ? cam.bag_frames.toLocaleString()
                                  : <span className="opacity-40">—</span>
                                }
                              </span>
                            </div>
                            {cam.frames_at_stop != null && (
                              <div className="flex justify-between text-xs">
                                <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Frames at stop</span>
                                <span className={`font-mono ${cam.frames_at_stop === cam.bag_frames ? 'text-green-500' : 'text-amber-500'}`}>
                                  {cam.frames_at_stop.toLocaleString()}
                                </span>
                              </div>
                            )}
                            {cam.bag_expected_frames != null && (
                              <div className="flex justify-between text-xs">
                                <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Expected frames</span>
                                <span className="font-mono text-clinical-text-primary dark:text-clinical-text-dark">{cam.bag_expected_frames.toLocaleString()}</span>
                              </div>
                            )}
                            {cam.bag_dropped_frames != null && (
                              <div className="flex justify-between text-xs">
                                <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary" title="Hardware drops during recording">HW Frame drops</span>
                                <span className={`font-mono font-semibold ${cam.bag_dropped_frames > 0 ? 'text-red-500' : 'text-green-500'}`}>
                                  {cam.bag_dropped_frames.toLocaleString()}
                                </span>
                              </div>
                            )}
                            <div className="flex justify-between text-xs">
                              <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary" title="Codec drops during MP4 conversion">Codec Frame drops</span>
                              <span className={`font-mono font-semibold ${dropColor}`}>{cam.frame_difference ?? '—'}</span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">Codec Drop rate</span>
                              <span className={`font-mono font-semibold ${dropColor}`}>{cam.drop_rate_percent != null ? `${cam.drop_rate_percent}%` : '—'}</span>
                            </div>
                            <div className="flex justify-between text-xs">
                              <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">FPS (Target / Real)</span>
                              <span className="font-mono text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                                {cam.fps} / {cam.real_fps != null ? cam.real_fps.toFixed(2) : '—'}
                              </span>
                            </div>
                            {cam.bag_size_mb != null && (
                              <div className="flex justify-between text-xs">
                                <span className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary">BAG / MP4</span>
                                <span className="font-mono text-clinical-text-secondary dark:text-clinical-text-dark-secondary">{cam.bag_size_mb} MB / {cam.mp4_size_mb} MB</span>
                              </div>
                            )}
                            <div className="flex gap-1.5 pt-0.5">
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${cam.bag_exists ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-red-500/10 text-red-500'}`}>BAG {cam.bag_exists ? '✓' : '✗'}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${cam.mp4_exists ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-red-500/10 text-red-500'}`}>MP4 {cam.mp4_exists ? '✓' : '✗'}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Sync warning banner */}
                    {sync?.warning && (
                      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">{sync.warning}</p>
                      </div>
                    )}

                    {/* Pipeline restart times */}
                    {sync && (sync.cam1_pipeline_restart_ms || sync.cam2_pipeline_restart_ms) ? (
                      <div className="flex items-center justify-center gap-4 text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                        <span>Pipeline restart: Cam1 {sync.cam1_pipeline_restart_ms?.toFixed(0) ?? '?'}ms · Cam2 {sync.cam2_pipeline_restart_ms?.toFixed(0) ?? '?'}ms</span>
                      </div>
                    ) : null}

                    {!sync && (
                      <p className="text-xs text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-center py-1">
                        Sync data unavailable — need both cameras to compare.
                      </p>
                    )}
                  </div>
                );
              })() : (
                <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-center py-8">No quality data available</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* File Viewer Modal */}
      {viewingFile && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={closeViewer}
        >
          <div
            className="bg-clinical-card dark:bg-clinical-dark-card rounded-lg shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-clinical-border dark:border-clinical-dark-border flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className={`px-2 py-1 text-xs font-semibold rounded ${viewType === 'json'
                  ? 'bg-clinical-warning/10 text-clinical-warning'
                  : 'bg-clinical-ready/10 text-clinical-ready'
                  }`}>
                  {viewType?.toUpperCase()}
                </span>
                <h2 className="text-lg font-semibold text-clinical-text-primary dark:text-clinical-text-dark">
                  {viewingFile}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadFile(viewType!, viewingFile)}
                  disabled={downloadingFiles.has(viewingFile)}
                  className="px-3 py-1.5 bg-clinical-blue/10 text-clinical-blue text-sm font-medium rounded hover:bg-clinical-blue/20 disabled:opacity-50 transition-colors"
                >
                  Download
                </button>
                <button
                  onClick={closeViewer}
                  className="p-2 text-clinical-text-secondary hover:text-clinical-text-primary dark:text-clinical-text-dark-secondary dark:hover:text-clinical-text-dark hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg rounded transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-6 min-h-0">
              {viewLoading ? (
                <div className="flex items-center justify-center h-64">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-clinical-blue"></div>
                </div>
              ) : viewContent ? (
                viewType === 'json' ? (
                  /* JSON Viewer with Syntax Highlighting */
                  <pre className="text-sm font-mono bg-slate-900 text-slate-300 p-4 rounded overflow-auto whitespace-pre">
                    {(() => {
                      try {
                        const formatted = JSON.stringify(JSON.parse(viewContent), null, 2);
                        return highlightJSON(formatted);
                      } catch {
                        return <span>{viewContent}</span>;
                      }
                    })()}
                  </pre>
                ) : (
                  /* CSV Viewer */
                  <div className="overflow-auto">
                    {(() => {
                      const { headers, rows } = parseCSV(viewContent);
                      return (
                        <table className="w-full text-sm border-collapse">
                          <thead className="bg-clinical-bg dark:bg-clinical-dark-bg sticky top-0">
                            <tr>
                              <th className="px-3 py-2 text-left text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary border border-clinical-border dark:border-clinical-dark-border">
                                #
                              </th>
                              {headers.map((header, i) => (
                                <th key={i} className="px-3 py-2 text-left text-xs font-semibold text-clinical-text-secondary dark:text-clinical-text-dark-secondary border border-clinical-border dark:border-clinical-dark-border whitespace-nowrap">
                                  {header}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row, rowIndex) => (
                              <tr key={rowIndex} className="hover:bg-clinical-bg dark:hover:bg-clinical-dark-bg">
                                <td className="px-3 py-2 text-clinical-text-secondary dark:text-clinical-text-dark-secondary border border-clinical-border dark:border-clinical-dark-border font-mono text-xs">
                                  {rowIndex + 1}
                                </td>
                                {row.map((cell, cellIndex) => (
                                  <td key={cellIndex} className="px-3 py-2 text-clinical-text-primary dark:text-clinical-text-dark border border-clinical-border dark:border-clinical-dark-border whitespace-nowrap">
                                    {cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                    <p className="mt-4 text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary">
                      {parseCSV(viewContent).rows.length} rows
                    </p>
                  </div>
                )
              ) : (
                <p className="text-clinical-text-secondary dark:text-clinical-text-dark-secondary text-center">
                  No content to display
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
