/**
 * Futuristic Robotic Camera Mascot — pure SVG + CSS animations.
 * 
 * Props:
 *   size: 'intro' | 'header' (default: 'header')
 *   className: additional CSS classes
 * 
 * Uses unique gradient IDs (prefixed 'rm-') to avoid SVG ID collisions
 * when multiple instances are rendered on the same page.
 */
export default function RobotMascot({ size = 'header', className = '' }) {
  const isIntro = size === 'intro';

  const sizeClasses = isIntro
    ? 'w-20 h-20 sm:w-24 sm:h-24'
    : 'w-10 h-10 sm:w-12 sm:h-12';

  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      {/* Ambient glow behind robot */}
      <div
        className="absolute inset-[-30%] rounded-full pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(6,182,212,0.25) 0%, transparent 70%)',
          animation: 'robot-ambient-pulse 3s ease-in-out infinite alternate',
          willChange: 'opacity',
        }}
      />

      {/* Robot container with float animation */}
      <div className={`relative ${sizeClasses} robot-float will-change-transform`}>
        <svg viewBox="0 0 100 100" className="w-full h-full" style={{ overflow: 'visible' }}>
          <defs>
            {/* Body gradient — translucent glassmorphic */}
            <linearGradient id="rm-bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
              <stop offset="50%" stopColor="rgba(6,182,212,0.06)" />
              <stop offset="100%" stopColor="rgba(168,85,247,0.04)" />
            </linearGradient>

            {/* Outer lens ring — neon gradient */}
            <linearGradient id="rm-lensRing" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#06b6d4" />
              <stop offset="40%" stopColor="#8b5cf6" />
              <stop offset="100%" stopColor="#ec4899" />
            </linearGradient>

            {/* Inner lens — radial depth */}
            <radialGradient id="rm-lensInner" cx="50%" cy="45%" r="50%">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="1" />
              <stop offset="40%" stopColor="#3b82f6" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#0f172a" stopOpacity="0.95" />
            </radialGradient>

            {/* Antenna glow */}
            <radialGradient id="rm-antennaGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </radialGradient>

            {/* Neon glow filter */}
            <filter id="rm-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2.5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Soft outer glow for the body */}
            <filter id="rm-softGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* === BODY === */}
          {/* Main housing — rounded rectangle with glassmorphic fill */}
          <rect
            x="24" y="22" width="52" height="56" rx="14"
            fill="url(#rm-bodyGrad)"
            stroke="rgba(6,182,212,0.35)"
            strokeWidth="1.2"
          />
          {/* Inner accent border */}
          <rect
            x="29" y="27" width="42" height="46" rx="10"
            fill="none"
            stroke="rgba(168,85,247,0.2)"
            strokeWidth="0.6"
          />
          {/* Horizontal scan line accents */}
          <line x1="32" y1="62" x2="68" y2="62" stroke="rgba(6,182,212,0.15)" strokeWidth="0.5" />
          <line x1="32" y1="66" x2="68" y2="66" stroke="rgba(168,85,247,0.1)" strokeWidth="0.5" />

          {/* === ANTENNA === */}
          <line x1="50" y1="22" x2="50" y2="10" stroke="rgba(6,182,212,0.5)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="50" cy="8" r="3" fill="url(#rm-antennaGlow)" filter="url(#rm-glow)" className="robot-blink" />

          {/* === HEAD GROUP (animated look-around) === */}
          <g className="robot-head" style={{ transformOrigin: '50px 44px' }}>

            {/* Outer lens ring */}
            <circle
              cx="50" cy="44" r="17"
              fill="#0a0f1a"
              stroke="url(#rm-lensRing)"
              strokeWidth="2.5"
              filter="url(#rm-glow)"
            />

            {/* Inner lens (rotates) */}
            <g className="robot-lens-spin" style={{ transformOrigin: '50px 44px' }}>
              <circle cx="50" cy="44" r="13" fill="url(#rm-lensInner)" />
              {/* Aperture ring */}
              <circle
                cx="50" cy="44" r="9.5"
                fill="none"
                stroke="rgba(255,255,255,0.15)"
                strokeWidth="0.8"
                strokeDasharray="3.5 3.5"
              />
              {/* Cross-hair marks */}
              <path
                d="M50 31 L50 34 M50 54 L50 57 M37 44 L40 44 M60 44 L63 44"
                stroke="#22d3ee"
                strokeWidth="1.2"
                opacity="0.7"
              />
            </g>

            {/* Central iris — pulsing */}
            <circle
              cx="50" cy="44" r="4.5"
              fill="white"
              filter="url(#rm-glow)"
              className="robot-iris-pulse"
            />

            {/* Sensor lights */}
            <circle cx="34" cy="30" r="2" fill="#ef4444" filter="url(#rm-glow)" className="robot-blink" />
            <circle cx="66" cy="30" r="2" fill="#22c55e" filter="url(#rm-glow)" opacity="0.85" />
          </g>

          {/* === SIDE ARMS / MOUNTS === */}
          <line x1="24" y1="44" x2="14" y2="44" stroke="url(#rm-lensRing)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
          <line x1="76" y1="44" x2="86" y2="44" stroke="url(#rm-lensRing)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />

          {/* Small mount dots */}
          <circle cx="12" cy="44" r="2" fill="rgba(6,182,212,0.4)" />
          <circle cx="88" cy="44" r="2" fill="rgba(168,85,247,0.4)" />

          {/* === BASE / TRIPOD MOUNT === */}
          <path
            d="M38 78 L62 78 L58 88 L42 88 Z"
            fill="rgba(255,255,255,0.06)"
            stroke="rgba(6,182,212,0.35)"
            strokeWidth="1"
          />
          {/* Base connection */}
          <line x1="45" y1="78" x2="45" y2="73" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <line x1="55" y1="78" x2="55" y2="73" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
