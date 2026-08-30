import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { BackButton, PageHeader, PrimaryButton, Toast, Modal, SecondaryButton } from '../components/UI';

// ─── ESP32 communication – PROXY ROUTED ─────────────────────────────
async function sendJogCommand(direction, angleDeg, esp32IP) {
  const command = direction === 'right' ? 'right' : 'left';
  const url = `/api/esp32/${command}?angle=${angleDeg}`;

  if (command === 'left') {
    console.log(`Sending Servo Command: LEFT with angle ${angleDeg}`);
  } else {
    console.log(`Sending Servo Command: RIGHT with angle ${angleDeg}`);
  }

  try {
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log('Servo command executed successfully.');
    return response.json().catch(() => ({ ok: true }));
  } catch (err) {
    console.error('Failed to communicate with ESP32 Servo via proxy.');
    throw err;
  }
}

export async function sendBoundaryCommand() {
  // Not needed – ESP32 uses per‑click API
}
// ─────────────────────────────────────────────────────────────────────────

const RAIL_MIN = -120;
const RAIL_MAX = 120;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function validateBoundaries(startPosition, endPosition) {
  if (typeof startPosition !== 'number' || typeof endPosition !== 'number') {
    return { valid: false, error: 'Set both Start and End positions first.' };
  }
  if (startPosition >= endPosition) {
    return { valid: false, error: 'Start must be to the left of End.' };
  }
  return { valid: true, error: null };
}

const ARC_CX = 140, ARC_CY = 115, ARC_R = 96;
const ARC_HALF_DEG = 52;

function posToArcAngle(pos) {
  return (pos / RAIL_MAX) * ARC_HALF_DEG;
}
function arcPoint(angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: ARC_CX + ARC_R * Math.cos(rad), y: ARC_CY + ARC_R * Math.sin(rad) };
}

