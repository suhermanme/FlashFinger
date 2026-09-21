import type { EngineDelta } from '../../domain/typing/types.js';
import { CaretController } from './caret.js';
import { layoutText, mountedWindow, type TextLayout } from './layout.js';

export interface TextRendererOptions {
  root: HTMLElement;
  caret: HTMLElement;
  text: string;
  width: number;
  measure?: (grapheme: string) => number;
  lineHeight?: number;
}

export class TextRenderer {
  private layout: TextLayout;
  private readonly measure: (grapheme: string) => number;
  private readonly lineHeight: number;
  private readonly nodes = new Map<number, HTMLElement>();
  private readonly characterStates = new Map<number, 'correct' | 'error'>();
  private readonly caret: CaretController;
  private cursor = 0;
  private mountedStart = 0;
  private mountedEnd = 0;

  constructor(private readonly options: TextRendererOptions) {
    this.measure = options.measure ?? ((grapheme) => grapheme === '\t' ? 32 : 16);
    this.lineHeight = options.lineHeight ?? 36;
    this.layout = layoutText(options.text, options.width, this.measure, this.lineHeight);
    this.caret = new CaretController(options.caret, this.layout.positions);
    this.mount(0);
  }

  apply(deltas: readonly EngineDelta[]): void {
    for (const delta of deltas) {
      if (delta.kind === 'accepted') this.setCharacterState(delta.position, delta.correct ? 'correct' : 'error');
      if (delta.kind === 'corrected') this.setCharacterState(delta.position, 'upcoming');
      if (delta.kind === 'progress') {
        this.cursor = delta.textCursor;
        this.ensureMounted(delta.textCursor);
        this.caret.moveTo(delta.textCursor);
      }
    }
  }

  relayout(width: number): void {
    this.layout = layoutText(this.options.text, width, this.measure, this.lineHeight);
    this.caret.setPositions(this.layout.positions);
    this.mount(this.cursor);
  }

  destroy(): void { this.nodes.clear(); this.characterStates.clear(); this.options.root.replaceChildren(); }
  get mountedCount(): number { return this.nodes.size; }
  getLayout(): TextLayout { return this.layout; }

  private setCharacterState(index: number, state: 'upcoming' | 'correct' | 'error'): void {
    if (state === 'upcoming') this.characterStates.delete(index);
    else this.characterStates.set(index, state);
    const node = this.nodes.get(index);
    if (!node) return;
    node.dataset.state = state;
    node.className = `ff-character ff-character-${state}`;
  }

  private ensureMounted(cursor: number): void {
    const range = mountedWindow(this.layout, cursor);
    if (this.mountedStart !== range.start || this.mountedEnd !== range.end) this.mount(cursor);
  }

  private mount(cursor: number): void {
    const range = mountedWindow(this.layout, cursor);
    const fragment = this.options.root.ownerDocument.createDocumentFragment();
    this.nodes.clear();
    this.mountedStart = range.start;
    this.mountedEnd = range.end;
    for (let index = range.start; index < range.end; index += 1) {
      const node = this.options.root.ownerDocument.createElement('span');
      const grapheme = this.layout.graphemes[index];
      node.textContent = grapheme === ' ' ? '\u00a0' : grapheme === '\n' ? '↵\n' : grapheme;
      const state = this.characterStates.get(index) ?? 'upcoming';
      node.className = `ff-character ff-character-${state}`;
      node.dataset.state = state;
      node.dataset.index = String(index);
      const position = this.layout.positions[index];
      node.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
      this.nodes.set(index, node);
      fragment.append(node);
    }
    this.options.root.replaceChildren(fragment);
  }
}
