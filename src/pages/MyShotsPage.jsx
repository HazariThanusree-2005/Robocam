import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { BackButton, PageHeader, Spinner, Toast } from '../components/UI';
import { getAllRecordings, deleteRecording } from '../utils/db';

const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function generateFilename(rec) {
  const date = rec.createdAt
    ? new Date(rec.createdAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const ext = rec.ext || 'mp4';
  return `timelapse-${date}.${ext}`;
}

/**
 * Mobile: navigator.share() with File — opens native share sheet (Save Video / Save to Files)
 * Desktop: <a download> anchor click — triggers browser download
 * Fallback: window.open — opens blob in new tab (long-press to save)
 */
async function crossPlatformDownload(blob, filename, mimeType) {
  const type = mimeType || 'video/mp4';

  // Read blob fully into ArrayBuffer to ensure data integrity from IndexedDB
  const arrayBuffer = await blob.arrayBuffer();
  const cleanBlob = new Blob([arrayBuffer], { type });

  // Mobile: Use Web Share API — the only reliable way to actually save files on iOS/Android
  if (isMobile() && navigator.share) {
    try {
      const file = new File([arrayBuffer], filename, { type, lastModified: Date.now() });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (err) {
      if (err.name === 'AbortError') return 'share-cancelled';
      // Fall through to anchor download
    }
  }

  // Desktop / fallback: Anchor download
  const url = URL.createObjectURL(cleanBlob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    return 'anchor';
  } catch {
    URL.revokeObjectURL(url);
  }

  // Last resort: open in new tab
  const fallbackUrl = URL.createObjectURL(cleanBlob);
  window.open(fallbackUrl, '_blank');
  setTimeout(() => URL.revokeObjectURL(fallbackUrl), 30000);
  return 'newtab';
}

export default function MyShotsPage() {
  const { setPage, prevPage } = useApp();
  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(null);
  const [toast, setToast] = useState(null);
  const videoRef = useRef(null);
  const [objectUrls, setObjectUrls] = useState({});

  const apiBase = '/api';

  useEffect(() => {
    loadRecordings();
    return () => {
      Object.values(objectUrls).forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  async function loadRecordings() {
    setLoading(true);
    try {
      const manualRecs = await getAllRecordings();
      
      let aiRecs = [];
      try {
        const res = await fetch(`${apiBase}/ai-recordings`);
        if (res.ok) {
          aiRecs = await res.json();
        }
      } catch (err) {
        console.warn('Failed to fetch AI recordings:', err);
      }

      const combined = [
        ...manualRecs.map(r => ({ ...r, mode: r.mode || 'Manual Control' })),
        ...aiRecs
      ];

      // Sort by createdAt descending
      combined.sort((a, b) => b.createdAt - a.createdAt);
      setRecordings(combined);
    } catch (err) {
      console.error('Failed to load recordings:', err);
    } finally {
      setLoading(false);
    }
  }

  function getObjectUrl(rec) {
    if (rec.blob) {
      if (objectUrls[rec.id]) return objectUrls[rec.id];
      const url = URL.createObjectURL(rec.blob);
      setObjectUrls(prev => ({ ...prev, [rec.id]: url }));
      return url;
    } else {
      return `${apiBase}/ai-recordings/file/${rec.name}`;
    }
  }

  function handlePlay(rec) {
    setPlaying(rec);
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.src = getObjectUrl(rec);
        videoRef.current.play();
      }
    }, 50);
  }

  async function handleDownload(rec) {
    try {
      let blob = rec.blob;
      if (!blob) {
        // Fetch blob from server for AI recording
        const res = await fetch(`${apiBase}/ai-recordings/file/${rec.name}`);
        if (!res.ok) throw new Error('File download from server failed');
        blob = await res.blob();
      }

      if (!blob || blob.size === 0) {
        setToast({ message: 'Video data missing or empty', type: 'error' });
        return;
      }

      const filename = generateFilename(rec);
      const method = await crossPlatformDownload(blob, filename, rec.mimeType);

      if (method === 'shared') {
        setToast({ message: 'Video saved successfully!', type: 'success' });
      } else if (method === 'share-cancelled') {
        /* user dismissed share sheet, no toast */
      } else if (method === 'anchor') {
        setToast({ message: 'Download started!', type: 'success' });
      } else if (method === 'newtab') {
        setToast({ message: 'Opened in new tab — long-press to save', type: 'info' });
      }
    } catch (err) {
      console.error('Download error:', err);
      setToast({ message: 'Download failed. Please try again.', type: 'error' });
    }
  }

  async function handleDelete(rec) {
    try {
      if (rec.blob) {
        await deleteRecording(rec.id);
        if (objectUrls[rec.id]) URL.revokeObjectURL(objectUrls[rec.id]);
        setObjectUrls(prev => { const n = { ...prev }; delete n[rec.id]; return n; });
      } else {
        const res = await fetch(`${apiBase}/ai-recordings/file/${rec.name}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete file from server failed');
      }
      setPlaying(null);
      await loadRecordings();
      setToast({ message: 'Recording deleted', type: 'info' });
    } catch (err) {
      console.error('Delete error:', err);
      setToast({ message: 'Delete failed. Please try again.', type: 'error' });
    }
  }

  const formatBytes = bytes => {
    if (!bytes) return '—';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatTime = s => {
    if (!s) return '—';
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const formatDateTime = timestamp => {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const isFromManual = prevPage === 'manual-control';
  const pageTitle = isFromManual ? 'My Shots' : 'Recordings';
  const pageSubtitle = isFromManual 
    ? `${recordings.length} recording${recordings.length !== 1 ? 's' : ''}` 
    : 'AI Control & Manual Control recordings';

  return (
    <div className="min-h-screen bg-transparent px-5 pt-12 pb-10 animate-fade-in">
      <BackButton onClick={() => setPage(isFromManual ? 'manual-control' : 'home')} />
      <PageHeader title={pageTitle} subtitle={pageSubtitle} />

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner size={32} className="text-[#ffb894]" />
        </div>
      ) : recordings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <span className="text-5xl mb-4">🎞️</span>
          <p className="text-white/50 font-semibold">No recordings yet</p>
          <p className="text-white/30 text-sm mt-1">Go back to record your first shot</p>
        </div>
      ) : (
        <div className="space-y-4">
          {recordings.map((rec) => (
            <div key={rec.id} className="glass rounded-3xl border border-white/8 overflow-hidden">
              {playing?.id === rec.id ? (
                <div className="relative aspect-video bg-black/30 backdrop-blur-md">
                  <video
                    ref={videoRef}
                    controls
                    playsInline
                    crossOrigin="anonymous"
                    className="w-full h-full object-contain"
                    onEnded={() => setPlaying(null)}
                  />
                  <button
                    onClick={() => setPlaying(null)}
                    className="absolute top-3 right-3 w-8 h-8 rounded-xl bg-black/40 backdrop-blur-md border border-white/20 flex items-center justify-center text-white/70 hover:text-white"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ) : (
                <div
                  className="relative aspect-video bg-gradient-to-br from-white/3 to-transparent flex items-center justify-center cursor-pointer group"
                  onClick={() => handlePlay(rec)}
                >
                  <div className="w-14 h-14 rounded-full bg-white/10 border border-white/15 flex items-center justify-center group-hover:bg-white/15 transition-all duration-200">
                    <svg className="ml-1" width="20" height="20" viewBox="0 0 24 24" fill="white">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                </div>
              )}

              <div className="p-4">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-semibold text-sm truncate">{rec.name || `Shot #${rec.id}`}</h3>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wider ${rec.mode === 'AI Control' ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400' : 'bg-purple-500/10 border border-purple-500/20 text-purple-400'}`}>
                        {rec.mode || 'Manual Control'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-white/40 text-xs flex-wrap">
                      <span>{formatDateTime(rec.createdAt)}</span>
                      <span>·</span>
                      {rec.duration ? (
                        <>
                          <span className="font-mono">{formatTime(rec.duration)}</span>
                          <span>·</span>
                        </>
                      ) : null}
                      {rec.speedMode ? (
                        <>
                          <span>{rec.speedMode} speed</span>
                          <span>·</span>
                        </>
                      ) : null}
                      <span>{formatBytes(rec.size)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(rec)}
                    className="w-8 h-8 flex-shrink-0 rounded-xl border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center text-xs transition-colors duration-150"
                  >
                    ✕
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handlePlay(rec)}
                    className="py-2.5 rounded-2xl glass-peach text-[#ffb894] text-sm font-semibold hover:brightness-110 transition-all duration-200 active:scale-95"
                  >
                    ▶ Play
                  </button>
                  <button
                    onClick={() => handleDownload(rec)}
                    className="py-2.5 rounded-2xl glass text-white/70 text-sm font-semibold hover:text-white hover:brightness-110 transition-all duration-200 active:scale-95"
                  >
                    ↓ Download
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}