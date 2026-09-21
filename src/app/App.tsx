import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { registerOfflineWorker } from '../platform/web/offline.js';
import { getPlatformAdapter } from '../platform/factory.js';
import { BackupSettings } from '../features/settings/BackupSettings.js';
import { ProfileManager } from '../features/profiles/index.js';
import { PracticeSetup, PracticeSession } from '../features/practice/index.js';
import { LessonSelection } from '../features/lessons/LessonSelection.js';
import { HistoryDashboard } from '../features/history/index.js';
import { loadDictionaryManifest } from '../domain/training/dictionary.js';
import type { PreparedPractice } from '../domain/training/practice.js';
import type { PracticeConfig } from '../contracts/models.js';
import { prepareCustomTextBytes, toCustomTextSource } from '../domain/training/customText.js';
import { createLessonSessionConfig, createLessonSource, loadCurriculumAsset, type LessonCatalog } from '../domain/training/lessons.js';
import { buildLessonAvailability } from '../domain/training/progression.js';
import { calendarDays } from '../domain/metrics/calendar.js';
import { METRIC_VERSION } from '../contracts/versions.js';
import { ProfileCoordinator } from './profileCoordinator.js';
import { createAppStore } from '../state/app.js';
import { createProfilesStore } from '../state/profiles.js';
import { createSettingsStore } from '../state/settings.js';
import { createRuntimeStore } from '../state/runtime.js';
import type { ProfileSettings } from '../contracts/models.js';
import { KEYBOARD_SOUND_PROFILES, type KeyboardSoundProfile } from '../engines/audio/keyboardSynth.js';

type View = 'practice' | 'lessons' | 'history' | 'analytics' | 'profiles' | 'settings';
const defaults: PracticeConfig = { tier: 'beginner', termination: { kind: 'timed', seconds: 60 }, punctuation: false, capitalization: false, seed: 'demo', correctionPolicy: 'strict', keyFilter: null, configVersion: 1 };
const defaultProfileSettings: ProfileSettings = { themePreference: 'system', soundProfileId: 'clicky', volume: .8, muted: false, motion: 'system', fontSizePx: 28, keyboardLayout: 'us-qwerty', showKeyboard: true, practiceDefaults: defaults };

