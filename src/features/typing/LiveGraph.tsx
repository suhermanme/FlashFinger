import { useEffect, useRef } from 'react';
import type { RollingSample } from '../../domain/metrics/rolling.js';
export function LiveGraph({ samples }: { samples: readonly RollingSample[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const canvas = ref.current; if (!canvas) return; const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = 'currentColor'; ctx.beginPath(); samples.slice(-60).forEach((sample, i) => { const x = samples.length > 1 ? i * canvas.width / (Math.min(60, samples.length) - 1) : 0; const y = canvas.height - Math.min(100, sample.wpm ?? 0) * canvas.height / 100; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }, [samples]);
  return <figure className="ff-live-graph"><canvas ref={ref} width={480} height={160} role="img" aria-label="Live words per minute graph" /><figcaption>Live speed</figcaption><ol className="ff-sr-live">{samples.slice(-10).map((sample) => <li key={sample.atMs}>{sample.wpm ?? 'No speed'} WPM</li>)}</ol></figure>;
}