export default function MotionSetupPage() {
  const { setPage, motion, updateMotion, esp32IP, currentPreset, setCurrentPreset } = useApp();

  const [currentPosition, setCurrentPosition] = useState(0);
  const [startPosition, setStartPosition] = useState(motion.startPosition ?? null);
  const [endPosition, setEndPosition] = useState(motion.endPosition ?? null);

  const currentPosRef = useRef(0);
  const startPosRef = useRef(motion.startPosition ?? null);
  const endPosRef = useRef(motion.endPosition ?? null);

  const [setPhase, setSetPhase] = useState(
    (motion.startPosition ?? null) !== null ? 'end' : 'start'
  );
  const [packetAngle, setPacketAngle] = useState(motion.packetAngle ?? 50);
  const packetAngleRef = useRef(motion.packetAngle ?? 50);

  const [isJogging, setIsJogging] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [toast, setToast] = useState(null);
  const [statusText, setStatusText] = useState('Ready');
  const cancelMovementRef = useRef(false);

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');

  const setupVideoRef = useRef(null);
  const setupStreamRef = useRef(null);

  const [cameraStream, setCameraStream] = useState(null);
  const [cameraError, setCameraError] = useState(null);

  // Responsive/mobile-compatible environment camera initialization
  const startCamera = useCallback(async (isUserInteraction = false) => {
    if (setupStreamRef.current) {
      setupStreamRef.current.getTracks().forEach(track => track.stop());
      setupStreamRef.current = null;
    }
    if (setupVideoRef.current) {
      setupVideoRef.current.srcObject = null;
    }

    setCameraError(null);
    setCameraStream(null);

    const constraintsList = [
      { video: { facingMode: { ideal: 'environment' } } },
      { video: { facingMode: 'environment' } },
      { video: true }
    ];

    let lastError = null;
    for (const constraints of constraintsList) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setupStreamRef.current = stream;
        if (setupVideoRef.current) {
          setupVideoRef.current.srcObject = stream;
          const playPromise = setupVideoRef.current.play();
          if (playPromise !== undefined) {
            playPromise.catch(e => {
              console.warn("Video play deferred:", e);
            });
          }
        }
        setCameraStream(stream);
        return;
      } catch (err) {
        lastError = err;
        console.warn('Failed constraints try:', constraints, err);
      }
    }

    if (lastError) {
      console.error('All camera attempts failed:', lastError);
      if (lastError.name === 'NotAllowedError' || lastError.name === 'PermissionDeniedError') {
        setCameraError('Camera access denied. Please allow camera access in settings.');
      } else {
        setCameraError(`Camera Error: ${lastError.message || 'Unable to access camera.'}`);
      }
    }
  }, []);

  useEffect(() => {
    startCamera(false);

    return () => {
      if (setupStreamRef.current) {
        setupStreamRef.current.getTracks().forEach(track => track.stop());
        setupStreamRef.current = null;
      }
    };
  }, [startCamera]);

  // Sync state with global context values (e.g. when presets are opened)
  useEffect(() => {
    if (motion.startPosition !== undefined) {
      setStartPosition(motion.startPosition);
      startPosRef.current = motion.startPosition;
    } else {
      setStartPosition(null);
      startPosRef.current = null;
    }
    if (motion.endPosition !== undefined) {
      setEndPosition(motion.endPosition);
      endPosRef.current = motion.endPosition;
    } else {
      setEndPosition(null);
      endPosRef.current = null;
    }
    setSetPhase((motion.startPosition ?? null) !== null ? 'end' : 'start');

    if (motion.packetAngle !== undefined) {
      setPacketAngle(motion.packetAngle);
      packetAngleRef.current = motion.packetAngle;
    } else {
      setPacketAngle(50);
      packetAngleRef.current = 50;
    }
  }, [motion.startPosition, motion.endPosition, motion.packetAngle]);

  const setCurrentPos = useCallback((pos) => {
    const v = clamp(pos, RAIL_MIN, RAIL_MAX);
    currentPosRef.current = v;
    setCurrentPosition(v);
  }, []);

  const handleSetButton = useCallback(() => {
    if (setPhase === 'start') {
      const pos = currentPosRef.current;
      startPosRef.current = pos;
      setStartPosition(pos);
      updateMotion({ startPosition: pos });
      // ─── Send to ESP32 ──────────────────────────────────────
      if (esp32IP) {
        fetch(`/api/esp32/set-start?angle=${pos}`)
          .catch(err => console.warn('set-start failed:', err));
      }
      setToast({ message: `Start locked at ${pos}`, type: 'success' });
      setSetPhase('end');
    } else {
      const pos = currentPosRef.current;
      if (startPosRef.current !== null && pos <= startPosRef.current) {
        setToast({ message: 'Move further right before setting End', type: 'error' });
        return;
      }
      endPosRef.current = pos;
      setEndPosition(pos);
      updateMotion({ endPosition: pos });
      if (esp32IP) {
        fetch(`/api/esp32/set-end?angle=${pos}`)
          .catch(err => console.warn('set-end failed:', err));
      }
      setToast({ message: `End locked at ${pos}`, type: 'success' });
    }
  }, [setPhase, updateMotion, esp32IP]);

  const handleSliderChange = (e) => {
    const newAngle = Number(e.target.value);
    setPacketAngle(newAngle);
    packetAngleRef.current = newAngle;
    updateMotion({ packetAngle: newAngle });
  };

  // ─── Jog (single step) ──────────────────────────────────────────────────
  const jog = useCallback(async (direction) => {
    if (isMoving || isJogging) return;
    // Fallback to localStorage in case AppContext hasn't synced the IP yet
    const effectiveIP = esp32IP || localStorage.getItem('esp32_ip') || '';
    if (!effectiveIP) {
      setToast({ message: 'ESP32 IP not set – please reconnect from home page', type: 'error' });
      return;
    }
    setIsJogging(true);
    setStatusText(direction === 'left' ? 'Moved Left' : 'Moved Right');
    // ─── FIX: use current slider value (step length) ────────────────
    const angle = packetAngleRef.current;
    const deltaUI = angle / 10;   // UI arc moves proportionally
    const next = clamp(currentPosRef.current + (direction === 'right' ? deltaUI : -deltaUI), RAIL_MIN, RAIL_MAX);
    try {
      await sendJogCommand(direction, angle, effectiveIP);
      setCurrentPos(next);
    } catch (err) {
      setCurrentPos(next);
      setToast({ message: `Motor command failed: ${err.message}`, type: 'error' });
    } finally {
      setIsJogging(false);
    }
  }, [isMoving, isJogging, setCurrentPos, esp32IP, packetAngleRef]);

  // ─── Move to target using multiple step commands ──────────────────────
  const moveToPosition = useCallback(async (targetPos, onProgress) => {
    // Fallback to localStorage in case AppContext hasn't synced the IP yet
    const effectiveIP = esp32IP || localStorage.getItem('esp32_ip') || '';
    if (!effectiveIP) throw new Error('ESP32 IP not set');
    const fromPos = currentPosRef.current;
    const totalUI = targetPos - fromPos;
    if (Math.abs(totalUI) < 0.01) return true;
    const direction = totalUI > 0 ? 'right' : 'left';

    // Calculate how many steps needed based on the current step length
    const stepUI = packetAngleRef.current / 10;   // UI step per command
    const steps = Math.ceil(Math.abs(totalUI) / stepUI);
    const stepAngle = packetAngleRef.current;      // angle in degrees per command

    for (let i = 0; i < steps; i++) {
      if (cancelMovementRef.current) return false;
      // Determine if this is the last step (maybe smaller to exactly hit target)
      let thisUI = stepUI;
      if (i === steps - 1) {
        const remaining = targetPos - currentPosRef.current;
        thisUI = remaining;
      }
      const thisAngle = Math.abs(thisUI) * 10;  // convert UI to angle
      if (thisAngle < 1) break;

      await sendJogCommand(direction, thisAngle, effectiveIP);
      const newPos = clamp(currentPosRef.current + (direction === 'right' ? thisUI : -thisUI), RAIL_MIN, RAIL_MAX);
      setCurrentPos(newPos);
      if (onProgress) onProgress((i + 1) / steps);
      // small delay between steps to let servo move smoothly
      await new Promise(r => setTimeout(r, 50));
    }
    return true;
  }, [setCurrentPos, esp32IP, packetAngleRef]);

  // ─── Reset: move to Start ──────────────────────────────────────────────
  const resetToStart = useCallback(async () => {
    if (isMoving || isJogging) return;
    const sp = startPosRef.current;
    if (sp === null) { setToast({ message: 'Start position not set', type: 'error' }); return; }
    if (Math.abs(currentPosRef.current - sp) < 0.01) { setToast({ message: 'Already at Start position', type: 'info' }); return; }
    setIsMoving(true);
    setStatusText('Moving to Start...');
    cancelMovementRef.current = false;
    setToast({ message: `Moving to Start (${sp})…`, type: 'info' });
    try {
      // Call /reset on ESP32 – the firmware will handle the smooth movement internally
      const resetRes = await fetch(`/api/esp32/reset`, { method: 'POST' });
      if (!resetRes.ok) throw new Error('Reset request failed');
      // For UI, we can animate the position to the target (we know the start value)
      // We'll just set the current position to start after a short delay (simulate movement)
      // A better approach: poll status, but for simplicity we set it after some time.
      // We'll use moveToPosition which sends multiple commands – this actually works
      // because the firmware's /left and /right update the servo angle.
      // But /reset already moves the servo to start internally; we just need to update UI.
      // So we can just set the UI position to the start after a few seconds.
      setTimeout(() => {
        setCurrentPos(sp);
        setToast({ message: `At Start (${sp})`, type: 'success' });
        setIsMoving(false);
        setStatusText('Ready');
      }, 1500); // assume 1.5s for movement
    } catch (err) {
      setToast({ message: `Reset failed: ${err.message}`, type: 'error' });
      setStatusText('Error');
      setIsMoving(false);
    }
  }, [isMoving, isJogging, esp32IP]);

  // ─── Start: move to End ──────────────────────────────────────────────
  const startMotion = useCallback(async () => {
    if (isMoving || isJogging) return;
    const ep = endPosRef.current;
    if (ep === null) { setToast({ message: 'End position not set', type: 'error' }); return; }
    if (Math.abs(currentPosRef.current - ep) < 0.01) { setToast({ message: 'Already at End position', type: 'info' }); return; }
    setIsMoving(true);
    setStatusText('Moving to End...');
    cancelMovementRef.current = false;
    setToast({ message: `Moving → End (${ep})…`, type: 'info' });
    try {
      // Call /start on ESP32 – firmware will sweep from Start to End
      const startRes = await fetch(`/api/esp32/start`, { method: 'POST' });
      if (!startRes.ok) throw new Error('Start request failed');
      // Update UI after a delay
      setTimeout(() => {
        setCurrentPos(ep);
        setToast({ message: `Reached End (${ep})`, type: 'success' });
        setIsMoving(false);
        setStatusText('Ready');
      }, 1500);
    } catch (err) {
      setToast({ message: `Movement failed: ${err.message}`, type: 'error' });
      setStatusText('Error');
      setIsMoving(false);
    }
  }, [isMoving, isJogging, esp32IP]);

  const stopAllMotion = useCallback(() => {
    if (isMoving || isJogging) {
      cancelMovementRef.current = true;
      setIsMoving(false);
      setIsJogging(false);
      setStatusText('Stopped');
      setToast({ message: 'Motion stopped', type: 'info' });
      // Also send /stop to ESP32 to halt any ongoing sweep
      if (esp32IP) {
        fetch(`/api/esp32/stop`, { method: 'POST' }).catch(() => { });
      }
    }
  }, [isMoving, isJogging, esp32IP]);

  const handleSaveClick = () => {
    const check = validateBoundaries(startPosition, endPosition);
    if (!check.valid) {
      setToast({ message: check.error, type: 'error' });
      return;
    }
    setSaveName(currentPreset ? currentPreset.name : '');
    setShowSaveModal(true);
  };

  const handleSavePreset = () => {
    if (!saveName.trim()) {
      setToast({ message: 'Please enter a preset name', type: 'error' });
      return;
    }

    const PRESETS_STORAGE_KEY = 'robocam_motion_presets';
    let presets = [];
    try {
      const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
      presets = raw ? JSON.parse(raw) : [];
    } catch (e) {
      presets = [];
    }

    if (currentPreset) {
      const updatedPresets = presets.map(p => {
        if (p.id === currentPreset.id) {
          return {
            ...p,
            name: saveName.trim(),
            start: startPosition,
            end: endPosition,
            packetAngle: packetAngle,
          };
        }
        return p;
      });
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(updatedPresets));

      const updatedPreset = {
        ...currentPreset,
        name: saveName.trim(),
        start: startPosition,
        end: endPosition,
        packetAngle: packetAngle
      };
      setCurrentPreset(updatedPreset);
      updateMotion({
        startPosition: startPosition,
        endPosition: endPosition,
        packetAngle: packetAngle,
        preset: saveName.trim()
      });

      setToast({ message: 'Preset updated successfully!', type: 'success' });
    } else {
      const newPreset = {
        id: Date.now().toString(),
        name: saveName.trim(),
        start: startPosition,
        end: endPosition,
        packetAngle: packetAngle,
        createdAt: new Date().toISOString()
      };
      presets.push(newPreset);
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));

      setCurrentPreset(newPreset);
      updateMotion({
        startPosition: startPosition,
        endPosition: endPosition,
        packetAngle: packetAngle,
        preset: saveName.trim()
      });

      setToast({ message: 'Preset saved successfully!', type: 'success' });
    }
    setShowSaveModal(false);
  };

  // Arc visualisation – unchanged
  const displayPos = currentPosition;
  const carriagePt = arcPoint(posToArcAngle(displayPos));
  const railLeftPt = arcPoint(-ARC_HALF_DEG);
  const railRightPt = arcPoint(ARC_HALF_DEG);
  const railPath = `M ${railLeftPt.x} ${railLeftPt.y} A ${ARC_R} ${ARC_R} 0 0 1 ${railRightPt.x} ${railRightPt.y}`;

  const startSet = startPosition !== null;
  const endSet = endPosition !== null;
  const bothSet = startSet && endSet;
  const startPt = startSet ? arcPoint(posToArcAngle(startPosition)) : null;
  const endPt = endSet ? arcPoint(posToArcAngle(endPosition)) : null;
  let rangePath = null;
  if (bothSet) {
    const sa = posToArcAngle(startPosition);
    const ea = posToArcAngle(endPosition);
    const sp2 = arcPoint(sa);
    const ep2 = arcPoint(ea);
    rangePath = `M ${sp2.x} ${sp2.y} A ${ARC_R} ${ARC_R} 0 0 1 ${ep2.x} ${ep2.y}`;
  }

  const anyMovement = isMoving || isJogging;
  const sliderPercent = ((packetAngle - 10) / 90) * 100;
  const isStartPhase = setPhase === 'start';
  const setButtonLabel = isStartPhase
    ? (startSet ? `✓ ${startPosition}  · Re-set Start` : 'Set Start')
    : (endSet ? `✓ ${endPosition}  · Re-set End` : 'Set End');

  const setButtonStyle = {
    width: '100%',
    padding: '13px 0',
    borderRadius: 14,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    transition: 'all 220ms ease',
    cursor: anyMovement ? 'not-allowed' : 'pointer',
    opacity: anyMovement ? 0.5 : 1,
    border: isStartPhase
      ? (startSet ? '1.5px solid rgba(91,140,255,0.65)' : '1px solid rgba(255,255,255,0.15)')
      : (endSet ? '1.5px solid rgba(34,197,94,0.55)' : '1px solid rgba(255,255,255,0.15)'),
    background: isStartPhase
      ? (startSet ? 'rgba(91,140,255,0.15)' : 'rgba(255,255,255,0.05)')
      : (endSet ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.05)'),
    color: isStartPhase
      ? (startSet ? '#7BAAFF' : 'rgba(255,255,255,0.55)')
      : (endSet ? '#4ADE80' : 'rgba(255,255,255,0.55)'),
  };

  const outlinedJogBox = (disabled) => ({
    flex: 1,
    height: '70px',
    borderRadius: 18,
    border: disabled
      ? '1px solid rgba(255,255,255,0.06)'
      : '1.5px solid rgba(255,255,255,0.22)',
    background: 'transparent',
    color: disabled ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.88)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    transition: 'all 200ms ease',
    flexShrink: 0,
    boxShadow: disabled ? 'none' : '0 0 15px rgba(255, 255, 255, 0.05)',
  });

  return (
    <div className="min-h-screen bg-transparent px-4 pt-12 pb-10">
      <BackButton onClick={() => setPage('manual-control')} />
      <PageHeader
        title={currentPreset ? currentPreset.name : "Motion Setup"}
        subtitle={currentPreset ? "Saved cinematic motion path" : "Set start & end positions for your camera path"}
      />

      {/* Live Camera Viewfinder */}
      <div className="relative rounded-3xl overflow-hidden bg-black/40 border border-white/10 mb-6" style={{ height: '280px' }}>
        <video
          ref={setupVideoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          className="w-full h-full object-cover"
          style={{
            display: cameraError ? 'none' : 'block',
            transform: `translateX(${-currentPosition * 0.12}%) scale(1.35)`,
            transition: isMoving ? 'transform 100ms linear' : 'transform 200ms ease-out',
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />
        {cameraError ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center absolute inset-0 bg-black/60">
            <p className="text-white/60 text-xs mb-3 font-sans px-4">{cameraError}</p>
            <button
              onClick={() => startCamera(true)}
              className="px-4 py-2 rounded-xl border border-accent/40 bg-accent/10 hover:bg-accent/25 text-accent text-xs font-semibold tracking-wider uppercase transition-all duration-200"
            >
              Retry Camera Access
            </button>
          </div>
        ) : (
          <>
            {!cameraStream && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <span className="w-4 h-4 rounded-full border-2 border-t-transparent border-accent animate-spin" />
              </div>
            )}
            <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-[0_0_15px_rgba(34,197,94,0.1)]">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[10px] font-mono font-bold tracking-wider text-green-400 uppercase">Live View</span>
            </div>
          </>
        )}
      </div>

      {/* Arc Viz Card */}
      <div className="glass-panel" style={{ borderRadius: 18, marginBottom: 20, overflow: 'hidden', padding: '24px 0 10px 0' }}>
        <svg viewBox="0 0 280 118" width="100%" style={{ display: 'block' }}>
          <defs>
            <linearGradient id="rangeG" gradientUnits="userSpaceOnUse"
              x1={startPt?.x ?? 80} y1={startPt?.y ?? 80}
              x2={endPt?.x ?? 200} y2={endPt?.y ?? 80}>
              <stop offset="0%" stopColor="#3B82F6" />
              <stop offset="55%" stopColor="#8B5CF6" />
              <stop offset="100%" stopColor="#22C55E" />
            </linearGradient>
          </defs>
          <path d={railPath} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="10" strokeLinecap="round" />
          <path d={railPath} fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="4" strokeLinecap="round" />
          {rangePath && <path d={rangePath} fill="none" stroke="url(#rangeG)" strokeWidth="4" strokeLinecap="round" />}
          {startSet && startPt && (<>
            <circle cx={startPt.x} cy={startPt.y} r={8} fill="rgba(59,130,246,0.25)" />
            <circle cx={startPt.x} cy={startPt.y} r={5} fill="#3B82F6" />
            <text x={startPt.x} y={startPt.y - 13} textAnchor="middle" fontSize="8" fill="rgba(96,165,250,0.85)" fontFamily="monospace" fontWeight="bold">S</text>
          </>)}
          {endSet && endPt && (<>
            <circle cx={endPt.x} cy={endPt.y} r={8} fill="rgba(34,197,94,0.25)" />
            <circle cx={endPt.x} cy={endPt.y} r={5} fill="#22C55E" />
            <text x={endPt.x} y={endPt.y - 13} textAnchor="middle" fontSize="8" fill="rgba(74,222,128,0.85)" fontFamily="monospace" fontWeight="bold">E</text>
          </>)}
          <circle cx={carriagePt.x} cy={carriagePt.y} r={16}
            fill={anyMovement ? 'rgba(245,158,11,0.15)' : 'rgba(91,140,255,0.12)'} />
          <circle cx={carriagePt.x} cy={carriagePt.y} r={10}
            fill={anyMovement ? '#F59E0B' : '#FFFFFF'}
            stroke={anyMovement ? 'rgba(245,158,11,0.5)' : 'rgba(91,140,255,0.7)'}
            strokeWidth="2.5" />
          <text x={railLeftPt.x - 8} y={railLeftPt.y + 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.2)" fontFamily="monospace">L</text>
          <text x={railRightPt.x + 8} y={railRightPt.y + 4} textAnchor="start" fontSize="9" fill="rgba(255,255,255,0.2)" fontFamily="monospace">R</text>
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 16px 10px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <span style={{ flex: 1, textAlign: 'left', fontSize: 10, color: 'rgba(255,255,255,0.28)', fontFamily: 'monospace' }}>{startSet ? `S ${startPosition}` : ''}</span>
          <span style={{ flex: 1, textAlign: 'center', fontSize: 14, fontFamily: 'monospace', fontWeight: 700, color: anyMovement ? '#FBBF24' : '#7BAAFF' }}>{statusText}</span>
          <span style={{ flex: 1, textAlign: 'right', fontSize: 10, color: 'rgba(255,255,255,0.28)', fontFamily: 'monospace' }}>{endSet ? `E ${endPosition}` : ''}</span>
        </div>
      </div>

      {/* Hide jog & set bounds controls if currentPreset is active */}
      {!currentPreset && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 28 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <button className="big-jog-btn" disabled={anyMovement} onClick={() => jog('left')} style={outlinedJogBox(anyMovement)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="17 4 7 12 17 20 17 4" fill="none" />
              </svg>
            </button>
            <button className="big-jog-btn" disabled={anyMovement} onClick={() => jog('right')} style={outlinedJogBox(anyMovement)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="7 4 17 12 7 20 7 4" fill="none" />
              </svg>
            </button>
          </div>
          <button style={setButtonStyle} disabled={anyMovement} onClick={handleSetButton}>{setButtonLabel}</button>
          <button
            style={{
              width: '100%',
              padding: '13px 0',
              borderRadius: 14,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              transition: 'all 220ms ease',
              cursor: (anyMovement || (!startSet && !endSet)) ? 'not-allowed' : 'pointer',
              opacity: (anyMovement || (!startSet && !endSet)) ? 0.4 : 1,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.75)',
            }}
            disabled={anyMovement || (!startSet && !endSet)}
            onClick={() => {
              if (anyMovement) return;
              startPosRef.current = null;
              endPosRef.current = null;
              setStartPosition(null);
              setEndPosition(null);
              setSetPhase('start');
              setCurrentPreset(null);
              updateMotion({ startPosition: null, endPosition: null, preset: null });
              setStatusText('Ready');
              setToast({ message: 'Motion setup reset. Set new Start position.', type: 'info' });
            }}
          >
            Reset Motion Setup
          </button>
        </div>
      )}

      {/* Speed Control */}
      {currentPreset ? (
        <div className="relative rounded-3xl overflow-hidden mb-8 glass-blue">
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)' }} />
          <div className="p-5 flex items-center justify-between">
            <div className="flex flex-col">
              <div className="flex items-center mb-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 mr-1.5">
                  <path d="M12 14l4-4" />
                  <path d="M3.34 16A10 10 0 1 1 20.66 16" />
                </svg>
                <p className="text-white/40 text-xs font-mono uppercase tracking-widest">Speed Control</p>
              </div>
              <p className="text-white/60 text-sm">{packetAngle <= 20 ? 'Smooth' : packetAngle >= 80 ? 'Fast' : 'Balanced'}</p>
            </div>
            <div style={{ background: 'rgba(165,180,252,0.12)', border: '1px solid rgba(165,180,252,0.25)', borderRadius: 14, padding: '6px 14px' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#a5b4fc', lineHeight: 1 }}>{packetAngle}</span>
              <span style={{ fontSize: 12, color: 'rgba(165,180,252,0.6)', marginLeft: 4 }}>°</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative rounded-3xl overflow-hidden mb-8 glass-blue">
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)' }} />
          <div className="p-5">
            <div className="flex items-start justify-between mb-6">
              <div className="flex flex-col">
                <div className="flex items-center mb-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 mr-1.5">
                    <path d="M12 14l4-4" />
                    <path d="M3.34 16A10 10 0 1 1 20.66 16" />
                  </svg>
                  <p className="text-white/40 text-xs font-mono uppercase tracking-widest">Speed Control</p>
                </div>
                <p className="text-white/60 text-sm">{packetAngle <= 20 ? 'Smooth' : packetAngle >= 80 ? 'Fast' : 'Balanced'}</p>
              </div>
              <div style={{ background: 'rgba(165,180,252,0.12)', border: '1px solid rgba(165,180,252,0.25)', borderRadius: 14, padding: '6px 14px' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#a5b4fc', lineHeight: 1 }}>{packetAngle}</span>
                <span style={{ fontSize: 12, color: 'rgba(165,180,252,0.6)', marginLeft: 4 }}>°</span>
              </div>
            </div>
            <div className="relative" style={{ paddingBottom: 4 }}>
              <div className="relative" style={{ height: 44, display: 'flex', alignItems: 'center' }}>
                <div style={{ position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 99, background: 'rgba(255,255,255,0.08)' }} />
                <div style={{ position: 'absolute', left: 0, width: `${sliderPercent}%`, height: 6, borderRadius: 99, background: 'linear-gradient(90deg, #93c5fd 0%, #a5b4fc 50%, #c7d2fe 100%)', transition: 'width 120ms ease-out' }} />
                <div style={{ position: 'absolute', left: `calc(${sliderPercent}% - 14px)`, width: 28, height: 28, borderRadius: '50%', background: 'rgba(165,180,252,0.22)', filter: 'blur(8px)', transition: 'left 120ms ease-out', pointerEvents: 'none' }} />
                <input type="range" min="10" max="100" step="5" value={packetAngle} onChange={handleSliderChange} className="speed-slider" style={{ position: 'absolute', width: '100%', zIndex: 10 }} />
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Buttons: Reset, Start, Stop */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <PrimaryButton onClick={resetToStart} disabled={anyMovement || !bothSet} variant="yellow" className="flex-1">{isMoving ? '⏳ Moving…' : '↺ RESET'}</PrimaryButton>
        <PrimaryButton onClick={startMotion} disabled={anyMovement || !bothSet} variant="green" className="flex-1">{isMoving ? '⏳ Moving…' : '▶ START'}</PrimaryButton>
        <button className="glass-red" onClick={stopAllMotion} disabled={!anyMovement} style={{ flex: 1, padding: '12px 0', borderRadius: 40, fontWeight: 700, fontSize: 14, letterSpacing: '0.05em', color: '#f87171', cursor: !anyMovement ? 'not-allowed' : 'pointer', opacity: !anyMovement ? 0.5 : 1, transition: 'all 180ms' }}>STOP</button>
      </div>

      {/* Hide SAVE button if currentPreset is active */}
      {!currentPreset && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={handleSaveClick}
            disabled={anyMovement || !bothSet}
            className="w-full py-3.5 rounded-2xl glass-blue text-accent font-bold text-sm tracking-wider transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 hover:brightness-110"
          >
            SAVE
          </button>
        </div>
      )}

      <style jsx>{`
        .speed-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 44px; cursor: pointer; margin: 0; }
        .speed-slider::-webkit-slider-runnable-track { height: 6px; background: transparent; border-radius: 99px; }
        .speed-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 26px; height: 26px; border-radius: 50%; background: #ffffff; border: 2.5px solid #a5b4fc; margin-top: -6px; box-shadow: 0 0 0 4px rgba(165,180,252,0.18), 0 2px 8px rgba(0,0,0,0.4); transition: transform 150ms ease, box-shadow 150ms ease; }
        .speed-slider:active::-webkit-slider-thumb { transform: scale(1.15); box-shadow: 0 0 0 6px rgba(165,180,252,0.28), 0 2px 12px rgba(0,0,0,0.5); }
        .speed-slider::-moz-range-track { height: 6px; background: transparent; border-radius: 99px; }
        .speed-slider::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: #ffffff; border: 2.5px solid #a5b4fc; box-shadow: 0 0 0 4px rgba(165,180,252,0.18), 0 2px 8px rgba(0,0,0,0.4); cursor: grab; transition: transform 150ms ease; }
        .speed-slider:active::-moz-range-thumb { transform: scale(1.15); cursor: grabbing; }
        .big-jog-btn:active:not(:disabled) { transform: scale(0.93); background: rgba(255,255,255,0.13) !important; border-color: rgba(255,255,255,0.22) !important; }
      `}</style>

      <Modal
        open={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        title={currentPreset ? "Edit Preset" : "Save Preset"}
      >
        <div className="space-y-4 text-left">
          <div>
            <label className="block text-xs font-mono uppercase tracking-widest text-white/40 mb-2">Preset Name</label>
            <input
              autoFocus
              type="text"
              className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm outline-none focus:border-accent text-white transition-all duration-200"
              placeholder="e.g. Orbit Shot, Slow Sweep..."
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  handleSavePreset();
                }
              }}
            />
          </div>
          <div className="flex gap-3 pt-2">
            <SecondaryButton onClick={() => setShowSaveModal(false)} className="flex-1">
              Cancel
            </SecondaryButton>
            <PrimaryButton onClick={handleSavePreset} className="flex-1">
              Confirm
            </PrimaryButton>
          </div>
        </div>
      </Modal>

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}