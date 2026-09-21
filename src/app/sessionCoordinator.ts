import type {
  ActiveCheckpoint,
  CharacterExposure,
  LessonProgress,
  MistakeBucket,
  ProfileId,
  SessionConfig,
  SessionDaySlice,
  SessionRecord,
  SessionStatus,
} from '../contracts/models.js';
import type {
  CommitOutcome,
  Repository,
  RepositoryError,
  RepositoryResult,
  SessionCommit,
} from '../contracts/repository.js';
import { validateSessionConfig } from '../contracts/validation.js';
import type { TrainingSource } from '../contracts/training.js';
import type { LessonEvaluation } from '../contracts/training.js';
import { calculateMetrics } from '../domain/metrics/formulas.js';
import {
  buildDaySlices,
  buildSessionRecord,
  calendarDayAt,
  mergeDailyAggregate,
  nextCalendarDay,
  snapshotFromCheckpoint,
  type DayCounterDraft,
} from '../domain/metrics/sessionSummary.js';
import { deriveLessonProgress } from '../domain/training/progression.js';
import { TypingEngine } from '../domain/typing/engine.js';
import type { EngineCommand, EngineDelta, EngineSnapshot, EngineState } from '../domain/typing/types.js';
import type { InputEngine } from '../features/typing/inputAdapter.js';
import type { RuntimeStore } from '../state/runtime.js';

export const CHECKPOINT_INTERVAL_MS = 5_000;

export type SessionCoordinatorPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'running'
  | 'paused'
  | 'finalizing'
  | 'save-failed'
  | 'completed'
  | 'aborted'
  | 'interrupted';

export interface DurableSessionResult {
  session: SessionRecord;
  saved: boolean;
  alreadyCommitted: boolean;
  error: RepositoryError | null;
  lessonEvaluation: LessonEvaluation | null;
  highErrorKeys: string[];
}

export interface SessionCoordinatorSnapshot {
  phase: SessionCoordinatorPhase;
  engineState: EngineState;
  sessionId: string;
  metrics: ReturnType<typeof calculateMetrics> & { activeMs: number; attempts: number; correctAttempts: number };
  result: DurableSessionResult | null;
  checkpointError: RepositoryError | null;
}

export interface SessionCoordinatorOptions {
  repository: Repository;
  runtime: RuntimeStore;
  profileId: ProfileId;
  analyticsZone: string;
  source: TrainingSource;
  config: SessionConfig;
  monotonicNow?: () => number;
  wallNow?: () => number;
  randomUUID?: () => string;
  queueTask?: (callback: () => void) => void;
}

interface MutableDayCounter extends DayCounterDraft {}
interface PositionAttribution { day: string; correct: boolean }
interface PendingDraft {
  session: SessionRecord;
  slices: SessionDaySlice[];
  mistakes: MistakeBucket[];
  exposures: CharacterExposure[];
  lessonEvaluation: LessonEvaluation | null;
  highErrorKeys: string[];
}

interface OwnershipRepository {
  acquireSessionOwnership(profileId: ProfileId): Promise<RepositoryResult<unknown>>;
  releaseSessionOwnership(token: unknown): Promise<RepositoryResult<void>>;
}

function ownershipRepository(repository: Repository): OwnershipRepository | null {
  const candidate = repository as Repository & Partial<OwnershipRepository>;
  return typeof candidate.acquireSessionOwnership === 'function' && typeof candidate.releaseSessionOwnership === 'function'
    ? candidate as OwnershipRepository
    : null;
}

function rejected(error: RepositoryError): RepositoryResult<CommitOutcome> {
  return { ok: false, error };
}

function unavailable(message: string): RepositoryError {
  return { code: 'unavailable', message, retryable: true };
}

function segment(text: string): string[] {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
}

