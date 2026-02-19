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
}

interface FileInfo {
  name: string;
  size: number;
  modified: string;
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

  // File viewer modal state
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewContent, setViewContent] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'csv' | 'json' | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewingFile) {
        setViewingFile(null);
        setViewContent(null);
        setViewType(null);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [viewingFile]);

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/files/all`);
      const data = await res.json();
      if (mountedRef.current) setFiles(data);
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

      if (type === 'bag') {
        // Use streaming for large BAG files
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
          // Update progress every 200ms
          if (now - lastUpdate > 200) {
            const elapsed = (now - lastUpdate) / 1000;
            const bytesSinceLast = received - lastReceived;
            const speed = bytesSinceLast / elapsed;

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
          const blob = new Blob(chunks);
          const downloadUrl = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(downloadUrl);
        }
      } else {
        // Standard download for smaller files
        showToast(`Downloading ${filename}...`, 'info');
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) throw new Error('Download failed');

        const blob = await res.blob();
        if (mountedRef.current) {
          const downloadUrl = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.URL.revokeObjectURL(downloadUrl);
        }
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

  // Parse CSV into rows and columns
  const parseCSV = (text: string): { headers: string[]; rows: string[][] } => {
    const lines = text.trim().split('\n');
    if (lines.length === 0) return { headers: [], rows: [] };
    
    const headers = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(line => line.split(',').map(cell => cell.trim()));
    
    return { headers, rows };
  };

  // Syntax highlight JSON
  const highlightJSON = (json: string): JSX.Element[] => {
    const elements: JSX.Element[] = [];
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
    { id: 'videos' as const, label: 'Videos', count: files.videos.length, icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    )},
    { id: 'csvs' as const, label: 'CSV Files', count: files.csvs.length, icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    )},
    { id: 'jsons' as const, label: 'JSON Files', count: files.jsons.length, icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    )},
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
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              activeTab === tab.id
                ? 'text-clinical-blue border-b-2 border-clinical-blue'
                : 'text-clinical-text-secondary dark:text-clinical-text-dark-secondary hover:text-clinical-text-primary dark:hover:text-clinical-text-dark'
            }`}
          >
            {tab.icon}
            {tab.label}
            <span className={`ml-1 px-2.5 py-1 text-sm font-medium rounded ${
              activeTab === tab.id 
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
                        <p className="text-sm text-clinical-text-secondary dark:text-clinical-text-dark-secondary mt-1">
                          {formatDate(batch.modified)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
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
                <span className={`px-2 py-1 text-xs font-semibold rounded ${
                  viewType === 'json' 
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