export function App(): ReactNode {
  const profileSystem = useMemo(() => {
    const stores = { app: createAppStore(), profiles: createProfilesStore(), settings: createSettingsStore(), runtime: createRuntimeStore() };
    return { stores, coordinator: new ProfileCoordinator(getPlatformAdapter().repository, stores) };
  }, []);
  const profiles = useStore(profileSystem.stores.profiles, (state) => state.profiles);
  const activeProfileId = useStore(profileSystem.stores.profiles, (state) => state.activeProfileId);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const [view, setView] = useState<View>('practice');
  const [manifest, setManifest] = useState<Awaited<ReturnType<typeof loadDictionaryManifest>> | null>(null);
  const [catalog, setCatalog] = useState<LessonCatalog | null>(null);
  const [practice, setPractice] = useState<PreparedPractice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [fontSize, setFontSize] = useState(28);
  const [showKeyboard, setShowKeyboard] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundProfile, setSoundProfile] = useState<KeyboardSoundProfile>('clicky');
  const [soundVolume, setSoundVolume] = useState(.8);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void profileSystem.coordinator.initialize();
    void loadDictionaryManifest().then(setManifest).catch(() => setLoadError('The local practice dictionary could not be loaded.'));
    void loadCurriculumAsset().then(setCatalog).catch(() => setLoadError('The local lesson catalog could not be loaded.'));
    if (import.meta.env.PROD) void registerOfflineWorker();
  }, [profileSystem]);
  useEffect(() => { document.documentElement.dataset.ffTheme = theme; }, [theme]);
  useEffect(() => { document.documentElement.style.setProperty('--ff-size-typing', `${fontSize}px`); }, [fontSize]);

  const selectView = (next: View) => { setPractice(null); setView(next); setLoadError(null); };
  const startLesson = (lessonId: string) => {
    if (!catalog) return;
    const source = createLessonSource(catalog, lessonId, 'local-profile');
    setPractice({ source, sessionConfig: createLessonSessionConfig(source), controller: null });
  };
  const loadCustomFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      const prepared = prepareCustomTextBytes(new Uint8Array(await file.arrayBuffer()), { title: file.name.replace(/\.txt$/i, ''), policy: 'reading', trimWhitespace: true });
      const source = toCustomTextSource(prepared);
      setPractice({ source, controller: null, sessionConfig: { mode: 'custom', correctionPolicy: 'strict', durationLimitMs: null, targetLength: prepared.graphemeCount, sourceRef: source.id, contentVersion: source.version, metricVersion: METRIC_VERSION, layout: 'us-qwerty', compatibilityInput: false, heldKeyRepeat: 'ignored' } });
      setView('practice'); setLoadError(null);
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'The text file could not be loaded.'); }
  };
  const title = practice?.source.mode === 'custom' ? 'Custom text' : practice?.source.mode === 'lessons' ? 'Lesson' : view[0].toUpperCase() + view.slice(1);

  return <><a className="ff-skip-link" href="#main-content">Skip to main content</a><div className="ff-shell ff-app-frame">
    <aside className="ff-sidebar" aria-label="Application navigation">
      <div className="ff-brand"><span className="ff-brand-mark">⌁</span><span><strong>FlashFinger</strong><small>Typing studio</small></span></div>
      <button className={`ff-profile-chip${view === 'profiles' ? ' ff-profile-chip-active' : ''}`} type="button" onClick={() => selectView('profiles')}><span className="ff-profile-avatar">{activeProfile?.name.slice(0, 1).toUpperCase() ?? '+'}</span><span><strong>{activeProfile?.name ?? 'Create profile'}</strong><small>{activeProfile ? 'Local profile' : 'Set up your workspace'}</small></span><span aria-hidden="true">›</span></button>
      <div className="ff-sidebar-group"><span className="ff-sidebar-label">TRAIN</span><NavButton active={view === 'practice'} onClick={() => selectView('practice')}>⌨ Practice</NavButton><NavButton active={view === 'lessons'} onClick={() => selectView('lessons')}>▦ Lessons</NavButton><button className="ff-sidebar-link" type="button" onClick={() => fileInputRef.current?.click()}>＋ Load text file</button><input ref={fileInputRef} className="ff-file-input" type="file" accept=".txt,text/plain" onChange={(event) => void loadCustomFile(event)} /></div>
      <div className="ff-sidebar-group"><span className="ff-sidebar-label">REVIEW</span><NavButton active={view === 'history'} onClick={() => selectView('history')}>◒ History</NavButton><NavButton active={view === 'analytics'} onClick={() => selectView('analytics')}>⌁ Analytics</NavButton></div>
      <div className="ff-sidebar-spacer" /><div className="ff-sidebar-footer"><NavButton active={view === 'settings'} onClick={() => selectView('settings')}>⚙ Settings</NavButton></div>
    </aside>
    <main id="main-content" className="ff-main-panel" tabIndex={-1}>
      <header className="ff-window-toolbar"><div><span className="ff-toolbar-title">{title}</span><span className="ff-toolbar-subtitle">{practice?.source.title ?? subtitle(view)}</span></div><div className="ff-toolbar-actions"><button className="ff-icon-button" aria-label={soundEnabled ? 'Mute sounds' : 'Turn sounds on'} aria-pressed={!soundEnabled} onClick={() => setSoundEnabled((value) => !value)}>{soundEnabled ? '♫' : '♪̸'}</button><button className="ff-icon-button" aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '◐' : '☀'}</button></div></header>
      {loadError ? <p className="ff-file-error" role="alert">{loadError}</p> : null}
      {practice ? <PracticeSession prepared={practice} showKeyboard={showKeyboard} soundEnabled={soundEnabled} soundProfile={soundProfile} soundVolume={soundVolume} onExit={() => { setPractice(null); setView('practice'); }} /> : null}
      {!practice && view === 'practice' ? manifest ? <PracticeSetup manifest={manifest} initialConfig={defaults} onStart={setPractice} /> : <p role="status">Loading local practice dictionary…</p> : null}
      {!practice && view === 'lessons' ? catalog ? <LessonSelection lessons={buildLessonAvailability(catalog.curriculum, [])} onSelect={startLesson} /> : <p role="status">Loading lessons…</p> : null}
      {!practice && view === 'history' ? <HistoryDashboard bars={[]} calendar={calendarDays([], '2026-09-01', '2026-09-28')} /> : null}
      {!practice && view === 'analytics' ? <EmptyAnalytics /> : null}
      {!practice && view === 'profiles' ? <ProfileManager coordinator={profileSystem.coordinator} profilesStore={profileSystem.stores.profiles} defaultSettings={defaultProfileSettings} /> : null}
      {!practice && view === 'settings' ? <Settings theme={theme} setTheme={setTheme} fontSize={fontSize} setFontSize={setFontSize} showKeyboard={showKeyboard} setShowKeyboard={setShowKeyboard} soundEnabled={soundEnabled} setSoundEnabled={setSoundEnabled} soundProfile={soundProfile} setSoundProfile={setSoundProfile} soundVolume={soundVolume} setSoundVolume={setSoundVolume} /> : null}
    </main>
  </div></>;
}

