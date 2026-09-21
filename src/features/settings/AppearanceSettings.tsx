import { useStore } from 'zustand';
import type { SettingsStore } from '../../state/settings.js';
import { updateSettings } from '../../state/settings.js';
import { Button } from '../../components/Button.js';
export interface AppearanceSettingsProps { store: SettingsStore; onSave(): void }
export function AppearanceSettings({ store, onSave }: AppearanceSettingsProps) {
  const settings = useStore(store, (state) => state.values);
  const dirty = useStore(store, (state) => state.dirty);
  const saving = useStore(store, (state) => state.saveState === 'saving');
  if (!settings) return <p className="ff-muted">Select a profile to edit appearance.</p>;
  return <section aria-labelledby="appearance-heading"><h2 id="appearance-heading">Appearance</h2>
    <label className="ff-field">Theme<select value={settings.themePreference} onChange={(event) => updateSettings(store, { themePreference: event.currentTarget.value as typeof settings.themePreference })}>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <label className="ff-field">Motion<select value={settings.motion} onChange={(event) => updateSettings(store, { motion: event.currentTarget.value as typeof settings.motion })}>
      <option value="system">System</option><option value="full">Full</option><option value="reduced">Reduced</option></select></label>
    <label className="ff-field">Typing text size<input type="range" min="16" max="40" value={settings.fontSizePx} onChange={(event) => updateSettings(store, { fontSizePx: Number(event.currentTarget.value) })} /></label>
    <Button variant="primary" disabled={!dirty || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save appearance'}</Button>
  </section>;
}
