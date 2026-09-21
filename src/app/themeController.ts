import type { MotionPreference, ProfileSettings, ResolvedTheme, ThemePreference } from '../contracts/models.js';
import { THEME_HINT_KEY } from '../contracts/platform.js';

export const CANVAS_THEME_TOKENS = [
  '--ff-surface-background', '--ff-surface-border', '--ff-text-primary', '--ff-text-muted',
  '--ff-typing-upcoming', '--ff-typing-correct', '--ff-typing-error', '--ff-typing-error-background',
  '--ff-typing-caret', '--ff-typing-selection', '--ff-chart-grid', '--ff-chart-speed',
  '--ff-chart-gross-speed', '--ff-chart-accuracy', '--ff-chart-activity-0', '--ff-chart-activity-1',
  '--ff-chart-activity-2', '--ff-chart-activity-3', '--ff-chart-activity-4', '--ff-duration-caret',
  '--ff-duration-completion', '--ff-easing-standard',
] as const;
export type CanvasThemeToken = (typeof CANVAS_THEME_TOKENS)[number];
export type CanvasThemeSnapshot = Readonly<Record<CanvasThemeToken, string>> & { resolvedTheme: ResolvedTheme; reducedMotion: boolean };

interface MediaQueryLike { matches: boolean; addEventListener(type: 'change', listener: () => void): void; removeEventListener(type: 'change', listener: () => void): void }
export interface ThemeControllerEnvironment { root: HTMLElement; storage?: Pick<Storage, 'getItem' | 'setItem'> | null; matchMedia(query: string): MediaQueryLike; computedStyle(element: Element): CSSStyleDeclaration }

export class ThemeController {
  private themePreference: ThemePreference = 'system';
  private motionPreference: MotionPreference = 'system';
  private snapshot: CanvasThemeSnapshot | null = null;
  private readonly listeners = new Set<(snapshot: CanvasThemeSnapshot) => void>();
  private readonly darkQuery: MediaQueryLike;
  private readonly motionQuery: MediaQueryLike;
  private readonly onSystemChange = () => this.applyResolved();

  constructor(private readonly environment: ThemeControllerEnvironment) {
    this.darkQuery = environment.matchMedia('(prefers-color-scheme: dark)');
    this.motionQuery = environment.matchMedia('(prefers-reduced-motion: reduce)');
    this.darkQuery.addEventListener('change', this.onSystemChange);
    this.motionQuery.addEventListener('change', this.onSystemChange);
    this.applyResolved();
  }
  static browser(root: HTMLElement = document.documentElement): ThemeController {
    return new ThemeController({ root, storage: typeof localStorage === 'undefined' ? null : localStorage,
      matchMedia: (query) => window.matchMedia(query), computedStyle: (element) => getComputedStyle(element) });
  }
  applySettings(settings: Pick<ProfileSettings, 'themePreference' | 'motion'>): CanvasThemeSnapshot {
    this.themePreference = settings.themePreference;
    this.motionPreference = settings.motion;
    return this.applyResolved();
  }
  getSnapshot(): CanvasThemeSnapshot { return this.snapshot ?? this.applyResolved(); }
  subscribe(listener: (snapshot: CanvasThemeSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener);
  }
  destroy(): void {
    this.darkQuery.removeEventListener('change', this.onSystemChange);
    this.motionQuery.removeEventListener('change', this.onSystemChange);
    this.listeners.clear();
  }
  private applyResolved(): CanvasThemeSnapshot {
    const resolvedTheme: ResolvedTheme = this.themePreference === 'system'
      ? (this.darkQuery.matches ? 'dark' : 'light')
      : this.themePreference;
    const reducedMotion = this.motionPreference === 'reduced' || (this.motionPreference === 'system' && this.motionQuery.matches);
    if (this.snapshot?.resolvedTheme === resolvedTheme && this.snapshot.reducedMotion === reducedMotion) return this.snapshot;
    this.environment.root.dataset.ffTheme = resolvedTheme;
    this.environment.root.dataset.ffMotion = reducedMotion ? 'reduced' : 'full';
    try { this.environment.storage?.setItem(THEME_HINT_KEY, resolvedTheme); } catch { /* optional hint */ }
    const styles = this.environment.computedStyle(this.environment.root);
    const values = Object.fromEntries(CANVAS_THEME_TOKENS.map((token) => [token, styles.getPropertyValue(token).trim()])) as Record<CanvasThemeToken, string>;
    this.snapshot = Object.freeze({ ...values, resolvedTheme, reducedMotion });
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }
}
