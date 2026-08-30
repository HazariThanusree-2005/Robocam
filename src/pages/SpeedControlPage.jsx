import { useApp } from '../context/AppContext';
import { BackButton, PageHeader } from '../components/UI';

export default function SpeedControlPage() {
  const { setPage, motion, updateMotion } = useApp();

  // Use packetAngle from context (default 50°)
  const packetAngle = motion.packetAngle ?? 50;

  const handleSliderChange = (e) => {
    const newAngle = Number(e.target.value);
    updateMotion({ packetAngle: newAngle });
  };

  const sliderPercent = ((packetAngle - 10) / 90) * 100; // min=10°, max=100°

  return (
    <div className="min-h-screen bg-transparent px-5 pt-12 pb-10 animate-fade-in">
      <BackButton onClick={() => setPage('home')} />
      <PageHeader
        title="Speed Control"
        subtitle="Adjust movement smoothness (packet angle)"
        icon="⚡"
      />

      <div className="relative rounded-3xl overflow-hidden mb-5 glass-yellow">
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 1,
          background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%)',
        }} />
        <div className="p-5">
          <div className="flex items-start justify-between mb-6">
            <div>
              <p className="text-white/40 text-xs font-mono uppercase tracking-widest mb-1">Packet Angle</p>
              <p className="text-white/60 text-sm">
                {packetAngle === 10 ? 'Silky smooth' : packetAngle === 100 ? 'Fast' : 'Balanced'}
              </p>
            </div>
            <div style={{
              background: 'rgba(91,140,255,0.12)',
              border: '1px solid rgba(91,140,255,0.25)',
              borderRadius: 14,
              padding: '6px 14px',
            }}>
              <span style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#5B8CFF', lineHeight: 1 }}>
                {packetAngle}
              </span>
              <span style={{ fontSize: 12, color: 'rgba(91,140,255,0.6)', marginLeft: 4 }}>°</span>
            </div>
          </div>

          <div className="relative" style={{ paddingBottom: 4 }}>
            <div className="relative" style={{ height: 44, display: 'flex', alignItems: 'center' }}>
              <div style={{ position: 'absolute', left: 0, right: 0, height: 6, borderRadius: 99, background: 'rgba(255,255,255,0.08)' }} />
              <div style={{ position: 'absolute', left: 0, width: `${sliderPercent}%`, height: 6, borderRadius: 99, background: 'linear-gradient(90deg, #22d3ee 0%, #60a5fa 50%, #f472b6 100%)', transition: 'width 120ms ease-out' }} />
              <div style={{ position: 'absolute', left: `calc(${sliderPercent}% - 14px)`, width: 28, height: 28, borderRadius: '50%', background: 'rgba(91,140,255,0.22)', filter: 'blur(8px)', transition: 'left 120ms ease-out', pointerEvents: 'none' }} />
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={packetAngle}
                onChange={handleSliderChange}
                className="speed-slider"
                style={{ position: 'absolute', width: '100%', zIndex: 10 }}
              />
            </div>
            <div className="flex justify-between mt-1">
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>⚡ Fast (100°)</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>🐢 Smooth (10°)</span>
            </div>
          </div>

          <div className="flex justify-between mt-3 px-1">
            {Array.from({ length: 20 }).map((_, i) => {
              const tickValue = 10 + i * (90 / 19);
              const active = tickValue <= packetAngle;
              return (
                <div
                  key={i}
                  style={{
                    width: 1.5,
                    height: i % 4 === 0 ? 8 : 4,
                    borderRadius: 1,
                    background: active ? 'rgba(91,140,255,0.5)' : 'rgba(255,255,255,0.1)',
                    transition: 'background 120ms ease-out',
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="glass" style={{
        padding: '14px 16px',
        borderRadius: 18,
      }}>
        <p className="text-white/40 text-xs font-mono uppercase tracking-widest mb-2">How it works</p>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', lineHeight: 1.7, margin: 0 }}>
          • Each jog press moves the motor by <strong>50°</strong> (5 UI steps).<br />
          • The <strong>total movement</strong> (e.g., from Start to End) is split into packets.<br />
          • Lower angle = smoother motion (many packets). Higher angle = faster motion (few packets).<br />
          • The total distance never changes – only the packet size.
        </p>
      </div>

      <style jsx>{`
        .speed-slider {
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          height: 44px;
          cursor: pointer;
          margin: 0;
        }
        .speed-slider::-webkit-slider-runnable-track {
          height: 6px;
          background: transparent;
          border-radius: 99px;
        }
        .speed-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: #ffffff;
          border: 2.5px solid #5B8CFF;
          margin-top: -10px;
          box-shadow: 0 0 0 4px rgba(91,140,255,0.18), 0 2px 8px rgba(0,0,0,0.4);
          transition: transform 150ms ease, box-shadow 150ms ease;
        }
        .speed-slider:active::-webkit-slider-thumb {
          transform: scale(1.15);
          box-shadow: 0 0 0 6px rgba(91,140,255,0.28), 0 2px 12px rgba(0,0,0,0.5);
        }
        .speed-slider::-moz-range-track {
          height: 6px;
          background: transparent;
          border-radius: 99px;
        }
        .speed-slider::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #ffffff;
          border: 2.5px solid #5B8CFF;
          box-shadow: 0 0 0 4px rgba(91,140,255,0.18), 0 2px 8px rgba(0,0,0,0.4);
          cursor: grab;
          transition: transform 150ms ease;
        }
        .speed-slider:active::-moz-range-thumb {
          transform: scale(1.15);
          cursor: grabbing;
        }
      `}</style>
    </div>
  );
}