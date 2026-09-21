import { useState } from 'react';
import type { PreparedPractice } from '../../domain/training/practice.js';
export function PracticeSession({ prepared, onExit }: { prepared: PreparedPractice; onExit: () => void }) {
  const [value, setValue] = useState('');
  const text = Array.from({ length: Math.ceil((prepared.source.graphemeCount ?? 0) / prepared.source.chunkSize) }, (_, index) => prepared.source.chunkAt(index) ?? '').join('');
  const done = value.length >= text.length;
  const accuracy = value.length ? Math.round(100 * [...value].filter((char, index) => char === [...text][index]).length / value.length) : 100;
  return <section className="ff-practice-workspace" aria-labelledby="practice-session-heading">
    <header className="ff-practice-toolbar"><div><span className="ff-eyebrow">Practice</span><h2 id="practice-session-heading">{prepared.source.title}</h2></div><nav aria-label="Practice mode"><button className="ff-mode-active">Test</button><button>Lessons</button><button>History</button></nav><button className="ff-button" type="button" onClick={onExit}>Exit</button></header>
    <div className="ff-live-stats"><div><small>TIME</small><strong>{prepared.sessionConfig.durationLimitMs ? `${prepared.sessionConfig.durationLimitMs / 1000}s` : '∞'}</strong></div><div><small>WPM</small><strong>—</strong></div><div><small>ACCURACY</small><strong>{accuracy}%</strong></div><div><small>PROGRESS</small><strong>{Math.min(100, Math.round(100 * value.length / Math.max(1, text.length)))}%</strong></div></div>
    <p className="ff-practice-target" aria-label="Practice text">{text}</p>
    <textarea autoFocus className="ff-practice-input" value={value} onChange={(event) => setValue(event.target.value)} aria-label="Type the practice text" disabled={done} placeholder="Click here and start typing…" />
    <div className="ff-keyboard" aria-label="Keyboard preview">{['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map((row) => <div key={row}>{[...row].map((key) => <span key={key} className={value.endsWith(key) ? 'ff-key ff-key-active' : 'ff-key'}>{key}</span>)}</div>)}</div>
    <p className="ff-session-status" role="status">{done ? 'Complete — great work.' : 'Start typing to begin'}</p>
  </section>;
}
