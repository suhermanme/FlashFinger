import type { GlyphPosition } from './layout.js';

export class CaretController {
  private currentIndex = 0;
  constructor(private readonly element: HTMLElement, private positions: readonly GlyphPosition[]) {}
  setPositions(positions: readonly GlyphPosition[]): void { this.positions = positions; this.moveTo(this.currentIndex); }
  moveTo(index: number): void {
    this.currentIndex = index;
    const fallback = this.positions.at(-1);
    const position = this.positions[index] ?? (fallback ? { ...fallback, x: fallback.x + fallback.width } : { x: 0, y: 0 });
    this.element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
    this.element.dataset.position = String(index);
  }
  get position(): number { return this.currentIndex; }
}
