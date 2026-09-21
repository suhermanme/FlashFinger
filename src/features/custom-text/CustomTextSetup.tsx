import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button.js';
import { normalizeCustomText, prepareCustomTextBytes, toCustomTextSource, type CustomTextPolicy, type PreparedCustomText } from '../../domain/training/customText.js';

export interface CustomTextSetupProps { onStart(prepared: PreparedCustomText): void; }
export function CustomTextSetup({ onStart }: CustomTextSetupProps) {
  const [value, setValue] = useState(''); const [policy, setPolicy] = useState<CustomTextPolicy>('reading');
  const [trim, setTrim] = useState(true); const [preview, setPreview] = useState<PreparedCustomText | null>(null); const [error, setError] = useState<string | null>(null);
  const prepare = (text: string) => { try { const next = normalizeCustomText(text, { policy, trimWhitespace: trim }); setPreview(next); setError(null); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Text could not be prepared.'); } };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!preview) prepare(value); else onStart(preview); };
  return <form className="ff-card ff-custom-text-setup" onSubmit={submit} aria-labelledby="custom-text-heading">
    <h2 id="custom-text-heading">Custom text</h2><textarea value={value} onChange={(event) => { setValue(event.target.value); setPreview(null); }} rows={8} aria-label="Text to practise" />
    <label>Normalization <select value={policy} onChange={(event) => { setPolicy(event.target.value as CustomTextPolicy); setPreview(null); }}><option value="reading">Reading practice</option><option value="preserve">Preserve formatting</option></select></label>
    <label><input type="checkbox" checked={trim} onChange={(event) => { setTrim(event.target.checked); setPreview(null); }} /> Trim leading and trailing whitespace</label>
    {preview ? <p role="status">Preview: {preview.graphemeCount.toLocaleString()} graphemes, {preview.chunks.length} chunks.</p> : null}
    {error ? <p role="alert" className="ff-save-error">{error}</p> : null}<Button variant="primary" type="submit">{preview ? 'Start custom text' : 'Preview text'}</Button>
  </form>;
}
export { toCustomTextSource, prepareCustomTextBytes };
