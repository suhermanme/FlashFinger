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
  return <form className="ff-practice-setup ff-view-enter" onSubmit={submit} aria-labelledby="practice-heading">
    <header className="ff-setup-hero"><span className="ff-eyebrow">Daily training</span><h2 id="practice-heading">Find your flow.</h2><p>Choose a session, settle into the text, and let your hands do the learning.</p></header>
    <div className="ff-setup-grid">
      <section className="ff-card ff-setup-primary"><div className="ff-section-heading"><span>01</span><div><h3>Session</h3><p>Pick the pace and finish line.</p></div></div>
        <label className="ff-field">Difficulty<select value={config.tier}
          onChange={(event) => setConfig({ ...config, tier: event.target.value as PracticeTier })}>
          <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option>
          <option value="advanced">Advanced</option><option value="mixed">Mixed</option>
        </select></label>
        <fieldset className="ff-mode-picker"><legend>Session length</legend>
          <label><input type="radio" checked={config.termination.kind === 'timed'}
            onChange={() => setTermination({ kind: 'timed', seconds: 60 })} /><span><strong>60 sec</strong><small>Quick sprint</small></span></label>
          <label><input type="radio" checked={config.termination.kind === 'words'}
            onChange={() => setTermination({ kind: 'words', count: 50 })} /><span><strong>50 words</strong><small>Fixed target</small></span></label>
          <label><input type="radio" checked={config.termination.kind === 'endless'}
            onChange={() => setTermination({ kind: 'endless' })} /><span><strong>Endless</strong><small>No pressure</small></span></label>
        </fieldset>
      </section>
      <section className="ff-card ff-setup-options"><div className="ff-section-heading"><span>02</span><div><h3>Fine tune</h3><p>Optional controls for focused drills.</p></div></div>
        <label className="ff-field">Seed<input value={config.seed} onChange={(event) => setConfig({ ...config, seed: event.target.value })} /></label>
        <label className="ff-field">Focus keys<input value={config.keyFilter ?? ''} maxLength={4} placeholder="e.g. asdf"
          onChange={(event) => setConfig({ ...config, keyFilter: event.target.value || null })} /></label>
        <div className="ff-toggle-row"><label><input type="checkbox" checked={config.punctuation}
          onChange={(event) => setConfig({ ...config, punctuation: event.target.checked })} /> Punctuation</label>
        <label><input type="checkbox" checked={config.capitalization}
          onChange={(event) => setConfig({ ...config, capitalization: event.target.checked })} /> Capitalization</label></div>
      </section>
    </div>
    {error ? <p role="alert" className="ff-save-error">{error}</p> : null}
    <footer className="ff-setup-footer"><span>Your timer starts with the first key.</span><Button variant="primary" type="submit">Start practice <span aria-hidden="true">→</span></Button></footer>
  </form>;
}
