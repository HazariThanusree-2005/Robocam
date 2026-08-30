import { useEffect } from 'react';

// ─── Back Button ────────────────────────────────────
export function BackButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 text-white/60 hover:text-white transition-colors duration-150 mb-6 group"
    >
      <span className="w-8 h-8 rounded-xl glass flex items-center justify-center group-hover:border-white/20 transition-all duration-150">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </span>
      <span className="text-sm font-medium">Back</span>
    </button>
  );
}

// ─── Page Header ─────────────────────────────────────
export function PageHeader({ title, subtitle, icon }) {
  return (
    <div className="mb-8">
      {icon && (
        <div className="w-12 h-12 rounded-2xl glass flex items-center justify-center mb-4 border border-white/10">
          <span className="text-2xl">{icon}</span>
        </div>
      )}
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {subtitle && <p className="text-white/50 text-sm mt-1">{subtitle}</p>}
    </div>
  );
}

// ─── Primary Button ───────────────────────────────────
export function PrimaryButton({ onClick, children, disabled, className = '', danger = false, variant }) {
  let base = danger
    ? 'glass-red text-red-400'
    : 'glass-blue text-accent';

  if (variant === 'green') {
    base = 'glass-green text-green-400';
  } else if (variant === 'yellow') {
    base = 'glass-yellow text-amber-400';
  } else if (variant === 'blue') {
    base = 'glass-blue text-accent';
  } else if (variant === 'red') {
    base = 'glass-red text-red-400';
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-3.5 rounded-2xl font-semibold text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 hover:brightness-110 ${base} ${className}`}
    >
      {children}
    </button>
  );
}

// ─── Secondary Button ─────────────────────────────────
export function SecondaryButton({ onClick, children, disabled, className = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-3.5 rounded-2xl glass text-white/70 hover:text-white hover:brightness-110 font-semibold text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 ${className}`}
    >
      {children}
    </button>
  );
}

// ─── Card ─────────────────────────────────────────────
export function Card({ children, className = '', onClick }) {
  return (
    <div
      onClick={onClick}
      className={`glass rounded-3xl p-5 border border-white/8 ${onClick ? 'cursor-pointer card-hover' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

// ─── Label + Value Row ────────────────────────────────
export function SettingRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-white/60 text-sm">{label}</span>
      {children}
    </div>
  );
}

// ─── Slider ───────────────────────────────────────────
export function Slider({ label, value, min, max, step = 1, onChange, unit = '' }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-sm text-white/60">{label}</span>
        <span className="font-mono text-sm text-accent font-medium">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
      <div className="flex justify-between text-xs text-white/30 font-mono">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────
export function Modal({ open, onClose, title, children }) {
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={onClose} />
      <div className="relative glass-panel rounded-t-3xl sm:rounded-3xl p-6 w-full max-w-md mx-0 sm:mx-4 animate-slide-up">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-xl glass flex items-center justify-center text-white/60 hover:text-white">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Status Badge ─────────────────────────────────────
export function StatusBadge({ connected }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-full border ${connected ? 'text-green-400 border-green-500/30 bg-green-500/10' : 'text-red-400 border-red-500/30 bg-red-500/10'}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
      {connected ? 'Connected' : 'Offline'}
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────
export function Spinner({ size = 24, className = '' }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.2" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

// ─── Toast ────────────────────────────────────────────
export function Toast({ message, type = 'info', onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const styles = {
    info: 'border-accent/30 bg-accent/10 text-accent',
    success: 'border-green-500/30 bg-green-500/10 text-green-400',
    error: 'border-red-500/80 bg-red-500/20 text-red-400 font-bold shadow-[0_0_20px_rgba(239,68,68,0.2)]',
  };

  return (
    <div className={`fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] px-6 py-3.5 rounded-full border backdrop-blur-xl shadow-2xl text-sm animate-fade-in w-max max-w-[90vw] text-center ${styles[type]}`}>
      {message}
    </div>
  );
}