function NavButton({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) { return <button className={`ff-sidebar-link${active ? ' ff-sidebar-link-active' : ''}`} type="button" onClick={onClick}>{children}</button>; }
function subtitle(view: View): string { return view === 'practice' ? 'Build speed, accuracy, and flow' : view === 'lessons' ? 'Structured touch-typing progression' : view === 'history' ? 'Review completed sessions' : view === 'analytics' ? 'Understand speed and accuracy trends' : view === 'profiles' ? 'Manage local people and progress' : 'Personalize your typing workspace'; }
function EmptyAnalytics() { return <section className="ff-dashboard" aria-labelledby="analytics-heading"><h2 id="analytics-heading">Analytics</h2><div className="ff-stat-grid"><article><small>AVERAGE WPM</small><strong>—</strong></article><article><small>ACCURACY</small><strong>—</strong></article><article><small>ACTIVE TIME</small><strong>0m</strong></article><article><small>SESSIONS</small><strong>0</strong></article></div><div className="ff-empty-chart"><span>Complete a typing session to build your performance graph.</span></div></section>; }
interface SettingsProps {
  theme: 'light' | 'dark';
  setTheme(value: 'light' | 'dark'): void;
  fontSize: number;
  setFontSize(value: number): void;
  showKeyboard: boolean;
  setShowKeyboard(value: boolean): void;
  soundEnabled: boolean;
  setSoundEnabled(value: boolean): void;
  soundProfile: KeyboardSoundProfile;
  setSoundProfile(value: KeyboardSoundProfile): void;
  soundVolume: number;
  setSoundVolume(value: number): void;
}

function Settings({ theme, setTheme, fontSize, setFontSize, showKeyboard, setShowKeyboard, soundEnabled, setSoundEnabled, soundProfile, setSoundProfile, soundVolume, setSoundVolume }: SettingsProps) {
  return <section className="ff-settings-page ff-view-enter" aria-labelledby="settings-heading">
    <div className="ff-page-heading"><span className="ff-eyebrow">Workspace</span><h2 id="settings-heading">Settings</h2><p>Shape the typing experience around the way you work.</p></div>
    <div className="ff-settings-grid">
      <section className="ff-card"><h3>Appearance</h3><label className="ff-field">Theme<select value={theme} onChange={(event) => setTheme(event.target.value as 'light' | 'dark')}><option value="light">Light</option><option value="dark">Dark</option></select></label><label className="ff-field">Typing text size <output>{fontSize}px</output><input type="range" min="20" max="48" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /></label></section>
      <section className="ff-card"><h3>Keyboard sound</h3><div className="ff-sound-profiles" role="radiogroup" aria-label="Keyboard sound">{KEYBOARD_SOUND_PROFILES.map((profile) => <label key={profile.id} className={soundProfile === profile.id ? 'ff-sound-profile ff-sound-profile-active' : 'ff-sound-profile'}><input type="radio" name="sound-profile" value={profile.id} checked={soundProfile === profile.id} onChange={() => setSoundProfile(profile.id)} /><span><strong>{profile.name}</strong><small>{profile.description}</small></span></label>)}</div><label className="ff-volume-control"><span>Volume <output>{Math.round(soundVolume * 100)}%</output></span><input aria-label="Sound volume" type="range" min="0" max="100" value={Math.round(soundVolume * 100)} onChange={(event) => setSoundVolume(Number(event.target.value) / 100)} /></label><label className="ff-setting-toggle"><input type="checkbox" checked={soundEnabled} onChange={(event) => setSoundEnabled(event.target.checked)} /> Play typing sounds</label></section>
      <section className="ff-card"><h3>Typing experience</h3><label className="ff-setting-toggle"><input type="checkbox" checked={showKeyboard} onChange={(event) => setShowKeyboard(event.target.checked)} /> Show keyboard overlay</label><p className="ff-muted">Changes apply immediately to practice and lesson sessions.</p></section>
    </div>
    <BackupSettings />
  </section>;
}