function materializeSource(source: TrainingSource): { text: string; graphemes: string[] } {
  if (source.graphemeCount === null) throw new Error('M11 requires a fixed prepared TrainingSource');
  if (!Number.isSafeInteger(source.graphemeCount) || source.graphemeCount <= 0) {
    throw new Error('Prepared source must contain at least one grapheme');
  }
  if (!Number.isSafeInteger(source.chunkSize) || source.chunkSize <= 0) {
    throw new Error('Prepared source chunk size must be a positive safe integer');
  }
  const chunks: string[] = [];
  const count = Math.ceil(source.graphemeCount / source.chunkSize);
  for (let index = 0; index < count; index += 1) {
    const chunk = source.chunkAt(index);
    if (chunk === null) throw new Error(`Prepared source is missing chunk ${index}`);
    chunks.push(chunk);
  }
  const graphemes = segment(chunks.join('')).slice(0, source.graphemeCount);
  if (graphemes.length !== source.graphemeCount) throw new Error('Prepared source grapheme count does not match its contract');
  return { text: graphemes.join(''), graphemes };
}

function token(grapheme: string): string {
  if (grapheme === ' ') return 'space';
  if (grapheme === '\n') return 'newline';
  if (grapheme === '\t') return 'tab';
  return grapheme;
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
  };
  freeze(cloned);
  return cloned;
}

export class SessionCoordinator implements InputEngine {
  readonly sessionId: string;
  readonly targetText: string;
  readonly config: SessionConfig;

  private readonly engine: TypingEngine;
  private readonly targetGraphemes: string[];
  private readonly listeners = new Set<() => void>();
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;
  private readonly queueTask: (callback: () => void) => void;
  private view: SessionCoordinatorSnapshot;
  private startedAtMs: number | null = null;
  private voluntarilyPaused = false;
  private finalization: Promise<RepositoryResult<CommitOutcome>> | null = null;
  private pendingDraft: PendingDraft | null = null;
  private pendingCommit: SessionCommit | null = null;

  private readonly days = new Map<string, MutableDayCounter>();
  private readonly positions = new Map<number, PositionAttribution>();
  private readonly exposureCounts = new Map<string, { attempts: number; errors: number }>();
  private readonly mistakeCounts = new Map<string, { expected: string; attempted: string; count: number }>();
  private lastObservedActiveMs = 0;
  private lastObservedCompletedWords = 0;
  private lastObservedWallMs: number | null = null;

  private lastCheckpointActiveMs = 0;
  private queuedCheckpoint: ActiveCheckpoint | null = null;
  private checkpointScheduled = false;
  private checkpointWrite: Promise<void> = Promise.resolve();
  private finalizing = false;
  private ownershipToken: unknown = null;
  private preparation: Promise<RepositoryResult<void>> | null = null;

  constructor(private readonly options: SessionCoordinatorOptions) {
    const configResult = validateSessionConfig(options.config);
    if (!configResult.valid) throw new Error(`Invalid session config: ${configResult.errors[0]?.message ?? 'unknown error'}`);
    if (options.source.id !== options.config.sourceRef || options.source.version !== options.config.contentVersion) {
      throw new Error('Session config source identity does not match the prepared TrainingSource');
    }
    if (options.source.mode !== options.config.mode || options.source.correctionPolicy !== options.config.correctionPolicy) {
      throw new Error('Session config mode/correction policy does not match the prepared TrainingSource');
    }
    const rule = options.source.termination;
    if (rule.kind === 'duration' && options.config.durationLimitMs !== rule.durationMs) {
      throw new Error('Timed source duration does not match the immutable session config');
    }
    if (rule.kind !== 'duration' && options.config.durationLimitMs !== null) {
      throw new Error('Only a timed source may have a duration limit');
    }
    if (rule.kind === 'complete-target' && options.config.targetLength !== options.source.graphemeCount) {
      throw new Error('Complete-target source length does not match the immutable session config');
    }

    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.queueTask = options.queueTask ?? queueMicrotask;
    this.sessionId = (options.randomUUID ?? (() => crypto.randomUUID()))();
    this.config = cloneAndFreeze(options.config);
    const materialized = materializeSource(options.source);
    this.targetText = materialized.text;
    this.targetGraphemes = materialized.graphemes;
    this.engine = new TypingEngine({
      targetText: this.targetText,
      correctionPolicy: options.source.correctionPolicy,
      termination: options.source.termination,
      eligibility: options.source.eligibility,
      generationState: null,
      baseNowMs: this.monotonicNow(),
    });
    this.view = this.makeView('idle', null, null);
  }

