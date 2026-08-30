import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Toast, BackButton } from '../components/UI';

let isInitialLoad = true;

const MotionIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const CaptureIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
    <path d="m22 8-6 4 6 4V8Z" />
    <rect width="14" height="12" x="2" y="6" rx="2" ry="2" />
  </svg>
);

const ShotsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
    <path d="M20.2 6 3 11l-.9-2.4 17.2-5.1Z" />
    <path d="M4 11v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9" />
    <path d="m3 11 1.7-4.9" />
    <path d="m8.5 9.4 1.7-4.9" />
  </svg>
);

const VaultIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

const MANUAL_CARDS = [
  { id: 'motion', icon: <MotionIcon />, label: 'Motion Setup', desc: 'Set start & end positions for your camera path', page: 'motion', accent: 'from-blue-500/10 to-transparent', border: 'border-blue-500/20', glass: 'glass-blue' },
  { id: 'vault', icon: <VaultIcon />, label: 'Motion Library', desc: 'Load, edit, and manage your saved camera paths', page: 'vault', accent: 'from-[#fbcfe8]/10 to-transparent', border: 'border-[#fbcfe8]/20', glass: 'glass-pink' },
  { id: 'shots', icon: <ShotsIcon />, label: 'My Shots', desc: 'Play and download your timelapse recordings', page: 'shots', accent: 'from-[#ffb894]/10 to-transparent', border: 'border-[#ffb894]/20', glass: 'glass-peach' },
];

const AIIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </svg>
);

const ManualIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
    <rect width="20" height="12" x="2" y="6" rx="2" />
    <circle cx="12" cy="12" r="2" />
    <path d="M6 12h.01M18 12h.01" />
  </svg>
);

const HOME_CARDS = [
  { id: 'ai', icon: <AIIcon />, label: 'Cruise Control', desc: 'AI-powered automatic object detection, tracking and robotic camera control.', page: 'ai-control', accent: 'from-blue-500/10 to-transparent', border: 'border-blue-500/20', glass: 'glass-blue' },
  { id: 'manual', icon: <ManualIcon />, label: 'Manual Control', desc: 'Manual motion setup, motion library and my shots.', page: 'manual-control', accent: 'from-purple-500/10 to-transparent', border: 'border-purple-500/20', glass: 'glass-purple' },
  { id: 'recordings', icon: <ShotsIcon />, label: 'Recordings', desc: 'View and manage all recordings created from both AI Control and Manual Control.', page: 'shots', accent: 'from-[#ffb894]/10 to-transparent', border: 'border-[#ffb894]/20', glass: 'glass-peach' },
];

const TARGET_IP = '172.20.10.5'; // Pure-WiFi local synchronization anchor node

