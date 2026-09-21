import { useState, type FormEvent } from 'react';
import type { PracticeConfig, PracticeTermination, PracticeTier } from '../../contracts/models.js';
import type { DictionaryManifest } from '../../domain/training/dictionary.js';
import { DictionaryConfigurationError } from '../../domain/training/dictionary.js';
import { preparePractice, type PreparedPractice } from '../../domain/training/practice.js';
import { Button } from '../../components/Button.js';
import { validatePracticeConfig } from '../../contracts/validation.js';

export interface PracticeSetupProps {
  manifest: DictionaryManifest;
  initialConfig: PracticeConfig;
  onStart(prepared: PreparedPractice, config: PracticeConfig): void;
}

export function PracticeSetup({ manifest, initialConfig, onStart }: PracticeSetupProps) {
  const [config, setConfig] = useState(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const validation = validatePracticeConfig(config);
      if (!validation.valid) throw new DictionaryConfigurationError(validation.errors[0]?.message ?? 'Practice configuration is invalid.');
      setError(null); onStart(preparePractice(manifest, config), config);
    }
    catch (cause) { setError(cause instanceof DictionaryConfigurationError ? cause.message : 'Practice could not be prepared.'); }
  };
  const setTermination = (termination: PracticeTermination) => setConfig((value) => ({ ...value, termination }));
  return <form className="ff-card ff-practice-setup" onSubmit={submit} aria-labelledby="practice-heading">
    <h2 id="practice-heading">Practice</h2>
    <label>Difficulty <select value={config.tier}
      onChange={(event) => setConfig({ ...config, tier: event.target.value as PracticeTier })}>
      <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option>
      <option value="advanced">Advanced</option><option value="mixed">Mixed</option>
    </select></label>
    <fieldset><legend>Length</legend>
      <label><input type="radio" checked={config.termination.kind === 'timed'}
        onChange={() => setTermination({ kind: 'timed', seconds: 60 })} /> Timed</label>
      <label><input type="radio" checked={config.termination.kind === 'words'}
        onChange={() => setTermination({ kind: 'words', count: 50 })} /> Word target</label>
      <label><input type="radio" checked={config.termination.kind === 'endless'}
        onChange={() => setTermination({ kind: 'endless' })} /> Endless</label>
    </fieldset>
    <label>Seed <input value={config.seed} onChange={(event) => setConfig({ ...config, seed: event.target.value })} /></label>
    <label>Focus keys <input value={config.keyFilter ?? ''} maxLength={4}
      onChange={(event) => setConfig({ ...config, keyFilter: event.target.value || null })} /></label>
    <label><input type="checkbox" checked={config.punctuation}
      onChange={(event) => setConfig({ ...config, punctuation: event.target.checked })} /> Punctuation</label>
    <label><input type="checkbox" checked={config.capitalization}
      onChange={(event) => setConfig({ ...config, capitalization: event.target.checked })} /> Capitalization</label>
    {error ? <p role="alert" className="ff-save-error">{error}</p> : null}
    <Button variant="primary" type="submit">Prepare practice</Button>
  </form>;
}
