import { useState } from 'react';
import type { SessionRecord } from '../../contracts/models.js';
import type { HistoricalBar } from '../../domain/metrics/aggregates.js';
import { calculateMetrics } from '../../domain/metrics/formulas.js';
import type { CharacterStatTotals } from '../../contracts/repository.js';
import { Button } from '../../components/Button.js';
import { Dialog } from '../../components/Dialog.js';

function durationLabel(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)}s`;
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function AnalyticsDashboard({ sessions, bars, characterStats = null, loading = false, error = null, hasProfile = true, onResetCharacterStats }: { sessions: readonly SessionRecord[]; bars: readonly HistoricalBar[]; characterStats?: CharacterStatTotals | null; loading?: boolean; error?: string | null; hasProfile?: boolean; onResetCharacterStats?(): Promise<boolean> }) {
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
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
  const offenders = [...(characterStats?.mistakes ?? [])].reduce((map, item) => map.set(item.expected, (map.get(item.expected) ?? 0) + item.count), new Map<string, number>());
  const topOffenders = [...offenders.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
  const totalCharacterMistakes = [...offenders.values()].reduce((total, count) => total + count, 0);
  const resetCharacterStats = async () => {
    if (!onResetCharacterStats || resetting) return;
    setResetting(true); setResetError(null);
    try {
      if (await onResetCharacterStats()) setResetOpen(false);
      else setResetError('Character statistics could not be reset.');
    } catch {
      setResetError('Character statistics could not be reset.');
    } finally {
      setResetting(false);
    }
  };
  return <section className="ff-dashboard ff-view-enter" aria-labelledby="analytics-heading">
    <div className="ff-page-heading"><span className="ff-eyebrow">Performance</span><h2 id="analytics-heading">Analytics</h2><p>Your saved sessions, summarized into speed, accuracy, and consistency.</p></div>
    {!hasProfile ? <div className="ff-empty-state"><strong>Select a profile to track progress.</strong><span>Sessions only become history when they belong to a local profile.</span></div> : loading ? <p role="status">Loading analytics…</p> : error ? <p className="ff-file-error" role="alert">{error}</p> : sessions.length === 0 ? <div className="ff-empty-state"><strong>No completed sessions yet.</strong><span>Finish a practice or lesson and your trends will appear here.</span></div> : <>
      <div className="ff-stat-grid"><article><small>AVERAGE WPM</small><strong>{metrics.adjustedWpm?.toFixed(1) ?? '—'}</strong></article><article><small>ACCURACY</small><strong>{metrics.accuracy?.toFixed(1) ?? '—'}%</strong></article><article><small>ACTIVE TIME</small><strong>{durationLabel(totals.activeMs)}</strong></article><article><small>BEST WPM</small><strong>{bestWpm.toFixed(1)}</strong></article></div>
      <section className="ff-trend-card" aria-labelledby="speed-trend-heading"><div><h3 id="speed-trend-heading">Speed trend</h3><span>Daily adjusted WPM</span></div><div className="ff-trend-chart">{bars.map((bar) => <div key={bar.day} className="ff-trend-column"><span style={{ height: `${Math.max(4, 100 * (bar.adjustedWpm ?? 0) / chartMax)}%` }} title={`${bar.day}: ${bar.adjustedWpm?.toFixed(1) ?? '—'} WPM`} /><small>{bar.day.slice(5)}</small></div>)}</div></section>
      <section className="ff-trend-card ff-mistake-analytics" aria-labelledby="mistake-trend-heading">
        <div className="ff-mistake-heading"><div><span className="ff-mistake-kicker">Accuracy focus</span><h3 id="mistake-trend-heading">Characters to review</h3><p>Your most frequently missed characters across all sessions.</p></div>{topOffenders.length > 0 ? <div className="ff-mistake-heading-actions"><span className="ff-mistake-total"><strong>{totalCharacterMistakes}</strong> total</span>{onResetCharacterStats ? <Button className="ff-mistake-reset" onClick={() => { setResetError(null); setResetOpen(true); }}>Reset</Button> : null}</div> : null}</div>
        {topOffenders.length > 0 ? <ol className="ff-mistake-breakdown">{topOffenders.map(([expected, count], index) => <li key={expected}>
          <span className="ff-mistake-rank" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <kbd className="ff-mistake-character" aria-label={expected === ' ' ? 'Space' : undefined}>{expected === ' ' ? 'SPC' : expected}</kbd>
          <span className="ff-mistake-detail"><span>Expected character</span><strong>{expected === ' ' ? 'Space' : `“${expected}”`}</strong></span>
          <span className="ff-mistake-count"><strong>{count}</strong><span>{count === 1 ? 'mistake' : 'mistakes'}</span></span>
          <span className="ff-mistake-meter" aria-hidden="true"><span style={{ width: `${100 * count / topOffenders[0][1]}%` }} /></span>
        </li>)}</ol> : <p className="ff-muted">No character mistakes recorded yet.</p>}
      </section>
    </>}
    <Dialog open={resetOpen} title="Reset accuracy focus?" onClose={() => { if (!resetting) setResetOpen(false); }} actions={<Button className="ff-button-danger" disabled={resetting} onClick={() => void resetCharacterStats()}>{resetting ? 'Resetting…' : 'Reset statistics'}</Button>}>
      <p>This permanently clears the saved character mistakes and exposures for this profile. Session history and overall performance metrics will remain.</p>
      {resetError ? <p className="ff-file-error" role="alert">{resetError}</p> : null}
    </Dialog>
  </section>;
}
