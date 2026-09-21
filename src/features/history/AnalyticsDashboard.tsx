import type { SessionRecord } from '../../contracts/models.js';
import type { HistoricalBar } from '../../domain/metrics/aggregates.js';
import { calculateMetrics } from '../../domain/metrics/formulas.js';

function durationLabel(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function AnalyticsDashboard({ sessions, bars, loading = false, error = null, hasProfile = true }: { sessions: readonly SessionRecord[]; bars: readonly HistoricalBar[]; loading?: boolean; error?: string | null; hasProfile?: boolean }) {
  const totals = sessions.reduce((value, session) => ({
    activeMs: value.activeMs + session.activeMs,
    attempts: value.attempts + session.attempts,
    correctAttempts: value.correctAttempts + session.correctAttempts,
    errorAttempts: value.errorAttempts + session.errorAttempts,
    backspaces: value.backspaces + session.backspaces,
    retainedCorrect: value.retainedCorrect + session.retainedCorrect,
    retainedErrors: value.retainedErrors + session.retainedErrors,
    completedWords: value.completedWords + session.completedWords,
  }), { activeMs: 0, attempts: 0, correctAttempts: 0, errorAttempts: 0, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
  const metrics = calculateMetrics(totals);
  const bestWpm = Math.max(0, ...sessions.map((session) => session.adjustedWpm ?? 0));
  const chartMax = Math.max(1, ...bars.map((bar) => bar.adjustedWpm ?? 0));
  return <section className="ff-dashboard ff-view-enter" aria-labelledby="analytics-heading">
    <div className="ff-page-heading"><span className="ff-eyebrow">Performance</span><h2 id="analytics-heading">Analytics</h2><p>Your saved sessions, summarized into speed, accuracy, and consistency.</p></div>
    {!hasProfile ? <div className="ff-empty-state"><strong>Select a profile to track progress.</strong><span>Sessions only become history when they belong to a local profile.</span></div> : loading ? <p role="status">Loading analytics…</p> : error ? <p className="ff-file-error" role="alert">{error}</p> : sessions.length === 0 ? <div className="ff-empty-state"><strong>No completed sessions yet.</strong><span>Finish a practice or lesson and your trends will appear here.</span></div> : <>
      <div className="ff-stat-grid"><article><small>AVERAGE WPM</small><strong>{metrics.adjustedWpm?.toFixed(1) ?? '—'}</strong></article><article><small>ACCURACY</small><strong>{metrics.accuracy?.toFixed(1) ?? '—'}%</strong></article><article><small>ACTIVE TIME</small><strong>{durationLabel(totals.activeMs)}</strong></article><article><small>BEST WPM</small><strong>{bestWpm.toFixed(1)}</strong></article></div>
      <section className="ff-trend-card" aria-labelledby="speed-trend-heading"><div><h3 id="speed-trend-heading">Speed trend</h3><span>Daily adjusted WPM</span></div><div className="ff-trend-chart">{bars.map((bar) => <div key={bar.day} className="ff-trend-column"><span style={{ height: `${Math.max(4, 100 * (bar.adjustedWpm ?? 0) / chartMax)}%` }} title={`${bar.day}: ${bar.adjustedWpm?.toFixed(1) ?? '—'} WPM`} /><small>{bar.day.slice(5)}</small></div>)}</div></section>
    </>}
  </section>;
}