  prepare(): Promise<RepositoryResult<void>> {
    if (this.preparation) return this.preparation;
    this.preparation = this.prepareInternal();
    return this.preparation;
  }

  private async prepareInternal(): Promise<RepositoryResult<void>> {
    if (this.engine.getState() !== 'idle') return { ok: true, value: undefined };
    this.options.runtime.setSession(this.sessionId, 'preparing');
    this.updateView('preparing');
    const ownership = ownershipRepository(this.options.repository);
    if (ownership) {
      const acquired = await ownership.acquireSessionOwnership(this.options.profileId);
      if (!acquired.ok) {
        this.options.runtime.setSession(null, 'idle');
        this.view = { ...this.view, phase: 'idle', checkpointError: acquired.error };
        this.emit();
        this.preparation = null;
        return acquired;
      }
      this.ownershipToken = acquired.value;
    }
    this.engine.transitionToPreparing();
    this.engine.transitionToReady();
    this.options.runtime.setSession(this.sessionId, 'ready');
    this.updateView('ready');
    return { ok: true, value: undefined };
  }

  getState(): EngineState { return this.engine.getState(); }
  getSnapshot = (): SessionCoordinatorSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  processCommand(command: EngineCommand): EngineDelta[] {
    if (this.finalizing) return [{ kind: 'rejected', reason: 'not-editable' }];
    const wallAtCommand = this.wallNow();
    const wasReady = this.engine.getState() === 'ready';
    if (wasReady && command.kind === 'character') {
      this.startedAtMs = wallAtCommand;
      this.engine.synchronizeStart(this.monotonicNow());
      this.options.runtime.setSession(this.sessionId, 'running');
      this.updateView('running');
    }

    if (command.kind !== 'clock') {
      this.engine.processCommand({ kind: 'clock', nowMs: this.monotonicNow() });
    }
    const deltas = this.engine.processCommand(command);
    const snapshot = this.engine.takeSnapshot();
    this.observe(command, deltas, snapshot, wallAtCommand);
    this.publishRuntime(snapshot);

    if (command.kind === 'pause' && this.engine.getState() === 'paused') {
      this.options.runtime.setSession(this.sessionId, 'paused');
      this.updateView('paused');
      this.maybeQueueCheckpoint(snapshot, wallAtCommand, true);
    } else if (command.kind === 'pause' && this.engine.getState() === 'running') {
      this.options.runtime.setSession(this.sessionId, 'running');
      this.updateView('running');
    } else {
      this.maybeQueueCheckpoint(snapshot, wallAtCommand, false);
    }

    if (this.shouldComplete(snapshot)) {
      deltas.push(...this.beginFinalization('completed', wallAtCommand));
    }
    return deltas;
  }

  pause(voluntary = true): void {
    if (this.engine.getState() !== 'running') return;
    if (voluntary) this.voluntarilyPaused = true;
    this.processCommand({ kind: 'pause' });
  }

  resume(): void {
    if (this.engine.getState() === 'paused') this.processCommand({ kind: 'pause' });
  }

  tick(nowMs = this.monotonicNow()): EngineDelta[] {
    return this.processCommand({ kind: 'clock', nowMs });
  }

  async finish(status: SessionStatus = 'aborted'): Promise<RepositoryResult<CommitOutcome>> {
    if (!this.finalizing) {
      if (this.engine.getState() === 'running' || this.engine.getState() === 'paused') {
        this.engine.processCommand({ kind: 'clock', nowMs: this.monotonicNow() });
      }
      this.beginFinalization(status, this.wallNow());
    }
    return this.finalization ?? rejected(unavailable('Session finalization did not start'));
  }

  async retrySave(): Promise<RepositoryResult<CommitOutcome>> {
    if (this.view.phase === 'finalizing' && this.finalization) return this.finalization;
    if (!this.pendingDraft || this.view.result?.saved) return rejected(unavailable('No unsaved result is available'));
    this.updateView('finalizing', this.view.result ? { ...this.view.result, error: null } : null);
    this.options.runtime.setSession(this.sessionId, 'finalizing');
    this.finalization = this.persistPending();
    return this.finalization;
  }

