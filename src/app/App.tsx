import { useEffect, useState, type ReactNode } from 'react';
import { getPlatformAdapter } from '../platform/factory.js';
import { Navigation } from '../components/Navigation.js';
import { CustomTextSetup } from '../features/custom-text/index.js';
import { registerOfflineWorker } from '../platform/web/offline.js';
import { BackupSettings } from '../features/settings/BackupSettings.js';
import { PracticeSetup, PracticeSession } from '../features/practice/index.js';
import { loadDictionaryManifest } from '../domain/training/dictionary.js';
import type { PreparedPractice } from '../domain/training/practice.js';
import type { PracticeConfig } from '../contracts/models.js';

export function App(): ReactNode {
  const [adapter, setAdapter] = useState<ReturnType<typeof getPlatformAdapter> | null>(null);
  const [manifest, setManifest] = useState<Awaited<ReturnType<typeof loadDictionaryManifest>> | null>(null);
  const [practice, setPractice] = useState<PreparedPractice | null>(null);
  const defaults: PracticeConfig = { tier: 'beginner', termination: { kind: 'timed', seconds: 60 }, punctuation: false, capitalization: false, seed: 'demo', correctionPolicy: 'strict', keyFilter: null, configVersion: 1 };
  useEffect(() => { setAdapter(getPlatformAdapter()); void loadDictionaryManifest().then(setManifest).catch(() => undefined); if (import.meta.env.PROD) void registerOfflineWorker(); }, []);
  return <>
    <a className="ff-skip-link" href="#main-content">Skip to main content</a>
    <div className="ff-shell">
      <header className="ff-shell-header">
        <h1>FlashFinger</h1>
        <Navigation activeId="practice" items={[
          { id: 'lessons', label: 'Lessons', href: '#lessons' },
          { id: 'practice', label: 'Practice', href: '#practice' },
          { id: 'custom', label: 'Custom text', href: '#custom' },
          { id: 'history', label: 'History', href: '#history' },
        ]} />
      </header>
      <main id="main-content" tabIndex={-1}>
        <section className="ff-card" aria-labelledby="shell-status-heading">
          <h2 id="shell-status-heading">Ready to configure</h2>
          <p className="ff-muted">The shared offline renderer and persistence foundations are ready for profile and typing workflows.</p>
          <p><span className="ff-status">{adapter?.target ?? 'loading'}</span>{' '}
            <span className="ff-status">{adapter?.capabilities.persistence ?? 'detecting storage'}</span></p>
        </section>
        <section id="practice">{practice ? <PracticeSession prepared={practice} onExit={() => setPractice(null)} /> : manifest ? <PracticeSetup manifest={manifest} initialConfig={defaults} onStart={(prepared) => setPractice(prepared)} /> : <p role="status">Loading local practice dictionary…</p>}</section>
        <section id="custom" aria-labelledby="custom-text-shell-heading">
          <CustomTextSetup onStart={() => { /* M15 supplies the shared coordinator handoff. */ }} />
        </section>
        <BackupSettings />
      </main>
    </div>
  </>;
}
