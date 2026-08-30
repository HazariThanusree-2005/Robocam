import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { BackButton, PageHeader, Toast } from '../components/UI';

const PRESETS_STORAGE_KEY = 'robocam_motion_presets';

function loadPresets() {
  const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch { return []; }
}

function savePresets(presets) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

export default function CaptureVault() {
  const { setPage, setCurrentPreset, updateMotion } = useApp();
  const [presets, setPresets] = useState([]);
  const [toast, setToast] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  useEffect(() => {
    loadPresetList();
  }, []);

  const loadPresetList = () => {
    setPresets(loadPresets());
  };

  const handleOpen = (preset) => {
    setCurrentPreset(preset);
    updateMotion({
      startPosition: preset.start,
      endPosition: preset.end,
      packetAngle: preset.packetAngle,
      preset: preset.name,
    });
    setPage('motion');
  };

  const handleDelete = (id) => {
    const updated = presets.filter(p => p.id !== id);
    savePresets(updated);
    setPresets(updated);
    setToast({ message: 'Preset deleted', type: 'info' });
  };

  const startRename = (preset) => {
    setEditingId(preset.id);
    setEditName(preset.name);
  };

  const handleRenameSave = (id) => {
    if (!editName.trim()) {
      setToast({ message: 'Name cannot be empty', type: 'error' });
      return;
    }
    const updated = presets.map(p =>
      p.id === id ? { ...p, name: editName.trim() } : p
    );
    savePresets(updated);
    setPresets(updated);
    setEditingId(null);
    setToast({ message: 'Preset renamed', type: 'success' });
  };

  const formatDate = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-transparent px-5 pt-12 pb-10 animate-fade-in">
      <BackButton onClick={() => setPage('manual-control')} />
      <PageHeader title="Motion Library" subtitle="Saved cinematic motion paths" />

      {presets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <span className="text-5xl mb-4">🎬</span>
          <p className="text-white/50 font-semibold">No saved presets</p>
          <p className="text-white/30 text-sm mt-1">Go to Motion Setup and save your first motion path</p>
        </div>
      ) : (
        <div className="space-y-4">
          {presets.map((preset) => {
            const isEditing = editingId === preset.id;
            return (
              <div key={preset.id} className="glass rounded-3xl border border-white/8 overflow-hidden animate-slide-up text-left">
                <div className="p-4">
                  <div className="flex flex-col gap-2 mb-3">
                    <div className="flex items-start justify-between gap-2">
                      {isEditing ? (
                        <div className="flex-1 flex gap-2">
                          <input
                            autoFocus
                            type="text"
                            className="flex-1 bg-white/5 border border-white/20 rounded-xl px-3 py-1.5 text-sm outline-none focus:border-[#fbcfe8] text-white"
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleRenameSave(preset.id); }}
                          />
                          <button onClick={() => handleRenameSave(preset.id)} className="px-3 py-1.5 rounded-xl bg-[#fbcfe8]/20 text-[#fbcfe8] text-sm font-semibold hover:bg-[#fbcfe8]/30 transition-colors">Save</button>
                          <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-xl bg-white/5 text-white/60 text-sm hover:text-white transition-colors">Cancel</button>
                        </div>
                      ) : (
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <h3 className="font-semibold text-base truncate">{preset.name}</h3>
                          <button
                            onClick={() => startRename(preset)}
                            className="text-white/40 hover:text-[#fbcfe8] p-1 transition-colors"
                            aria-label="Rename"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        </div>
                      )}
                      {!isEditing && (
                        <button
                          onClick={() => handleDelete(preset.id)}
                          className="w-8 h-8 flex-shrink-0 rounded-xl border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center text-xs transition-colors"
                          aria-label="Delete"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {!isEditing && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-white/40 text-xs font-mono">
                          S {preset.start} → E {preset.end}
                        </span>
                        <span className="text-white/40 text-xs">·</span>
                        <span className="text-white/40 text-xs">{preset.packetAngle}°/packet</span>
                        {preset.createdAt && (
                          <>
                            <span className="text-white/40 text-xs">·</span>
                            <span className="text-white/40 text-xs">{formatDate(preset.createdAt)}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-2">
                    <button
                      onClick={() => handleOpen(preset)}
                      className="py-2.5 rounded-2xl glass-pink text-[#fbcfe8] text-sm font-semibold hover:brightness-110 transition-all duration-200 active:scale-95"
                    >
                      Open Preset
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}
