import { useEffect, useLayoutEffect, useRef } from 'react';
import type { EngineDelta } from '../../domain/typing/types.js';
import type { InputEngine, InputSink } from './inputAdapter.js';
import { InputAdapter } from './inputAdapter.js';
import { TextRenderer } from '../../engines/visual/textRenderer.js';

export interface TypingFeedback {
  onDeltas(deltas: readonly EngineDelta[]): void;
  onPhysicalKey?(code: string, pressed: boolean): void;
  pause?(): void;
  cancel?(): void;
}
export interface TypingSurfaceProps { engine: InputEngine; targetText: string; sink?: InputSink; feedback?: TypingFeedback; accessibleLabel?: string }
const SILENT_SINK: InputSink = { onCommit: () => undefined };

export function TypingSurface({ engine, targetText, sink = SILENT_SINK, feedback, accessibleLabel = 'Typing input' }: TypingSurfaceProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rendererRef = useRef<TextRenderer | null>(null);
  const adapterRef = useRef<InputAdapter | null>(null);

  useLayoutEffect(() => {
    if (!viewportRef.current || !textRef.current || !caretRef.current) return;
    rendererRef.current = new TextRenderer({ root: textRef.current, caret: caretRef.current, text: targetText,
      width: Math.max(320, viewportRef.current.clientWidth || 640) });
    return () => { rendererRef.current?.destroy(); rendererRef.current = null; };
  }, [targetText]);

  useEffect(() => {
    const combined: InputSink = {
      ...sink,
      onCommit(commit) {
        rendererRef.current?.apply(commit.deltas);
        feedback?.onDeltas(commit.deltas);
        sink.onCommit(commit);
      },
      onPhysicalKey(code, pressed) { feedback?.onPhysicalKey?.(code, pressed); sink.onPhysicalKey?.(code, pressed); },
      onPause(reason) { feedback?.pause?.(); sink.onPause?.(reason); },
    };
    adapterRef.current = new InputAdapter(engine, combined);
    const onVisibility = () => { if (document.hidden) adapterRef.current?.pauseForFocusLoss('hidden'); };
    document.addEventListener('visibilitychange', onVisibility);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (!width || width <= 0) return;
      if (engine.getState() === 'running') adapterRef.current?.pauseForFocusLoss('resize');
      if (engine.getState() === 'ready' || engine.getState() === 'paused') rendererRef.current?.relayout(width);
    });
    if (viewportRef.current) observer?.observe(viewportRef.current);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      feedback?.cancel?.();
      adapterRef.current = null;
    };
  }, [engine, feedback, sink]);

  return <section className="ff-typing-surface" aria-label="Typing exercise">
    <div ref={viewportRef} className="ff-text-viewport" aria-hidden="true">
      <div ref={textRef} className="ff-text-layer" /><div ref={caretRef} className="ff-caret" />
    </div>
    <textarea ref={inputRef} className="ff-native-input" aria-label={accessibleLabel} autoCapitalize="off" autoCorrect="off"
      autoComplete="off" spellCheck={false} value="" onChange={() => undefined}
      onBeforeInput={(event) => adapterRef.current?.handleBeforeInput(event.nativeEvent)}
      onCompositionStart={() => adapterRef.current?.handleCompositionStart()}
      onCompositionEnd={(event) => adapterRef.current?.handleCompositionEnd(event.data)}
      onKeyDown={(event) => adapterRef.current?.handleKeyDown(event.nativeEvent)}
      onKeyUp={(event) => adapterRef.current?.handleKeyUp(event.code)}
      onPaste={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}
      onBlur={() => adapterRef.current?.pauseForFocusLoss('blur')} />
    <div className="ff-sr-live" aria-live="polite" aria-atomic="true" />
  </section>;
}