export default function HomePage() {
  const { page, setPage, updateESP32IP, setCurrentPreset } = useApp();

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [toast, setToast] = useState(null);
  const [introStage, setIntroStage] = useState(isInitialLoad ? 'center' : 'settled');

  const isCurrentlyConnectedRef = useRef(false);
  const isComponentMountedRef = useRef(true);

  // --- Splash animation (unchanged layout metrics) ---
  useEffect(() => {
    if (isInitialLoad) {
      const timer = setTimeout(() => {
        if (isComponentMountedRef.current) {
          setIntroStage('settled');
        }
        isInitialLoad = false;
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, []);

  // --- Core Verification Layer Engine ---
  const checkHardwareLink = async () => {
    if (!isComponentMountedRef.current) return false;

    console.log("PING STARTED via Proxy /api/esp32/ping");

    if (isComponentMountedRef.current) {
      setConnecting(true);
    }

    try {
      const res = await fetch('/api/esp32/ping', {
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });

      if (!isComponentMountedRef.current) return false;

      if (res.ok) {
        const data = await res.json();
        console.log("PING RESPONSE:", data);
        if (data && (data.ok === true || data.status === 'connected')) {
          isCurrentlyConnectedRef.current = true;
          // Store the verified ESP32 IP so Motion Setup and other pages can read it
          if (data.ip) updateESP32IP(data.ip);
          setConnected(true);
          setConnecting(false);
          setToast({ message: '✅ RoboCam Link Synchronized!', type: 'success' });
          return true;
        }
      }
    } catch (err) {
      // Ignore AbortError — caused by React StrictMode cleanup or component unmount,
      // not a real ESP32 connection failure. Do NOT show "Connection unverified".
      if (err.name === 'AbortError' || err instanceof DOMException || (err.message && err.message.toLowerCase().includes('abort'))) {
        console.log("[Proxy Verification] Ping request cancelled (component cleanup), ignoring.");
        return false;
      }
      console.log("[Proxy Verification] Ping check dropped:", err.message);
    }

    if (!isComponentMountedRef.current) return false;

    // Fallback attempt to /api/discover
    try {
      const res = await fetch('/api/discover', {
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });

      if (!isComponentMountedRef.current) return false;

      if (res.ok) {
        const data = await res.json();
        console.log("DISCOVER RESPONSE:", data);
        if (data && data.ok) {
          isCurrentlyConnectedRef.current = true;
          setConnected(true);
          setConnecting(false);
          if (data.esp32 && data.esp32 !== 'searching...') {
            updateESP32IP(data.esp32);
          }
          setToast({ message: '✅ RoboCam Link Synchronized!', type: 'success' });
          return true;
        }
      }
    } catch (err) {
      // Ignore AbortError — component cleanup, not an ESP32 failure.
      if (err.name === 'AbortError' || err instanceof DOMException || (err.message && err.message.toLowerCase().includes('abort'))) {
        console.log("[Proxy Verification] Discover request cancelled (component cleanup), ignoring.");
        return false;
      }
      console.log("[Proxy Verification] Discover check dropped:", err.message);
    }

    if (isComponentMountedRef.current) {
      setConnecting(false);
      setConnected(false);
      setToast({ message: '⚠️ Connection unverified. Check network link.', type: 'error' });
    }
    return false;
  };

  useEffect(() => {
    isComponentMountedRef.current = true;
    // Perform instant verification on page boot load context
    checkHardwareLink();
    return () => {
      isComponentMountedRef.current = false;
    };
  }, []); // Empty deps: run once on mount only, avoid StrictMode double-trigger with stale ref

  const handleManualActionClick = () => {
    if (connected || isCurrentlyConnectedRef.current) return;
    checkHardwareLink();
  };

  const isCentered = introStage === 'center';

  return (
    <div className="min-h-screen bg-transparent flex flex-col relative">
      <div className={`fixed inset-0 bg-black pointer-events-none transition-opacity duration-[1200ms] z-[98] ${isCentered ? 'opacity-100' : 'opacity-0'}`} />

      {/* Header / Logo */}
      <div className={`z-[100] pointer-events-none flex justify-center transition-all duration-[1400ms] ${isCentered ? 'fixed inset-0 items-center robocam-header-scaler' : 'w-full items-start pt-8 scale-100'}`}>
        <div className={`flex flex-col items-center ${isCentered ? '' : 'w-full px-4'}`}>
          <div className={`w-full flex transition-all duration-[1400ms] ${isCentered ? 'flex-col items-center' : 'flex-row items-center justify-between'}`}>
            <div className={`flex items-center transition-all duration-[1400ms] ${isCentered ? 'flex-col' : 'flex-row'}`}>
              <div className={`relative transition-all ${isCentered ? 'h-[120px] w-[120px] mb-6' : 'h-0 w-0'}`}>
                <img src="/bg-cinematic.jpg" alt="RoboCam Logo" className={`absolute transition-all duration-[1600ms] ${isCentered ? 'scale-100 opacity-100' : 'scale-[12] opacity-0 blur-xl'}`} />
              </div>
              <div className={`flex flex-col transition-all duration-[1400ms] ${isCentered ? 'items-center' : 'items-start'}`}>
                <h1 className={`robocam-title-audiowide whitespace-nowrap transition-all duration-[1400ms] ${isCentered ? 'robocam-intro-glow text-4xl' : 'robocam-final-glow text-3xl ml-2'}`}>RoboCam</h1>
                {!isCentered && (
                  <p className="robocam-subtitle-branding text-[11px] ml-2 mt-1 whitespace-nowrap">Powered by RoboWorkZ</p>
                )}
              </div>

            </div>

            <div className={`pointer-events-auto transition-all duration-[1400ms] ${isCentered ? 'opacity-0 max-w-0' : 'opacity-100'}`}>
              <button
                onClick={handleManualActionClick}
                disabled={connecting}
                className={`inline-flex items-center gap-2.5 px-4 py-2 rounded-full border backdrop-blur-md active:scale-[0.98] transition-all duration-300 ${connected
                  ? 'bg-green-500/10 border-green-500/40 shadow-[inset_0_0_12px_rgba(34,197,94,0.2),0_0_20px_rgba(34,197,94,0.25)] hover:bg-green-500/20'
                  : 'bg-white/5 border-white/20 hover:bg-white/10'
                  }`}
              >
                <div className={`relative flex items-center justify-center w-5 h-5 rounded-full ${connected ? 'bg-green-500/15' : 'bg-white/10'}`}>
                  {connected ? (
                    <>
                      <span className="absolute inset-0 rounded-full animate-ping bg-green-500/20" />
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-green-400">
                        <path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" />
                        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><circle cx="12" cy="20" r="1" fill="currentColor" />
                      </svg>
                    </>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-white/50">
                      <path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><circle cx="12" cy="20" r="1" fill="currentColor" />
                    </svg>
                  )}
                </div>
                <span className={`text-sm font-semibold tracking-wide ${connected ? 'text-green-400' : 'text-white/80'}`}>
                  {connected ? 'Connected' : connecting ? 'Checking…' : 'Sync Link'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className={`w-full transition-all ${isCentered ? 'h-0' : 'h-8'}`} />

      {/* Back button for Manual Control Home */}
      {page === 'manual-control' && !isCentered && (
        <div className="px-5 pt-2">
          <BackButton onClick={() => setPage('home')} />
        </div>
      )}

      {/* Feature Cards */}
      <div className={`px-5 pb-10 grid grid-cols-1 gap-4 flex-1 transition-all duration-[2500ms] delay-[300ms] ${isCentered ? 'opacity-0 blur-md translate-y-12' : 'opacity-100 blur-0 translate-y-0'}`}>
        {(page === 'manual-control' ? MANUAL_CARDS : HOME_CARDS).map((card, i) => (
          <button
            key={card.id}
            onClick={() => {
              if (card.page === 'motion') {
                setCurrentPreset(null);
              }
              setPage(card.page);
            }}
            className={`relative overflow-hidden ${card.glass} rounded-3xl p-5 border ${card.border} card-hover text-left animate-slide-up`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className={`absolute inset-0 bg-gradient-to-br ${card.accent} pointer-events-none`} />
            <div className={`absolute inset-0 bg-black/60 backdrop-blur-md transition-all duration-[3500ms] delay-[800ms] ${isCentered ? 'opacity-0' : 'opacity-100'}`} />
            <div className="relative">
              <div className="flex items-center justify-between mb-3">
                <div className="w-11 h-11 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-xl">{card.icon}</div>
                <svg className="text-white/20" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg>
              </div>
              <h2 className="font-bold text-base mb-0.5">{card.label}</h2>
              <p className="text-white/45 text-xs leading-relaxed">{card.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Offline banner */}
      {!connected && !connecting && (
        <div className="fixed bottom-6 left-4 right-4 glass rounded-2xl p-4 border border-white/20 backdrop-blur-md text-center animate-fade-in-up z-20">
          <p className="text-white/70 text-sm font-medium">
            ⚠️ RoboCam Link Unverified – click Sync Link to update connection state.
          </p>
        </div>
      )}

      {/* Checking/Scanning Banner */}
      {!connected && connecting && (
        <div className="fixed bottom-6 left-4 right-4 glass rounded-2xl p-4 border border-blue-500/30 backdrop-blur-md text-center animate-fade-in-up z-20">
          <p className="text-blue-300 text-sm font-medium leading-relaxed">
            ⏳ Verification in progress...<br />
            <span className="text-xs text-white/60">Pinging RoboCam proxy node: /api/discover</span>
          </p>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}