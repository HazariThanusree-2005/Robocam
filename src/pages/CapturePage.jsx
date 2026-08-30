import { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { BackButton, PageHeader, Card, Spinner, Toast } from '../components/UI';
import { sendStartCommand, sendStopCommand } from '../utils/esp32';
import { saveRecording } from '../utils/db';

export default function CapturePageWrapper() {
  return <CapturePage />;
}

// ─── config ───────────────────────────────────────────────────────────────────

/**
 * Determines timelapse speed-up factor based on recorded video duration.
 * Longer recordings get higher speed-up to produce concise output.
 * Motor speed (delayMs) is NOT used here — it only controls the motor.
 */
function getTimelapseMultiplier(durationSec) {
  if (durationSec <= 10)  return 2;
  if (durationSec <= 30)  return 4;
  if (durationSec <= 60)  return 6;
  if (durationSec <= 120) return 8;
  if (durationSec <= 300) return 12;
  return 16;
}

/**
 * Build chained atempo filters for FFmpeg audio speed-up.
 * Each atempo filter supports 0.5–2.0 range, so we chain them.
 */
function buildAtempoChain(multiplier) {
  if (multiplier <= 1) return null;
  const parts = [];
  let rem = multiplier;
  while (rem > 2.0) {
    parts.push('atempo=2.0');
    rem /= 2.0;
  }
  if (rem > 1.001) {
    parts.push(`atempo=${rem.toFixed(4)}`);
  }
  return parts.join(',') || null;
}

// ─── ffmpeg singleton – NO CDN, NO raw paths, ONLY blob URLs ─────────────────
let ffmpegInstance = null;
let ffmpegLoading = false;
let ffmpegQueue = [];

async function getFFmpeg(onLog) {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) {
    return new Promise((res, rej) => ffmpegQueue.push({ res, rej }));
  }
  ffmpegLoading = true;

  try {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { fetchFile } = await import('@ffmpeg/util');

    // ✅ Fetch local files and create blob URLs – Vite cannot intercept blobs
    const workerRes = await fetch('/ffmpeg/worker.js');
    const workerBlob = await workerRes.blob();
    const workerURL = URL.createObjectURL(workerBlob);

    const coreRes = await fetch('/ffmpeg/ffmpeg-core.js');
    const coreBlob = await coreRes.blob();
    const coreURL = URL.createObjectURL(coreBlob);

    const wasmRes = await fetch('/ffmpeg/ffmpeg-core.wasm');
    const wasmBlob = await wasmRes.blob();
    const wasmURL = URL.createObjectURL(wasmBlob);

    const ff = new FFmpeg();
    if (onLog) ff.on('log', ({ message }) => onLog(message));

    await ff.load({ workerURL, coreURL, wasmURL });

    // Clean up blob URLs – they are no longer needed
    URL.revokeObjectURL(workerURL);
    URL.revokeObjectURL(coreURL);
    URL.revokeObjectURL(wasmURL);

    ffmpegInstance = { ff, fetchFile };
    ffmpegQueue.forEach(cb => cb.res(ffmpegInstance));
    ffmpegQueue = [];
    return ffmpegInstance;
  } catch (err) {
    console.error('[ffmpeg] Local load failed:', err);
    ffmpegLoading = false;
    ffmpegQueue.forEach(cb => cb.rej(err));
    ffmpegQueue = [];
    throw err;
  }
}

// ─── constants ────────────────────────────────────────────────────────────────
const FALLBACK_W = 1280;
const FALLBACK_H = 720;

