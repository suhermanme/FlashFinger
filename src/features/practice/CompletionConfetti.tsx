import { useEffect, useState, type CSSProperties } from 'react';

export function CompletionConfetti({ completedAt }: { completedAt: number | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (completedAt === null || reducedMotion) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 3_200);
    return () => window.clearTimeout(timer);
  }, [completedAt]);

  if (!visible || completedAt === null) return null;
  const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#a78bfa', '#06b6d4'];
  return <div key={completedAt} className="ff-confetti" aria-hidden="true">
    {Array.from({ length: 60 }, (_, index) => <span
      key={index}
      className="ff-confetti-piece"
      style={{
        left: `${(index * 37) % 100}%`,
        backgroundColor: colors[index % colors.length],
        width: `${6 + index % 5}px`,
        height: `${8 + index % 7}px`,
        borderRadius: index % 3 === 0 ? '50%' : '2px',
        animationDelay: `${(index % 10) * 45}ms`,
        animationDuration: `${2_100 + (index % 7) * 90}ms`,
        '--ff-confetti-drift': `${(index % 2 ? 1 : -1) * (30 + index % 90)}px`,
        '--ff-confetti-spin': `${(index % 2 ? 1 : -1) * (360 + index * 13)}deg`,
      } as CSSProperties}
    />)}
  </div>;
}