  async discardUnsavedResult(): Promise<void> {
    if (this.view.result?.saved !== false) return;
    this.pendingCommit = null;
    this.pendingDraft = null;
    this.options.runtime.setPendingResult(null);
    await this.releaseOwnership();
    this.updateView(this.view.result.session.status, null);
  }

  async findInterruptedCheckpoint(): Promise<RepositoryResult<ActiveCheckpoint | null>> {
    return this.options.repository.findLatestCheckpoint(this.options.profileId);
  }

  async resolveInterruptedCheckpoint(
    checkpoint: ActiveCheckpoint,
    decision: 'keep' | 'discard',
  ): Promise<RepositoryResult<CommitOutcome | null>> {
    if (checkpoint.profileId !== this.options.profileId) {
      return { ok: false, error: { code: 'invalid', message: 'Checkpoint belongs to another profile', retryable: false } };
    }
    if (decision === 'discard') {
      const removed = await this.options.repository.deleteCheckpoint(checkpoint.sessionId);
      return removed.ok ? { ok: true, value: null } : removed;
    }

    const snapshot = snapshotFromCheckpoint(checkpoint);
    const endedAtMs = Date.parse(checkpoint.checkpointAt);
    const session = buildSessionRecord({
      sessionId: checkpoint.sessionId,
      profileId: checkpoint.profileId,
      config: checkpoint.config,
      analyticsZone: this.options.analyticsZone,
      status: 'interrupted',
      startedAt: new Date(Math.max(0, endedAtMs - checkpoint.activeMs)).toISOString(),
      endedAt: checkpoint.checkpointAt,
      snapshot,
      eligibility: this.options.source.eligibility,
      voluntarilyPaused: false,
      seed: checkpoint.generationState,
    });
    const slices = buildDaySlices(session, []);
    const aggregates = await this.buildAggregateChanges(session, slices);
    if (!aggregates.ok) return aggregates;
    const result = await this.options.repository.commitSession({
      session,
      daySlices: slices,
      mistakes: [],
      exposures: [],
      aggregateChanges: aggregates.value,
      updateProfileCharacterStats: false,
      removeCheckpointId: checkpoint.sessionId,
    });
    if (result.ok) {
      this.options.runtime.setPendingResult({ sessionId: checkpoint.sessionId, saved: true });
      this.updateView('interrupted', { session, saved: true, alreadyCommitted: result.value.alreadyCommitted,
        error: null, lessonEvaluation: null, highErrorKeys: [] });
    }
    return result;
  }

  async flushCheckpointWrites(): Promise<void> {
    await this.checkpointWrite;
  }

  private beginFinalization(status: SessionStatus, endedAtMs: number): EngineDelta[] {
    if (this.finalizing) return [];
    this.finalizing = true;
    this.queuedCheckpoint = null;
    const deltas = this.engine.finalize(status);
    const snapshot = this.engine.takeSnapshot();
    this.observe({ kind: 'clock', nowMs: this.monotonicNow() }, [], snapshot, endedAtMs);
    const startedAtMs = this.startedAtMs ?? endedAtMs;
    const session = buildSessionRecord({
      sessionId: this.sessionId,
      profileId: this.options.profileId,
      config: this.config,
      analyticsZone: this.options.analyticsZone,
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      snapshot,
      eligibility: this.options.source.eligibility,
      voluntarilyPaused: this.voluntarilyPaused,
      seed: snapshot.generationState,
    });
    const slices = buildDaySlices(session, [...this.days.values()].sort((left, right) => left.day.localeCompare(right.day)));
    const lessonEvaluation = this.options.source.progressEvaluator?.evaluate(session, {
      voluntarilyPaused: this.voluntarilyPaused,
    }) ?? null;
    const highErrorKeys = [...this.exposureCounts.entries()]
      .filter(([, counts]) => counts.errors > 0)
      .sort((left, right) => (right[1].errors / right[1].attempts) - (left[1].errors / left[1].attempts)
        || right[1].errors - left[1].errors || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([expected]) => expected);
    this.pendingDraft = {
      session,
      slices,
      mistakes: [...this.mistakeCounts.values()].map((item) => ({
        profileId: session.profileId,
        sessionId: session.id,
        expected: item.expected,
        attempted: item.attempted,
        count: item.count,
      })),
      exposures: [...this.exposureCounts.entries()].map(([expected, counts]) => ({
        profileId: session.profileId,
        sessionId: session.id,
        expected,
        attempts: counts.attempts,
        errors: counts.errors,
      })),
      lessonEvaluation,
      highErrorKeys,
    };
    this.options.runtime.setSession(this.sessionId, 'finalizing');
    this.options.runtime.setPendingResult({ sessionId: this.sessionId, saved: false });
    this.updateView('finalizing', {
      session, saved: false, alreadyCommitted: false, error: null, lessonEvaluation, highErrorKeys,
    });
    this.finalization = this.persistPending();
    return deltas;
  }

