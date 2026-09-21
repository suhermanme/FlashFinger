export interface GlyphPosition {
  index: number;
  line: number;
  x: number;
  y: number;
  width: number;
}

export interface TextLine {
  line: number;
  start: number;
  end: number;
}

export interface TextLayout {
  graphemes: string[];
  positions: GlyphPosition[];
  lines: TextLine[];
  lineHeight: number;
  maxWidth: number;
}

export interface MountedWindow { start: number; end: number; firstLine: number; lastLine: number }
export const MAX_MOUNTED_GRAPHEMES = 2_048;
export const VISIBLE_LINES = 3;
export const OVERSCAN_LINES = 2;

export function segmentText(text: string): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((item) => item.segment);
}

export function layoutText(
  text: string,
  maxWidth: number,
  measure: (grapheme: string) => number,
  lineHeight = 36,
): TextLayout {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) throw new RangeError('Text layout width must be positive');
  const graphemes = segmentText(text);
  const positions: GlyphPosition[] = [];
  const lines: TextLine[] = [];
  let x = 0;
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index];
    const width = Math.max(1, measure(grapheme));
    const isNewline = grapheme === '\n';
    if (!isNewline && x > 0 && x + width > maxWidth) {
      lines.push({ line, start: lineStart, end: index });
      line += 1;
      lineStart = index;
      x = 0;
    }
    positions.push({ index, line, x, y: line * lineHeight, width: isNewline ? 0 : width });
    if (isNewline) {
      lines.push({ line, start: lineStart, end: index + 1 });
      line += 1;
      lineStart = index + 1;
      x = 0;
    } else {
      x += width;
    }
  }
  if (lineStart < graphemes.length || graphemes.length === 0) lines.push({ line, start: lineStart, end: graphemes.length });
  return { graphemes, positions, lines, lineHeight, maxWidth };
}

export function mountedWindow(layout: TextLayout, cursor: number): MountedWindow {
  const safeCursor = Math.max(0, Math.min(cursor, Math.max(0, layout.graphemes.length - 1)));
  const cursorLine = layout.positions[safeCursor]?.line ?? 0;
  const firstLine = Math.max(0, cursorLine - 1);
  const lastLine = Math.min(layout.lines.length - 1, firstLine + VISIBLE_LINES + OVERSCAN_LINES - 1);
  const first = layout.lines[firstLine] ?? { start: 0, end: 0 };
  const last = layout.lines[lastLine] ?? first;
  let start = first.start;
  let end = Math.min(layout.graphemes.length, last.end);
  if (end - start > MAX_MOUNTED_GRAPHEMES) {
    start = Math.max(start, safeCursor - Math.floor(MAX_MOUNTED_GRAPHEMES / 2));
    end = Math.min(layout.graphemes.length, start + MAX_MOUNTED_GRAPHEMES);
    start = Math.max(0, end - MAX_MOUNTED_GRAPHEMES);
  }
  return { start, end, firstLine, lastLine };
}
