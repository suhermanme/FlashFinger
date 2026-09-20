import type {
  LessonProgress,
  Profile,
  SessionDaySlice,
  SessionRecord,
} from '../../../src/contracts/models';
import type { LessonEvaluation } from '../../../src/contracts/training';

export const PROFILE_A_ID = '11111111-1111-4111-8111-111111111111';
export const PROFILE_B_ID = '22222222-2222-4222-8222-222222222222';
export const COMPLETED_SESSION_ID = '33333333-3333-4333-8333-333333333333';
export const INTERRUPTED_SESSION_ID = '44444444-4444-4444-8444-444444444444';
export const FAILED_LESSON_SESSION_ID = '55555555-5555-4555-8555-555555555555';
export const MIDNIGHT_SESSION_ID = '66666666-6666-4666-8666-666666666666';

const practiceDefaults = {
  tier: 'beginner',
  termination: { kind: 'timed', seconds: 60 },
  punctuation: false,
  capitalization: false,
  seed: 'fixture-seed',
  correctionPolicy: 'advance',
  keyFilter: null,
  configVersion: 1,
} as const;

export const profileA = {
  id: PROFILE_A_ID,
  name: 'Ayu',
  avatarToken: 'sunrise',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  analyticsZone: 'Asia/Jakarta',
  settings: {
    themePreference: 'system',
    soundProfileId: 'soft',
    volume: 0.6,
    muted: false,
    motion: 'system',
    fontSizePx: 24,
    keyboardLayout: 'us-qwerty',
    showKeyboard: true,
    practiceDefaults,
  },
  revision: 3,
} satisfies Profile;

export const profileB = {
  id: PROFILE_B_ID,
  name: 'Morgan',
  avatarToken: 'comet',
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
  analyticsZone: 'America/New_York',
  settings: {
    themePreference: 'dark',
    soundProfileId: 'muted',
    volume: 0,
    muted: true,
    motion: 'reduced',
    fontSizePx: 20,
    keyboardLayout: 'us-qwerty',
    showKeyboard: false,
    practiceDefaults: {
      ...practiceDefaults,
      tier: 'mixed',
      termination: { kind: 'words', count: 50 },
      seed: 'fixture-seed-b',
    },
  },
  revision: 1,
} satisfies Profile;

export const profiles = [profileA, profileB] satisfies Profile[];

export const completedSession = {
  id: COMPLETED_SESSION_ID,
  profileId: PROFILE_A_ID,
  config: {
    mode: 'practice',
    correctionPolicy: 'advance',
    durationLimitMs: 60_000,
    targetLength: null,
    sourceRef: 'dictionary:beginner',
    contentVersion: 'ff-english-10k-v1',
    metricVersion: 1,
    layout: 'us-qwerty',
    compatibilityInput: false,
    heldKeyRepeat: 'ignored',
  },
  startedAt: '2026-09-18T10:00:00.000Z',
  endedAt: '2026-09-18T10:01:00.000Z',
  analyticsZone: 'Asia/Jakarta',
  status: 'completed',
  activeMs: 60_000,
  attempts: 300,
  correctAttempts: 285,
  errorAttempts: 15,
  backspaces: 12,
  retainedCorrect: 270,
  retainedErrors: 3,
  completedWords: 48,
  grossCpm: 300,
  adjustedWpm: 54,
  accuracy: 95,
  eligibleForBest: true,
  seed: 'completed-seed',
} satisfies SessionRecord;

export const interruptedSession = {
  id: INTERRUPTED_SESSION_ID,
  profileId: PROFILE_B_ID,
  config: {
    mode: 'practice',
    correctionPolicy: 'advance',
    durationLimitMs: null,
    targetLength: null,
    sourceRef: 'dictionary:mixed',
    contentVersion: 'ff-english-10k-v1',
    metricVersion: 1,
    layout: 'us-qwerty',
    compatibilityInput: false,
    heldKeyRepeat: 'ignored',
  },
  startedAt: '2026-09-19T13:00:00.000Z',
  endedAt: '2026-09-19T13:00:20.000Z',
  analyticsZone: 'America/New_York',
  status: 'interrupted',
  activeMs: 15_000,
  attempts: 50,
  correctAttempts: 45,
  errorAttempts: 5,
  backspaces: 3,
  retainedCorrect: 42,
  retainedErrors: 2,
  completedWords: 7,
  grossCpm: 200,
  adjustedWpm: 33.6,
  accuracy: 90,
  eligibleForBest: false,
  seed: 'interrupted-seed',
} satisfies SessionRecord;

