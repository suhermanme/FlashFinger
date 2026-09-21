import type { EngineCommand, EngineDelta, EngineState } from '../../domain/typing/types.js';

export interface InputEngine {
  processCommand(command: EngineCommand): EngineDelta[];
  getState(): EngineState;
}
export interface InputCommit { kind: 'text' | 'composition' | 'delete'; graphemes: string[]; deltas: EngineDelta[] }
export type InputPauseReason = 'blur' | 'hidden' | 'resize';
export interface InputSink { onCommit(commit: InputCommit): void; onPhysicalKey?(code: string, pressed: boolean): void; onPause?(reason: InputPauseReason): void }
export interface BeforeInputLike { inputType: string; data: string | null; preventDefault(): void }
export interface KeyDownLike { key: string; code: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; preventDefault(): void }

function graphemes(text: string): string[] {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
}

export class InputAdapter {
  private composing = false;
  private suppressRepeatedText = false;
  private pendingCompositionEcho: string | null = null;
  private lastBackspaceAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly engine: InputEngine, private readonly sink: InputSink, private readonly now = () => performance.now()) {}

  handleKeyDown(event: KeyDownLike): void {
    this.sink.onPhysicalKey?.(event.code, true);
    if (event.ctrlKey || event.altKey || event.metaKey || event.key === 'Tab' || event.key === 'Escape' || event.key.startsWith('F')) return;
    if (event.repeat && event.key !== 'Backspace') this.suppressRepeatedText = true;
  }
  handleKeyUp(code: string): void {
    this.sink.onPhysicalKey?.(code, false);
    // Some engines omit beforeinput for a suppressed repeat. Do not let that
    // stale suppression consume the user's next non-repeated keystroke.
    this.suppressRepeatedText = false;
  }
  handleCompositionStart(): void { this.composing = true; this.pendingCompositionEcho = null; }
  handleCompositionEnd(text: string): void {
    this.composing = false;
    const units = graphemes(text);
    if (units.length === 0) return;
    const deltas = units.flatMap((unit) => this.engine.processCommand({ kind: 'character', grapheme: unit }));
    this.sink.onCommit({ kind: 'composition', graphemes: units, deltas });
    // Chromium can echo the committed composition as a following insertText.
    // Match the payload instead of suppressing an unrelated next character.
    this.pendingCompositionEcho = text;
  }
  handleBeforeInput(event: BeforeInputLike): void {
    // Let the browser maintain its native composition UI. The final batch is
    // scored exactly once by compositionend below.
    if (this.composing || event.inputType === 'insertCompositionText') return;
    if (event.inputType.startsWith('insert') || event.inputType.startsWith('delete')) event.preventDefault();
    if (event.inputType === 'insertFromComposition') {
      this.pendingCompositionEcho = null;
      return;
    }
    if (event.inputType === 'deleteContentBackward') {
      const timestamp = this.now();
      if (timestamp - this.lastBackspaceAt < 35) return;
      this.lastBackspaceAt = timestamp;
      const deltas = this.engine.processCommand({ kind: 'delete' });
      this.sink.onCommit({ kind: 'delete', graphemes: [], deltas });
      return;
    }
    if (event.inputType !== 'insertText' || event.data === null) return;
    if (this.pendingCompositionEcho !== null) {
      const isEcho = event.data === this.pendingCompositionEcho;
      this.pendingCompositionEcho = null;
      if (isEcho) return;
    }
    if (this.suppressRepeatedText) { this.suppressRepeatedText = false; return; }
    const units = graphemes(event.data);
    if (units.length !== 1) return;
    const deltas = this.engine.processCommand({ kind: 'character', grapheme: units[0] });
    this.sink.onCommit({ kind: 'text', graphemes: units, deltas });
  }
  pauseForFocusLoss(reason: InputPauseReason): void {
    if (this.engine.getState() !== 'running') return;
    const deltas = this.engine.processCommand({ kind: 'pause' });
    this.sink.onCommit({ kind: 'text', graphemes: [], deltas });
    this.sink.onPause?.(reason);
  }
}
