/**
 * FlashFinger App — M02 shared renderer shell.
 *
 * Displays a static placeholder indicating the app is ready to
 * configure. The platform adapter determines browser vs desktop
 * target. Persistence is mocked (unavailable).
 *
 * See DESIGN_SPECIFICATION §1.3/§1.4/§3.1.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { getPlatformAdapter } from '../platform/factory.js';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge ({ ok, label }: { ok: boolean; label: string }): ReactNode {
  const color = ok ? '#22c55e' : '#f59e0b';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '12px',
        fontWeight: 600,
        color: '#fff',
        backgroundColor: color,
        marginRight: '8px',
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function App (): ReactNode {
  const [adapter, setAdapter] = useState<ReturnType<typeof getPlatformAdapter> | null>(null);

  useEffect(() => {
    setAdapter(getPlatformAdapter());
  }, []);

  if (!adapter) {
    return (
      <main style={pageStyle}>
        <h1 style={headingStyle}>FlashFinger</h1>
        <p style={mutedStyle}>Loading…</p>
      </main>
    );
  }

  const cap = adapter.capabilities;
  const isDesktop = adapter.target === 'desktop';

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={headingStyle}>FlashFinger</h1>
        <div style={badgeGroup}>
          <StatusBadge ok={true} label={cap.target} />
          <StatusBadge ok={isDesktop} label="desktop" />
          <StatusBadge ok={false} label="no-persistence" />
        </div>
      </header>

      <section style={cardStyle}>
        <h2 style={sectionHeading}>Ready to configure</h2>
        <p style={mutedStyle}>
          The shared renderer shell is loaded from{' '}
          <code style={codeStyle}>dist/renderer/</code> via{' '}
          {isDesktop
            ? 'flashfinger:// protocol'
            : 'static origin'}
          . No persistence is connected yet.
        </p>
        <ul style={listStyle}>
          <li><strong>Repository:</strong> unavailable (M04/M05)</li>
          <li><strong>Typing engine:</strong> not yet implemented (M03)</li>
          <li><strong>Audio:</strong> not yet implemented (M09)</li>
          <li><strong>PWA/Service Worker:</strong> not yet implemented (M16)</li>
        </ul>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Minimal inline styles (no CSS framework yet — M07 adds Tailwind)
// ---------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: '640px',
  margin: '2rem auto',
  padding: '0 1.5rem',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  color: 'var(--ff-text-primary, #1a1a1a)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid #e5e7eb',
  paddingBottom: '0.75rem',
  marginBottom: '1.5rem',
};

const headingStyle: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 700,
  margin: 0,
};

const badgeGroup: React.CSSProperties = {
  display: 'flex',
  gap: '6px',
};

const cardStyle: React.CSSProperties = {
  padding: '1.25rem',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
  backgroundColor: '#fafafa',
};

const sectionHeading: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: 600,
  marginTop: 0,
  marginBottom: '0.5rem',
};

const mutedStyle: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '14px',
  lineHeight: '1.6',
  marginBottom: '0.5rem',
};

const listStyle: React.CSSProperties = {
  margin: '0.5rem 0 0',
  paddingLeft: '1.25rem',
  fontSize: '14px',
  color: '#6b7280',
  lineHeight: '1.8',
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '13px',
  backgroundColor: '#e5e7eb',
  padding: '1px 5px',
  borderRadius: '4px',
};