  private async persistPending(): Promise<RepositoryResult<CommitOutcome>> {
    await this.checkpointWrite;
    const draft = this.pendingDraft;
    if (!draft) return rejected(unavailable('Finalized session draft is missing'));
    if (!this.pendingCommit) {
      const aggregates = await this.buildAggregateChanges(draft.session, draft.slices);
      if (!aggregates.ok) return this.handleSaveFailure(aggregates.error);
      const lessonProgress = await this.buildLessonProgressChanges(draft.session, draft.lessonEvaluation);
      if (!lessonProgress.ok) return this.handleSaveFailure(lessonProgress.error);
      this.pendingCommit = {
        session: draft.session,
        daySlices: draft.slices,
        mistakes: draft.mistakes,
        exposures: draft.exposures,
        lessonProgress: lessonProgress.value.length > 0 ? lessonProgress.value : undefined,
        aggregateChanges: aggregates.value,
        updateProfileCharacterStats: true,
        removeCheckpointId: draft.session.id,
      };
    }
    const result = await this.options.repository.commitSession(this.pendingCommit);
    if (!result.ok) return this.handleSaveFailure(result.error);

    const phase = draft.session.status;
    this.options.runtime.setPendingResult({ sessionId: draft.session.id, saved: true });
    this.options.runtime.setSession(draft.session.id, phase);
    this.updateView(phase, {
      session: draft.session,
      saved: true,
      alreadyCommitted: result.value.alreadyCommitted,
      error: null,
      lessonEvaluation: draft.lessonEvaluation,
      highErrorKeys: draft.highErrorKeys,
    });
    this.pendingCommit = null;
    this.pendingDraft = null;
    await this.releaseOwnership();
    return result;
  }

  private handleSaveFailure(error: RepositoryError): RepositoryResult<CommitOutcome> {
    const result = this.view.result;
    this.options.runtime.setPendingResult({ sessionId: this.sessionId, saved: false });
    this.options.runtime.setSession(this.sessionId, this.pendingDraft?.session.status ?? 'completed');
    this.updateView('save-failed', result ? { ...result, saved: false, error } : null);
    return { ok: false, error };
  }

  private async buildAggregateChanges(session: SessionRecord, slices: SessionDaySlice[]) {
    const changes = [];
    for (const slice of slices) {
      const existing = await this.options.repository.getDailyAggregates(session.profileId, slice.day, nextCalendarDay(slice.day));
      if (!existing.ok) return existing;
      const row = existing.value.find((item) => item.day === slice.day && item.zone === slice.zone
        && item.metricVersion === session.config.metricVersion);
      changes.push(mergeDailyAggregate(row, session, slice));
    }
    return { ok: true as const, value: changes };
  }