export const failedLessonSession = {
  id: FAILED_LESSON_SESSION_ID,
  profileId: PROFILE_A_ID,
  config: {
    mode: 'lessons',
    correctionPolicy: 'strict',
    durationLimitMs: null,
    targetLength: 100,
    sourceRef: 'ff-home-row-1',
    contentVersion: 'ff-curriculum-v1',
    metricVersion: 1,
    layout: 'us-qwerty',
    compatibilityInput: false,
    heldKeyRepeat: 'ignored',
  },
  startedAt: '2026-09-19T09:00:00.000Z',
  endedAt: '2026-09-19T09:01:00.000Z',
  analyticsZone: 'Asia/Jakarta',
  status: 'completed',
  activeMs: 60_000,
  attempts: 100,
  correctAttempts: 80,
  errorAttempts: 20,
  backspaces: 5,
  retainedCorrect: 78,
  retainedErrors: 0,
  completedWords: 12,
  grossCpm: 100,
  adjustedWpm: 15.6,
  accuracy: 80,
  eligibleForBest: false,
  seed: null,
} satisfies SessionRecord;

export const failedLessonProgress = {
  profileId: PROFILE_A_ID,
  lessonId: 'ff-home-row-1',
  curriculumVersion: 'ff-curriculum-v1',
  attemptCount: 1,
  passCount: 0,
  bestWpm: null,
  bestAccuracy: null,
  lastAttemptAt: failedLessonSession.endedAt,
  masteredAt: null,
  qualifyingSessionIds: [],
} satisfies LessonProgress;

export const failedLessonEvaluation = {
  qualifies: false,
  criteria: [
    { id: 'accuracy', label: 'Accuracy at least 90%', met: false, detail: '80.0% is below 90.0%' },
    { id: 'speed', label: 'Adjusted WPM at least 20', met: false, detail: '15.6 WPM is below 20.0 WPM' },
  ],
} satisfies LessonEvaluation;

export const failedLesson = {
  session: failedLessonSession,
  progress: failedLessonProgress,
  evaluation: failedLessonEvaluation,
};

export const midnightSession = {
  id: MIDNIGHT_SESSION_ID,
  profileId: PROFILE_A_ID,
  config: {
    mode: 'practice',
    correctionPolicy: 'advance',
    durationLimitMs: 120_000,
    targetLength: null,
    sourceRef: 'dictionary:intermediate',
    contentVersion: 'ff-english-10k-v1',
    metricVersion: 1,
    layout: 'us-qwerty',
    compatibilityInput: false,
    heldKeyRepeat: 'ignored',
  },
  startedAt: '2026-09-20T16:59:30.000Z',
  endedAt: '2026-09-20T17:01:30.000Z',
  analyticsZone: 'Asia/Jakarta',
  status: 'completed',
  activeMs: 120_000,
  attempts: 400,
  correctAttempts: 380,
  errorAttempts: 20,
  backspaces: 10,
  retainedCorrect: 370,
  retainedErrors: 4,
  completedWords: 64,
  grossCpm: 200,
  adjustedWpm: 37,
  accuracy: 95,
  eligibleForBest: true,
  seed: 'midnight-seed',
} satisfies SessionRecord;

export const midnightSessionDaySlices = [
  {
    sessionId: MIDNIGHT_SESSION_ID,
    profileId: PROFILE_A_ID,
    day: '2026-09-20',
    zone: 'Asia/Jakarta',
    activeMs: 30_000,
    attempts: 100,
    correctAttempts: 95,
    errorAttempts: 5,
    completedWords: 16,
    eligibleActiveMs: 30_000,
    eligibleRetainedCorrect: 90,
  },
  {
    sessionId: MIDNIGHT_SESSION_ID,
    profileId: PROFILE_A_ID,
    day: '2026-09-21',
    zone: 'Asia/Jakarta',
    activeMs: 90_000,
    attempts: 300,
    correctAttempts: 285,
    errorAttempts: 15,
    completedWords: 48,
    eligibleActiveMs: 90_000,
    eligibleRetainedCorrect: 280,
  },
] satisfies SessionDaySlice[];

export const emptyHistory = [] satisfies SessionRecord[];

export const sessions = [
  completedSession,
  interruptedSession,
  failedLessonSession,
  midnightSession,
] satisfies SessionRecord[];