// ─── component ────────────────────────────────────────────────────────────────
function CapturePage() {
  const { setPage, motion, esp32IP } = useApp();

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const vidWRef = useRef(FALLBACK_W);
  const vidHRef = useRef(FALLBACK_H);
  const mediaRecorderRef = useRef(null);
  const rawChunksRef = useRef([]);
  const durRef = useRef(0);
  const timerRef = useRef(null);
  const wakeLockRef = useRef(null);

  const [camActive, setCamActive] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [duration, setDuration] = useState(0);
  const [videoDims, setVideoDims] = useState({ w: FALLBACK_W, h: FALLBACK_H });
  const [wakeLockOn, setWakeLockOn] = useState(false);
  const [toast, setToast] = useState(null);

  const toast$ = (msg, type = 'info') => setToast({ message: msg, type });

  const startPosition = motion?.startPosition ?? null;
  const endPosition = motion?.endPosition ?? null;
  const delayMs = motion?.delay ?? 100;
  const pauseDuration = motion?.pauseDuration ?? 1;
  const presetName = motion?.preset ?? null;
  const boundariesSet = startPosition !== null && endPosition !== null;
  const rangeSteps = boundariesSet ? (endPosition - startPosition) : null;
  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ── lifecycle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    startCam();
    getFFmpeg().catch(() => { }); // warm-up
    return () => { stopAll(); releaseWakeLock(); };
  }, []);

  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState === 'visible' && capturing && !wakeLockRef.current) {
        await acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [capturing]);

  // ── wake lock ─────────────────────────────────────────────────────────────
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      wakeLockRef.current.addEventListener('release', () => setWakeLockOn(false));
      setWakeLockOn(true);
    } catch { }
  }
  function releaseWakeLock() {
    wakeLockRef.current?.release().catch(() => { });
    wakeLockRef.current = null;
    setWakeLockOn(false);
  }

  // ── camera ────────────────────────────────────────────────────────────────
  async function startCam() {
    const tries = [
      { video: { facingMode: { exact: 'environment' } }, audio: true },
      { video: { facingMode: 'environment' }, audio: true },
      { video: true, audio: true },
      { video: { facingMode: { exact: 'environment' } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false },
    ];
    for (const c of tries) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        streamRef.current = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          await new Promise(resolve => {
            const vid = videoRef.current;
            if (vid.readyState >= 1) { resolve(); return; }
            vid.addEventListener('loadedmetadata', resolve, { once: true });
          });
        }
        readDimensions();
        setCamActive(true);
        return;
      } catch { }
    }
    toast$('Camera access denied', 'error');
  }

  function readDimensions() {
    const vid = videoRef.current;
    if (!vid) return;
    const w = vid.videoWidth || FALLBACK_W;
    const h = vid.videoHeight || FALLBACK_H;
    vidWRef.current = w;
    vidHRef.current = h;
    setVideoDims({ w, h });
  }

  // ── start capture ─────────────────────────────────────────────────────────
  async function startCapture() {
    if (!streamRef.current || !camActive) return;
    if (!boundariesSet) {
      toast$('Set Start & End positions in Motion Setup first', 'error');
      return;
    }

    readDimensions();
    rawChunksRef.current = [];
    durRef.current = 0;
    setDuration(0);

    if (esp32IP) {
      try {
        await sendStartCommand({ startPosition, endPosition, delay: delayMs, pauseDuration, preset: presetName });
      } catch (e) { console.warn('ESP32 start failed:', e); }
    }

    await acquireWakeLock();

    const mime = [
      'video/mp4;codecs=h264',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    const mr = new MediaRecorder(streamRef.current, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    mr.ondataavailable = e => { if (e.data?.size) rawChunksRef.current.push(e.data); };
    mr.start(500);
    mediaRecorderRef.current = mr;

    setCapturing(true);
    timerRef.current = setInterval(() => {
      durRef.current += 1;
      setDuration(d => d + 1);
    }, 1000);
  }

  // ── stop capture ──────────────────────────────────────────────────────────
  async function stopCapture() {
    clearInterval(timerRef.current);
    timerRef.current = null;
    const recordedDuration = durRef.current;

    await new Promise(resolve => {
      const mr = mediaRecorderRef.current;
      if (!mr) { resolve(); return; }
      mr.onstop = resolve;
      mr.stop();
    });
    mediaRecorderRef.current = null;

    if (esp32IP) { try { await sendStopCommand(); } catch { } }
    releaseWakeLock();
    setCapturing(false);

    if (rawChunksRef.current.length === 0) {
      toast$('No video data captured', 'error');
      return;
    }

    const tlMultiplier = getTimelapseMultiplier(recordedDuration);
    toast$(`${recordedDuration}s recorded — encoding ${tlMultiplier}× timelapse…`, 'info');
    await encodeTimelapse(recordedDuration, tlMultiplier);
  }

  // ── ffmpeg encode ─────────────────────────────────────────────────────────
  async function encodeTimelapse(recordedDuration, tlMultiplier) {
    setProcessing(true);
    setProgress(0);
    setStatusMsg('Loading ffmpeg…');

    const rawMime = rawChunksRef.current[0]?.type || 'video/webm';
    const rawBlob = new Blob(rawChunksRef.current, { type: rawMime });
    rawChunksRef.current = [];

    try {
      const { ff, fetchFile: fetchFileUtil } = await getFFmpeg(msg => console.debug('[ffmpeg]', msg));
      setProgress(10);
      setStatusMsg('Preparing video…');

      const inputExt = rawMime.includes('mp4') ? 'mp4' : 'webm';
      const inputName = `input.${inputExt}`;

      const onProgress = ({ progress: p }) => {
        if (p >= 0 && p <= 1) {
          setProgress(Math.round(15 + p * 80));
          setStatusMsg(`Encoding ${tlMultiplier}× timelapse… ${Math.round(p * 100)}%`);
        }
      };
      ff.on('progress', onProgress);

      await ff.writeFile(inputName, await fetchFileUtil(rawBlob));
      setProgress(15);

      const W = vidWRef.current % 2 === 0 ? vidWRef.current : vidWRef.current - 1;
      const H = vidHRef.current % 2 === 0 ? vidHRef.current : vidHRef.current - 1;

      const vf = `setpts=PTS/${tlMultiplier},scale=${W}:${H}`;
      const hasAudio = streamRef.current?.getAudioTracks().length > 0;
      const atempoChain = buildAtempoChain(tlMultiplier);

      let encoded = false;

      // Try encoding with audio first
      if (hasAudio && atempoChain) {
        try {
          await ff.exec([
            '-i', inputName,
            '-vf', vf,
            '-af', atempoChain,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            'output.mp4',
          ]);
          encoded = true;
        } catch {
          try { await ff.deleteFile('output.mp4'); } catch { }
        }
      }

      // Fallback: encode without audio
      if (!encoded) {
        await ff.exec([
          '-i', inputName,
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-an',
          'output.mp4',
        ]);
      }

      ff.off('progress', onProgress);
      setProgress(96);
      setStatusMsg('Saving…');

      const data = await ff.readFile('output.mp4');
      const outBlob = new Blob([data], { type: 'video/mp4' });

      try { await ff.deleteFile(inputName); } catch { }
      try { await ff.deleteFile('output.mp4'); } catch { }

      const outputDuration = Math.max(1, Math.round(recordedDuration / tlMultiplier));

      await saveRecording(outBlob, {
        name: `Timelapse ${new Date().toLocaleString()}`,
        duration: outputDuration,
        speedMode: `${tlMultiplier}×`,
        width: W,
        height: H,
        mimeType: 'video/mp4',
        ext: 'mp4',
        size: outBlob.size,
      });

      setProgress(100);
      toast$(`✅ Saved! ${recordedDuration}s → ${outputDuration}s timelapse (${tlMultiplier}×)`, 'success');

    } catch (err) {
      console.error('ffmpeg encode failed:', err);
      try {
        await saveRecording(rawBlob, {
          name: `Raw Recording ${new Date().toLocaleString()} (encode failed)`,
          duration: recordedDuration,
          speedMode: `${tlMultiplier}× (raw)`,
          width: vidWRef.current,
          height: vidHRef.current,
          mimeType: rawMime,
          ext: rawMime.includes('mp4') ? 'mp4' : 'webm',
          size: rawBlob.size,
        });
        toast$(`Encode failed — raw footage saved.\n${err.message}`, 'error');
      } catch {
        toast$(`Encoding failed: ${err.message}`, 'error');
      }
    } finally {
      setProcessing(false);
      setProgress(0);
      setStatusMsg('');
    }
  }

  // ── teardown ──────────────────────────────────────────────────────────────
  function stopAll() {
    clearInterval(timerRef.current);
    timerRef.current = null;
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch { }
      mediaRecorderRef.current = null;
    }
    rawChunksRef.current = [];
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setCamActive(false);
    setCapturing(false);
  }

  // ── render ────────────────────────────────────────────────────────────────
  const isPortrait = videoDims.h > videoDims.w;
  const liveMultiplier = getTimelapseMultiplier(duration || 1);
  const estOutputSec = duration > 0 ? Math.max(1, Math.round(duration / liveMultiplier)) : null;

  return (
    <div className="min-h-screen bg-transparent px-5 pt-12 pb-10">
      <BackButton onClick={() => { stopAll(); setPage('manual-control'); }} />
      <PageHeader title="Cine Capture" subtitle="Frame-by-frame timelapse" />

      <div className="mb-4 flex justify-between items-center gap-2 flex-wrap">

        {wakeLockOn && (
          <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-blue-500/20 text-blue-400">
            🔆 Screen awake
          </span>
        )}
      </div>

      {/* Viewfinder */}
      <div
        className="relative rounded-3xl overflow-hidden bg-black/30 backdrop-blur-md mb-5"
        style={{ aspectRatio: `${videoDims.w} / ${videoDims.h}`, maxHeight: '60vh', width: '100%' }}
      >
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ display: 'block' }} />

        {capturing && (
          <div className="absolute top-4 left-4 flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-white text-xs font-mono bg-black/70 px-2 py-1 rounded-full">
              REC · {fmt(duration)}{estOutputSec ? ` → ~${fmt(estOutputSec)} @ ${liveMultiplier}×` : ''}
            </span>
          </div>
        )}

        {camActive && (
          <div className="absolute top-4 right-4">
            <span className="text-white/50 text-[10px] font-mono bg-black/50 px-2 py-1 rounded-full">
              {videoDims.w}×{videoDims.h} {isPortrait ? '↕' : '↔'}
            </span>
          </div>
        )}

        {processing && (
          <div className="absolute inset-0 bg-black/50 backdrop-blur-md flex flex-col items-center justify-center gap-3 px-6">
            <Spinner />
            <p className="text-white text-sm font-semibold text-center">{statusMsg}</p>
            <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
              <div className="h-2 rounded-full bg-green-500 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-white/50 text-xs">{progress}%</p>
          </div>
        )}
      </div>

      {!boundariesSet && (
        <div className="mb-3 px-4 py-3 rounded-2xl glass-yellow flex items-center gap-3">
          <span className="text-amber-400 text-base flex-shrink-0">⚠️</span>
          <div>
            <p className="text-amber-400 text-xs font-semibold">Motion boundaries not set</p>
            <p className="text-white/35 text-[11px] mt-0.5">Go to Motion Setup and set Start & End positions before recording.</p>
          </div>
        </div>
      )}

      <Card className="mb-4">
        {presetName && (
          <div className="mb-3 pb-3 border-b border-white/5 flex items-center justify-between">
            <span className="text-white/30 text-[11px]">Preset</span>
            <span className="text-white/60 text-[11px] font-medium">{presetName}</span>
          </div>
        )}

        <div className="grid grid-cols-3 text-center">
          <div>
            <div className={`text-base font-semibold ${boundariesSet ? 'text-blue-400' : 'text-white/25'}`}>
              {startPosition !== null ? startPosition : '—'}
            </div>
            <div className="text-white/40 text-xs mt-0.5">Start</div>
          </div>
          <div>
            <div className={`text-base font-semibold ${boundariesSet ? 'text-green-400' : 'text-white/25'}`}>
              {endPosition !== null ? endPosition : '—'}
            </div>
            <div className="text-white/40 text-xs mt-0.5">End</div>
          </div>
          <div>
            <div className="text-accent text-base font-semibold">{liveMultiplier}×</div>
            <div className="text-white/40 text-xs mt-0.5">TL Speed</div>
          </div>
        </div>

        {boundariesSet && (
          <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
            <span className="text-white/30 text-[11px]">Range</span>
            <span className="text-white/50 text-[11px] font-mono">
              {startPosition} → {endPosition} ({rangeSteps > 0 ? '+' : ''}{rangeSteps} steps)
            </span>
          </div>
        )}



        {duration > 0 && !processing && (
          <div className="mt-2 text-center">
            <span className="text-white/60 text-xs">
              {fmt(duration)} recorded →{' '}
              <span className="text-accent">~{fmt(estOutputSec ?? 0)} timelapse</span>
            </span>
          </div>
        )}
      </Card>

      {!capturing ? (
        <button
          onClick={startCapture}
          disabled={!camActive || processing || !boundariesSet}
          className="w-full py-5 rounded-3xl glass-purple text-purple-400 font-bold text-lg disabled:opacity-40 active:scale-95 transition-transform"
        >
          ⏺ Start Time Lapse
        </button>
      ) : (
        <button
          onClick={stopCapture}
          disabled={processing}
          className="w-full py-5 rounded-3xl glass-green text-green-400 font-bold text-lg active:scale-95 transition-transform"
        >
          ⏹ Stop Time Lapse
        </button>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
}