  private async buildLessonProgressChanges(
    session: SessionRecord,
    evaluation: LessonEvaluation | null,
  ): Promise<RepositoryResult<LessonProgress[]>> {
    const evaluator = this.options.source.progressEvaluator;
    if (!evaluator || !evaluation) return { ok: true, value: [] };
    const loaded = await this.options.repository.getLessonProgress(session.profileId, session.config.contentVersion);
    if (!loaded.ok) return loaded;
    const existing = loaded.value.find((item) => item.lessonId === evaluator.lessonId);
    const recent: SessionRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.options.repository.querySessions({
        profileId: session.profileId,
        mode: 'lessons',
        includeIneligible: true,
        limit: 200,
        cursor,
      });
      if (!page.ok) return page;
      for (const item of page.value.sessions) {
        if (item.id !== session.id && item.status === 'completed'
          && item.config.sourceRef === evaluator.lessonId
          && item.config.contentVersion === session.config.contentVersion) recent.push(item);
        if (recent.length >= 3) break;
      }
      cursor = page.value.nextCursor;
    } while (recent.length < 3 && cursor !== null);
    return { ok: true, value: [deriveLessonProgress({
      definition: evaluator.definition,
      existing,
      session,
      evaluation,
      recentCompletedSessions: recent,
    })] };
  }

  private observe(command: EngineCommand, deltas: readonly EngineDelta[], snapshot: EngineSnapshot, wallMs: number): void {
    if (this.startedAtMs === null) return;
    const day = calendarDayAt(wallMs, this.options.analyticsZone);
    const row = this.day(day);
    const activeDelta = snapshot.activeElapsedMs - this.lastObservedActiveMs;
    if (activeDelta > 0) this.attributeActiveTime(this.lastObservedWallMs ?? wallMs, wallMs, activeDelta);
    this.lastObservedActiveMs = snapshot.activeElapsedMs;
    this.lastObservedWallMs = wallMs;

    for (const delta of deltas) {
      if (delta.kind === 'accepted') {
        const prior = this.positions.get(delta.position);
        if (prior?.correct) this.day(prior.day).retainedCorrect -= 1;
        this.positions.set(delta.position, { day, correct: delta.correct });
        row.attempts += 1;
        if (delta.correct) { row.correctAttempts += 1; row.retainedCorrect += 1; } else row.errorAttempts += 1;

        const expected = token(this.targetGraphemes[delta.position] ?? '');
        const attempted = token(delta.grapheme);
        const exposure = this.exposureCounts.get(expected) ?? { attempts: 0, errors: 0 };
        exposure.attempts += 1;
        if (!delta.correct) exposure.errors += 1;
        this.exposureCounts.set(expected, exposure);
        if (!delta.correct) {
          const key = JSON.stringify([expected, attempted]);
          const mistake = this.mistakeCounts.get(key) ?? { expected, attempted, count: 0 };
          mistake.count += 1;
          this.mistakeCounts.set(key, mistake);
        }
      }
      if (delta.kind === 'corrected') {
        const prior = this.positions.get(delta.position);
        if (prior?.correct) this.day(prior.day).retainedCorrect -= 1;
        this.positions.delete(delta.position);
      }
    }
    const completedDelta = snapshot.completedWords - this.lastObservedCompletedWords;
    if (completedDelta !== 0) row.completedWords += completedDelta;
    this.lastObservedCompletedWords = snapshot.completedWords;
    void command;
  }

  private day(day: string): MutableDayCounter {
    let value = this.days.get(day);
    if (!value) {
      value = { day, activeMs: 0, attempts: 0, correctAttempts: 0, errorAttempts: 0, completedWords: 0, retainedCorrect: 0 };
      this.days.set(day, value);
    }
    return value;
  }

  private attributeActiveTime(fromMs: number, toMs: number, activeMs: number): void {
    if (toMs <= fromMs) {
      this.day(calendarDayAt(toMs, this.options.analyticsZone)).activeMs += activeMs;
      return;
    }
    const totalWallMs = toMs - fromMs;
    let cursor = fromMs;
    let allocated = 0;
    while (cursor < toMs) {
      const day = calendarDayAt(cursor, this.options.analyticsZone);
      let probe = Math.min(toMs, cursor + 6 * 60 * 60 * 1_000);
      while (probe < toMs && calendarDayAt(probe, this.options.analyticsZone) === day) {
        probe = Math.min(toMs, probe + 6 * 60 * 60 * 1_000);
      }
      let boundary = toMs;
      if (calendarDayAt(probe, this.options.analyticsZone) !== day) {
        let low = cursor;
        let high = probe;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (calendarDayAt(middle, this.options.analyticsZone) === day) low = middle;
          else high = middle;
        }
        boundary = high;
      }
      const isLast = boundary >= toMs;
      const portion = isLast ? activeMs - allocated : activeMs * (boundary - cursor) / totalWallMs;
      this.day(day).activeMs += portion;
      allocated += portion;
      cursor = boundary;
    }
  }

  private shouldComplete(snapshot: EngineSnapshot): boolean {
    const rule = this.options.source.termination;
    if (rule.kind === 'complete-target') return snapshot.textCursor >= this.targetGraphemes.length;
    if (rule.kind === 'duration') return snapshot.activeElapsedMs >= rule.durationMs;
    if (rule.kind === 'word-target') return snapshot.completedWords >= rule.wordCount;
    return false;
  }

  private publishRuntime(snapshot: EngineSnapshot): void {
    const metrics = calculateMetrics({
      activeMs: snapshot.activeElapsedMs,
      attempts: snapshot.attempts,
      correctAttempts: snapshot.correctAttempts,
      errorAttempts: snapshot.errorAttempts,
      backspaces: snapshot.backspaces,
      retainedCorrect: snapshot.retainedCorrect,
      retainedErrors: snapshot.retainedErrors,
      completedWords: snapshot.completedWords,
    });
    this.options.runtime.publishMetrics({
      activeMs: snapshot.activeElapsedMs,
      attempts: snapshot.attempts,
      correctAttempts: snapshot.correctAttempts,
      adjustedWpm: metrics.adjustedWpm,
      accuracy: metrics.accuracy,
    }, this.monotonicNow());
    this.view = { ...this.view, metrics: { ...metrics, activeMs: snapshot.activeElapsedMs,
      attempts: snapshot.attempts, correctAttempts: snapshot.correctAttempts }, engineState: this.engine.getState() };
    this.emit();
  }

  private maybeQueueCheckpoint(snapshot: EngineSnapshot, wallMs: number, force: boolean): void {
    if (this.finalizing || this.startedAtMs === null) return;
    if (!force && snapshot.activeElapsedMs - this.lastCheckpointActiveMs < CHECKPOINT_INTERVAL_MS) return;
    this.lastCheckpointActiveMs = snapshot.activeElapsedMs;
    this.queuedCheckpoint = {
      sessionId: this.sessionId,
      profileId: this.options.profileId,
      config: structuredClone(this.config),
      checkpointAt: new Date(wallMs).toISOString(),
      lastSequence: snapshot.sequence,
      activeMs: snapshot.activeElapsedMs,
      counts: {
        attempts: snapshot.attempts,
        correctAttempts: snapshot.correctAttempts,
        errorAttempts: snapshot.errorAttempts,
        backspaces: snapshot.backspaces,
        retainedCorrect: snapshot.retainedCorrect,
      },
      textCursor: snapshot.textCursor,
      generationState: snapshot.generationState,
      cappedRecentEdits: snapshot.cappedRecentEdits,
    };
    if (this.checkpointScheduled) return;
    this.checkpointScheduled = true;
    this.queueTask(() => {
      this.checkpointScheduled = false;
      const checkpoint = this.queuedCheckpoint;
      this.queuedCheckpoint = null;
      if (!checkpoint || this.finalizing) return;
      this.checkpointWrite = this.checkpointWrite.then(async () => {
        const result = await this.options.repository.saveCheckpoint(checkpoint);
        if (!result.ok) {
          this.view = { ...this.view, checkpointError: result.error };
          this.emit();
        }
      });
    });
  }

  private makeView(
    phase: SessionCoordinatorPhase,
    result: DurableSessionResult | null,
    checkpointError: RepositoryError | null,
  ): SessionCoordinatorSnapshot {
    return {
      phase,
      engineState: this.engine.getState(),
      sessionId: this.sessionId,
      metrics: { ...calculateMetrics({ activeMs: 0, attempts: 0, correctAttempts: 0, errorAttempts: 0,
        backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 }), activeMs: 0, attempts: 0, correctAttempts: 0 },
      result,
      checkpointError,
    };
  }

  private updateView(phase: SessionCoordinatorPhase, result = this.view.result): void {
    this.view = { ...this.view, phase, engineState: this.engine.getState(), result };
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }

  private async releaseOwnership(): Promise<void> {
    if (this.ownershipToken === null) return;
    const ownership = ownershipRepository(this.options.repository);
    const token = this.ownershipToken;
    this.ownershipToken = null;
    if (!ownership) return;
    const result = await ownership.releaseSessionOwnership(token);
    if (!result.ok) {
      this.view = { ...this.view, checkpointError: result.error };
      this.emit();
    }
  }
}
