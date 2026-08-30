import { useEffect, useState, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { BackButton, PageHeader, Card, Spinner, Toast } from '../components/UI';

const AiOutlineIcon = (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-white/80"
  >
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <circle cx="9" cy="13" r="1" />
    <circle cx="15" cy="13" r="1" />
    <path d="M9 17h6" />
    <path d="M12 8V4" />
    <circle cx="12" cy="3" r="1" />
    <path d="M2 14h1M21 14h1" />
  </svg>
);

export default function AiControlPage() {
  const { setPage, esp32IP } = useApp();
  const [cameraSelected, setCameraSelected] = useState(false);
  const [selectedOption, setSelectedOption] = useState(null);
  const [cameras, setCameras] = useState(null); // null = loading, [] = none found
  const [camerasLoading, setCamerasLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Starting Vision Engine...');
  const [errorDetail, setErrorDetail] = useState(null);
  const [toast, setToast] = useState(null);

  const apiBase = '/api';

  // Client camera stream refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const uploadIntervalRef = useRef(null);

  // Enumerate cameras on mount
  useEffect(() => {
    let active = true;
    setCamerasLoading(true);

    const detectCameras = async () => {
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoDevices = devices.filter(device => device.kind === 'videoinput');
          if (active) {
            setCameras(videoDevices);
            setSelectedOption('back'); // Default to back camera for mobile / general compatibility
          }
        } else {
          if (active) {
            setCameras([]);
            setSelectedOption('back');
          }
        }
      } catch (err) {
        console.error('Failed to enumerate local cameras:', err);
        if (active) {
          setCameras([]);
          setSelectedOption('back');
        }
      } finally {
        if (active) setCamerasLoading(false);
      }
    };

    detectCameras();
    return () => { active = false; };
  }, []);

  // Stop client camera stream and frame uploads
  const stopClientCamera = useCallback(() => {
    if (uploadIntervalRef.current) {
      clearInterval(uploadIntervalRef.current);
      uploadIntervalRef.current = null;
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach(track => track.stop());
      } catch (e) {}
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const stopAI = async () => {
    try {
      stopClientCamera();
      await fetch(`${apiBase}/ai/stop`, { method: 'POST' });
      setRunning(false);
    } catch (err) {
      console.error('Failed to stop AI process:', err);
    }
  };

  useEffect(() => {
    if (!cameraSelected) return;

    let active = true;
    let pollInterval = null;
    let hasInitializedToast = false;

    const startAndMonitor = async () => {
      setLoading(true);
      setErrorDetail(null);

      try {
        setStatusMessage('Requesting Camera Access...');

        // 1. Open client device camera using browser MediaDevices API
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error(
            'Browser camera API (getUserMedia) is unavailable. If accessing over a local Wi-Fi network, please ensure you use HTTPS (e.g., https://192.168.x.x:3000) or a secure context.'
          );
        }

        const facingMode = selectedOption === 'front' ? 'user' : { ideal: 'environment' };

        let mediaStream;
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode,
              width: { ideal: 640 },
              height: { ideal: 480 }
            },
            audio: false,
          });
        } catch (initialErr) {
          // Fallback retry with basic video constraint if ideal resolution fails
          console.warn('Initial getUserMedia failed, retrying with basic video constraint:', initialErr);
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }

        if (!active) {
          mediaStream.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = mediaStream;

        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.setAttribute('autoplay', 'true');
          videoRef.current.muted = true;
          try {
            await videoRef.current.play();
          } catch (pErr) {
            console.log('Video play promise note:', pErr);
          }
        }

        setStatusMessage('Camera Active. Starting Vision Engine...');

        // 2. Continuous client-to-server frame transport loop (~12 FPS)
        const canvas = canvasRef.current || document.createElement('canvas');
        canvasRef.current = canvas;
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (uploadIntervalRef.current) clearInterval(uploadIntervalRef.current);
        uploadIntervalRef.current = setInterval(() => {
          const video = videoRef.current;
          if (!video || video.readyState < 2) return;
          ctx.drawImage(video, 0, 0, 640, 480);
          canvas.toBlob((blob) => {
            if (blob) {
              fetch(`${apiBase}/ai/upload-frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg' },
                body: blob,
              }).catch(() => {});
            }
          }, 'image/jpeg', 0.65);
        }, 80);

        // 3. Launch Python process with source: 'client' (never opens PC server camera)
        const res = await fetch(`${apiBase}/ai/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ip: esp32IP,
            camera: selectedOption,
            source: 'client'
          }),
        });

        if (!res.ok) {
          throw new Error('Vision process launch failed');
        }

        // 4. Poll AI process status until stream is active
        pollInterval = setInterval(async () => {
          try {
            const statusRes = await fetch(`${apiBase}/ai/status`);
            if (statusRes.ok) {
              const statusData = await statusRes.json();
              if (active) {
                if (statusData.error) {
                  clearInterval(pollInterval);
                  setLoading(false);
                  setRunning(false);
                  setErrorDetail(statusData.error);
                  setToast({ message: '❌ Camera process failed to start', type: 'error' });
                } else if (!statusData.running) {
                  clearInterval(pollInterval);
                  setLoading(false);
                  setRunning(false);
                  setErrorDetail('Camera process disconnected unexpectedly');
                  setToast({ message: '❌ Camera process disconnected', type: 'error' });
                } else if (statusData.streamActive) {
                  setLoading(false);
                  setRunning(true);
                  if (!hasInitializedToast) {
                    hasInitializedToast = true;
                    setToast({ message: 'Cruise Control initialized!', type: 'success' });
                  }
                }
              }
            }
          } catch (e) {
            console.error('Failed to check status:', e);
          }
        }, 1000);

      } catch (err) {
        console.error('Cruise Control startup error:', err);
        stopClientCamera();
        if (active) {
          setLoading(false);
          setRunning(false);
          let userMsg = err.message || 'Failed to initialize Cruise Control';
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            userMsg = 'Camera permission was denied. Please allow camera access in your browser settings.';
          } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            userMsg = 'No camera found on this device.';
          }
          setErrorDetail(userMsg);
          setToast({ message: `❌ ${userMsg}`, type: 'error' });
        }
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'r' || e.key === 'R') {
        fetch(`${apiBase}/ai/reset`, { method: 'POST' }).catch(err => {
          console.error('Failed to send reset command:', err);
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const eventSource = new EventSource(`${apiBase}/ai/events`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'move') {
          const isLeft = data.direction && data.direction.includes('LEFT');
          const isRight = data.direction && data.direction.includes('RIGHT');
          const command = isLeft ? 'left' : isRight ? 'right' : null;

          if (command) {
            const label = command.toUpperCase();
            console.log(`Sending Servo Command: ${label}`);
            fetch(`/api/esp32/${command}`, { method: 'POST' })
              .then(res => {
                if (res.ok) {
                  console.log('Servo command executed successfully via proxy.');
                } else {
                  console.error('Failed to communicate with ESP32 Servo via proxy.');
                }
              })
              .catch(() => {
                console.error('Failed to communicate with ESP32 Servo via proxy.');
              });
          }
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    startAndMonitor();

    const statusMsgTimer = setTimeout(() => {
      if (active && loading) {
        setStatusMessage('Initializing Camera & Vision Engine...');
      }
    }, 2500);

    return () => {
      active = false;
      clearTimeout(statusMsgTimer);
      if (pollInterval) clearInterval(pollInterval);
      window.removeEventListener('keydown', handleKeyDown);
      eventSource.close();
      stopAI();
    };
  }, [cameraSelected, selectedOption, esp32IP, apiBase]);

  const handleExit = async () => {
    await stopAI();
    setPage('home');
  };

  // Camera selection screen
  if (!cameraSelected) {
    return (
      <div className="min-h-screen bg-transparent px-5 pt-12 pb-10 animate-fade-in flex flex-col justify-between">
        <div>
          <BackButton onClick={handleExit} />

          {/* Cruise Control header: icon + title inline, subtitle underneath */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-10 h-10 rounded-2xl glass flex items-center justify-center border border-white/10 shrink-0">
                {AiOutlineIcon}
              </div>
              <h1 className="text-2xl font-bold tracking-tight">Cruise Control</h1>
            </div>
            <p className="text-white/50 text-sm mt-1 ml-[52px]">Real-time object detection &amp; tracking</p>
          </div>

          {/* Select Camera Dialog */}
          <div className="glass rounded-3xl p-6 border border-white/10 backdrop-blur-md flex flex-col space-y-6 animate-slide-up">
            <div className="text-center">
              <h2 className="text-xl font-bold text-white mb-2">Select Camera</h2>
              <p className="text-white/45 text-xs leading-relaxed">
                Choose which camera device to use for Cruise Control tracking
              </p>
            </div>

            {camerasLoading ? (
              <div className="flex justify-center py-4">
                <Spinner size={28} className="text-blue-400" />
              </div>
            ) : (
              <div className="flex flex-col space-y-3">
                <button
                  onClick={() => setSelectedOption('back')}
                  className={`w-full py-4 rounded-2xl border text-sm font-semibold tracking-wide transition-all duration-300 flex items-center justify-center gap-2 ${
                    selectedOption === 'back'
                      ? 'bg-blue-500/10 border-blue-500/40 text-blue-400 shadow-[inset_0_0_12px_rgba(59,130,246,0.2)]'
                      : 'bg-white/5 border-white/10 text-white/80 hover:bg-white/10'
                  }`}
                >
                  Back Camera
                </button>

                <button
                  onClick={() => setSelectedOption('front')}
                  className={`w-full py-4 rounded-2xl border text-sm font-semibold tracking-wide transition-all duration-300 flex items-center justify-center gap-2 ${
                    selectedOption === 'front'
                      ? 'bg-blue-500/10 border-blue-500/40 text-blue-400 shadow-[inset_0_0_12px_rgba(59,130,246,0.2)]'
                      : 'bg-white/5 border-white/10 text-white/80 hover:bg-white/10'
                  }`}
                >
                  Front Camera
                </button>
              </div>
            )}

            {!camerasLoading && (
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleExit}
                  className="flex-1 py-4 rounded-2xl bg-white/5 border border-white/10 text-white/70 font-semibold text-sm hover:bg-white/10 active:scale-[0.98] transition-transform"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setCameraSelected(true)}
                  className="flex-1 py-4 rounded-2xl bg-blue-500/20 border border-blue-500/30 text-blue-400 font-bold text-sm hover:bg-blue-500/30 active:scale-[0.98] transition-transform"
                  disabled={!selectedOption}
                >
                  Continue
                </button>
              </div>
            )}
          </div>
        </div>

        {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent px-5 pt-12 pb-10 animate-fade-in flex flex-col justify-between">
      <div>
        <BackButton onClick={handleExit} />

        {/* Cruise Control header: icon + title inline, subtitle underneath */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-2xl glass flex items-center justify-center border border-white/10 shrink-0">
              {AiOutlineIcon}
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Cruise Control</h1>
          </div>
          <p className="text-white/50 text-sm mt-1 ml-[52px]">Real-time object detection &amp; tracking</p>
        </div>

        {/* Viewfinder / Live Feed Card */}
        <div
          className="relative rounded-3xl overflow-hidden bg-black/30 border border-white/10 mb-5 flex items-center justify-center"
          style={{ aspectRatio: `640 / 480`, width: '100%', maxHeight: '50vh' }}
        >
          {/* HTML <video> element always renders the live device camera stream directly from getUserMedia() */}
          <video
            ref={videoRef}
            playsInline
            autoPlay
            muted
            controls={false}
            className="w-full h-full object-cover rounded-3xl"
            style={{ display: 'block' }}
          />

          {/* When AI vision engine is active, overlay the AI detection stream (bounding boxes, gesture indicator) over the video */}
          {running && (
            <img
              src={`${apiBase}/ai/stream`}
              alt="AI Vision Overlay"
              className="w-full h-full object-cover absolute inset-0 pointer-events-none rounded-3xl"
              style={{ display: 'block' }}
            />
          )}

          {loading && (
            <div className="absolute inset-0 bg-black/50 p-5 flex flex-col items-center justify-center text-center space-y-4 rounded-3xl z-10">
              <Spinner size={36} className="text-blue-400" />
              <p className="text-white/60 text-sm">{statusMessage}</p>
            </div>
          )}

          {!loading && !running && (
            <div className="absolute inset-0 bg-black/80 p-6 flex flex-col items-center justify-center text-center space-y-3 max-w-full overflow-y-auto max-h-full rounded-3xl z-10">
              <p className="text-red-400 text-base font-semibold">Camera Offline</p>
              {errorDetail ? (
                <div className="text-left w-full max-w-md bg-black/40 border border-red-500/20 rounded-xl p-4 font-mono text-[10px] text-red-300 whitespace-pre-wrap break-all leading-normal">
                  {errorDetail}
                </div>
              ) : (
                <p className="text-white/40 text-xs">Failed to connect to the camera device</p>
              )}
            </div>
          )}
        </div>

      </div>

      <button
        onClick={handleExit}
        className="w-full py-5 rounded-3xl glass-red text-red-400 font-bold text-lg active:scale-95 transition-transform"
      >
        Exit Cruise Control
      </button>

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}
