import { useMemo, useState } from 'react';
import type { SessionRecord } from '../../contracts/models.js';
import type { HistoricalBar } from '../../domain/metrics/aggregates.js';
import type { CalendarDay } from '../../domain/metrics/calendar.js';
import { calendarDayAt } from '../../domain/metrics/sessionSummary.js';

function modeLabel(mode: SessionRecord['config']['mode']): string {
  return mode === 'lessons' ? 'Lesson' : mode === 'custom' ? 'Custom text' : 'Practice';
}

function sessionContext(session: SessionRecord): string {
  if (session.config.mode === 'lessons') return session.config.sourceRef;
  if (session.config.mode === 'custom') return 'Imported text';
  if (session.config.durationLimitMs !== null) return `${Math.round(session.config.durationLimitMs / 1_000)}-second sprint`;
  if (session.config.targetLength !== null) return `${session.config.targetLength}-character target`;
  return 'Open practice';
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function completionTime(session: SessionRecord): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: session.analyticsZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(session.endedAt));
}

interface HistoryDashboardProps {
  bars: readonly HistoricalBar[];
  calendar: readonly CalendarDay[];
  sessions?: readonly SessionRecord[];
  loading?: boolean;
  error?: string | null;
  hasProfile?: boolean;
}

export function HistoryDashboard({ bars, calendar, sessions = [], loading = false, error = null, hasProfile = true }: HistoryDashboardProps) {
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const sessionsByDay = useMemo(() => {
    const grouped = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
      if (session.status !== 'completed') continue;
      const day = calendarDayAt(Date.parse(session.endedAt), session.analyticsZone);
      const rows = grouped.get(day) ?? [];
      rows.push(session);
      grouped.set(day, rows);
    }
    for (const rows of grouped.values()) rows.sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
    return grouped;
  }, [sessions]);

  return <section className="ff-history ff-view-enter" aria-labelledby="history-heading">
    <div className="ff-page-heading"><span className="ff-eyebrow">Activity</span><h2 id="history-heading">History</h2><p>Every completed session saved to this profile.</p></div>
    {!hasProfile ? <div className="ff-empty-state"><strong>Select a profile to save history.</strong><span>Create or select a local profile before starting practice.</span></div> : loading ? <p role="status">Loading history…</p> : error ? <p className="ff-file-error" role="alert">{error}</p> : bars.length === 0 ? <div className="ff-empty-state"><strong>No completed sessions yet.</strong><span>Finish a practice or lesson and it will appear here.</span></div> : <>
      <div className="ff-history-bars" aria-label="Historical performance">{[...bars].reverse().map((bar) => {
        const expanded = expandedDay === bar.day;
        const regionId = `history-sessions-${bar.day}`;
        const toggleId = `history-toggle-${bar.day}`;
        const daySessions = sessionsByDay.get(bar.day) ?? [];
        return <article key={bar.day} className={`ff-history-day${expanded ? ' ff-history-day-expanded' : ''}`}>
          <button id={toggleId} className="ff-history-day-summary" type="button" aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpandedDay(expanded ? null : bar.day)}>
            <span className="ff-history-day-copy"><strong><time dateTime={bar.day}>{bar.day}</time></strong><small>{bar.modes.map((mode) => modeLabel(mode as SessionRecord['config']['mode'])).join(' · ')}</small></span>
            <span className="ff-history-day-score">{bar.adjustedWpm == null ? '—' : `${bar.adjustedWpm.toFixed(1)} WPM`}</span>
            <span className="ff-history-day-meta">{bar.accuracy == null ? '—' : `${bar.accuracy.toFixed(1)}%`} · {bar.sessions} session{bar.sessions === 1 ? '' : 's'}</span>
            <span className="ff-history-chevron" aria-hidden="true">⌄</span>
          </button>
          {expanded ? <div id={regionId} className="ff-history-sessions" role="region" aria-labelledby={toggleId}>
            {daySessions.length > 0 ? <ol>{daySessions.map((session) => <li key={session.id}>
              <header><span className="ff-session-type" data-mode={session.config.mode}>{modeLabel(session.config.mode)}</span><span><strong>{sessionContext(session)}</strong><small>Completed {completionTime(session)}</small></span></header>
              <dl>
                <div><dt>WPM</dt><dd>{session.adjustedWpm?.toFixed(1) ?? '—'}</dd></div>
                <div><dt>Accuracy</dt><dd>{session.accuracy == null ? '—' : `${session.accuracy.toFixed(1)}%`}</dd></div>
                <div><dt>Active time</dt><dd>{durationLabel(session.activeMs)}</dd></div>
                <div><dt>Attempts</dt><dd>{session.attempts}</dd></div>
                <div><dt>Errors</dt><dd>{session.errorAttempts}</dd></div>
                <div><dt>Words</dt><dd>{session.completedWords}</dd></div>
              </dl>
            </li>)}</ol> : <p className="ff-muted">No session details are available for this day.</p>}
          </div> : null}
        </article>;
      })}</div>
      <div className="ff-calendar" aria-label="Activity calendar">{calendar.map((day) => <span key={day.day} title={`${day.day}: ${day.sessions} sessions, ${Math.round(day.activeMs / 1000)} seconds`} data-level={day.level} />)}</div>
    </>}
  </section>;
}
