export interface CalendarDay { day: string; activeMs: number; level: 0 | 1 | 2 | 3 | 4; sessions: number; }
export function calendarDays(rows: readonly { day: string; activeMs: number; sessions?: number }[], from: string, to: string): CalendarDay[] {
  const map = new Map(rows.map((row) => [row.day, row])); const out: CalendarDay[] = [];
  const cursor = new Date(`${from}T12:00:00Z`); const end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end) { const day = cursor.toISOString().slice(0, 10); const row = map.get(day); out.push({ day, activeMs: row?.activeMs ?? 0, sessions: row?.sessions ?? 0, level: row ? row.activeMs >= 60 * 60_000 ? 4 : row.activeMs >= 30 * 60_000 ? 3 : row.activeMs >= 10 * 60_000 ? 2 : 1 : 0 }); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return out;
}
export function longestStreak(days: readonly CalendarDay[]): number { let best = 0; let run = 0; for (const day of days) { run = day.activeMs > 0 ? run + 1 : 0; best = Math.max(best, run); } return best; }
