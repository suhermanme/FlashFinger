# FlashFinger — Design Specification

Version: 1.0 · Date: 2026-09-20 · Status: implementation baseline, feasibility gates identified

This document defines architecture, product behavior, data contracts, and future implementation tasks. It contains no functional application code. TypeScript contracts are described through field tables and named types rather than source declarations. Paths below describe future deliverables unless explicitly identified as documentation created now.

## 1. Executive Summary & Core Stack Architecture

### 1.1 Product intent and scope

FlashFinger is a private, offline typing trainer for browsers and Windows, macOS, and Linux desktops. Its primary experience is an uncluttered typing surface with immediate character feedback, tactile locally generated sound, a live speed graph, and locally retained progress. Three modes share one typing engine: sequential lessons, randomized English practice, and user-supplied text.

The aesthetic direction takes inspiration from ClickClack's typing focus and configurable sound experience. FlashFinger will use its own visual identity, curriculum, recordings, and licensed content; it will not copy proprietary assets. The reference product's listing establishes inspiration, not a feature parity commitment. [ClickClack product listing](https://apps.apple.com/us/app/clickclack-typing-trainer/id6740695697?platform=mac)

Release-one scope includes multiple local profiles, settings, lessons, practice, custom text, live metrics, history, daily activity, backup import/export, and offline installation. Cloud accounts, synchronization, online leaderboards, remote dictionaries, AI services, multiplayer, and automatic remote telemetry are outside scope. Desktop and browser data remain separate installations unless the user transfers a backup.

### 1.2 Fixed stack and responsibility boundaries

| Layer | Decision | Responsibility |
|---|---|---|
| Language and UI | TypeScript + React | Typed contracts, navigation, settings, dashboards, accessible controls |
| Build | Vite | Shared static renderer bundle, local asset references, code splitting |
| Desktop | Electron | Window lifecycle, secure local asset protocol, storage/file adapters |
| State | Zustand vanilla stores and selective React bindings | Profile/settings orchestration, low-frequency runtime snapshots |
| Styling | Tailwind CSS with semantic CSS variables | Layout, typography, palettes, motion tokens |
| Input core | Framework-independent TypeScript domain engine | Ordered edits, scoring, clocks, state transitions |
| Sound | Web Audio API | Decoded samples, gain routing, immediate triggering |
| Live rendering | Imperative DOM controllers + Canvas 2D | Character deltas, caret, bounded effects, graph |
| Browser durability | IndexedDB | Profiles, sessions, aggregates, progress, documents |
| Desktop durability | Main-process local filesystem repository | Versioned snapshot and append-only transaction journal |
| Offline web | Service worker + complete precache manifest | Local shell, assets, content, safe updates |

Pin compatible stable versions in the first implementation session and commit the lockfile. Tailwind's current CSS-first theme model is the intended baseline; do not mix configuration examples from incompatible major versions. Dependency downloads occur during development/build, never as an application runtime requirement.

### 1.3 Dual-target topology

Browser: secure static origin → service worker/cache → shared renderer → browser platform adapter → IndexedDB.

Desktop: Electron main → secure local application protocol → the exact same shared renderer artifact → narrow preload bridge → main-process repository/file operations.

Both targets run the same domain, audio, visual, curriculum, dictionary, and analytics modules. A platform factory selects the adapter once at startup by detecting the validated preload capability. Domain code never imports Electron, Node, browser database APIs, or React. A browser-compatible null capability replaces desktop-only window actions.

React owns screen composition and the stable typing host. A dedicated controller owns descendants of the active text host and the caret/effect layers. React must not reconcile those same descendants during a session. Input processing and audio remain on the renderer thread to avoid worker message latency. Workers handle custom-text preparation, dictionary preparation, and expensive historical aggregation outside the input path.

### 1.4 Planned project structure

| Future path | Ownership |
|---|---|
| `src/app/` | Startup, routes, providers, adapter selection, lifecycle |
| `src/contracts/` | Shared data models, storage API, IPC payloads, version constants |
| `src/domain/typing/` | Pure input/scoring engine, session clock, text windows |
| `src/domain/metrics/` | Formula definitions, rolling samples, daily aggregates |
| `src/domain/training/` | Curriculum progression and seeded practice generation |
| `src/state/` | Zustand app, profile, settings, and runtime stores |
| `src/platform/web/` | IndexedDB repository, file access, PWA lifecycle |
| `src/platform/desktop/` | Renderer-facing typed bridge adapter |
| `src/engines/audio/` | Sound bank loader, graph, voices, context lifecycle |
| `src/engines/visual/` | Text renderer, caret, key feedback, effects |
| `src/features/{profiles,typing,lessons,practice,custom-text,history,settings}/` | User-facing feature screens |
| `src/components/` | Shared controls, dialogs, navigation, accessibility helpers |
| `src/styles/` | Tailwind entry and semantic theme tokens |
| `src/workers/` | Text preparation and analytics messages/handlers |
| `public/content/` | Versioned dictionaries, lessons, sound/font manifests |
| `public/assets/{sounds,fonts,icons}/` | All local runtime media |
| `electron/` | Main, sandbox-compatible preload, protocol, repository |
| `tests/{unit,integration,e2e,performance,fixtures}/` | Contract, platform, interaction, and latency evidence |
| `docs/` | This specification, decisions, handoff, performance evidence |
| `dist/renderer/` | One self-contained Vite web artifact |
| `dist/electron/`, `release/` | Compiled shell and packaged desktop outputs |

Vite uses a relative asset base and hash routing so deep navigation needs no server rewrite. Workers, lazy chunks, CSS, fonts, sound samples, content manifests, icons, and the web manifest must resolve under the deployment base, including a nested browser path. Every runtime asset is enumerated in a build manifest with byte size and content hash. No remote font, analytics, image, script, API, or CDN URL is permitted in the production dependency graph. Vite documents relative base handling for relocatable builds. [Vite production build](https://vite.dev/guide/build)

Electron packages `dist/renderer` without rebuilding it with different feature flags. Its main/preload bundles are separate from Vite's renderer. Serve the renderer from a stable origin such as `flashfinger://app/` through a standard, secure custom protocol with fetch support; path resolution must reject traversal and serve only packaged renderer assets. Disable Node integration, enable context isolation and sandboxing, enforce CSP, deny unexpected navigation/new windows, and expose only explicit bridge methods with validated payloads and sender origin. Development localhost access is development-only. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol)

### 1.5 What “100% offline-first” means

All three modes, every bundled sound, every lesson, profile operations, history, and backup operations work without internet after installation. No account or network verification is involved.

A browser cannot obtain a never-installed site while disconnected. First acquisition requires either one completed secure-origin download or distribution of the static artifact with a local localhost server. Opening `index.html` directly with a file URL is not the supported PWA delivery method. Electron's installed package supports its first launch offline. Service workers require an appropriate secure origin, including localhost. [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

Web installation precaches the complete asset manifest, including lazy chunks and all sound/content packs. “Offline ready” appears only after every required response is cached and the application confirms completeness. Interrupted or quota-failed installation remains visibly incomplete and retryable. The service worker uses local cache-first reads for immutable assets and a cached shell for navigation. An update installs a new cache separately; it activates only after the active test ends, and keeps prior assets until old clients release them. A failed update leaves the prior complete version usable. Desktop disables service-worker registration because the packaged artifact already supplies assets; this avoids stale caches across desktop updates. CacheStorage is separate from profile persistence. [Using service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)

The browser may evict storage or clear it at the user's request. Request persistent storage where supported, report quota/durability status, and offer local backups. “Offline-first” cannot mean unconditionally permanent browser storage. Private browsing or denied storage results in an explicitly labeled temporary session, never a false “saved” confirmation.

### 1.6 Performance SLA, feasibility, and evidence

**Requested product target:** under 10 ms from input to audible and visible feedback. Retain this as an end-to-end qualification target, but do not claim it universally. A 60 Hz display alone has a 16.7 ms refresh interval, browser scheduling is not hard real-time, and audio device buffering can exceed 10 ms. Bluetooth audio particularly cannot be assumed to qualify. Electron does not remove those limits.

Define separate measurements:

| Measurement | Proposed qualification target | Evidence |
|---|---|---|
| Event handler entry → engine delta, audio scheduling, visual mutation queued/applied | p99 under 4 ms; zero observed samples at or above 10 ms in a defined run | Instrumented monotonic marks, ≥10,000 accepted inputs |
| Input event timestamp → handler entry | Report p50/p95/p99/max separately | Event timestamp normalized to performance time origin |
| Physical key actuation → visible feedback | Under 10 ms on explicitly qualified hardware only | Synchronized actuation/photodiode or high-speed camera setup |
| Physical key actuation → audible onset | Under 10 ms on explicitly qualified hardware only | Synchronized electrical/loopback audio measurement |
| Typing responsiveness | No app-attributable task above 50 ms in a 60-second qualification run | Performance trace, frame timing, allocation trace |

The first row is an internal engineering budget, not a substitute for the requested end-to-end SLA. Finite testing cannot prove an absolute maximum for all future inputs. If end-to-end qualification fails, document the unsupported environment and retain the failure as an unresolved product target; do not silently relabel scheduling time as audible latency.

Provisional 4 ms application budget: input normalization 0.5 ms, engine/counters 0.5 ms, audio trigger 0.5 ms, character/caret writes 1.0 ms, scheduling/overhead 1.5 ms. These are hypotheses to validate in an early spike. No persistent writes, decoding, full-text parsing, React commit, chart rebuilding, forced layout, or IPC round trip may be required by an accepted character.

Qualification matrix records CPU, OS, browser/Electron version, display refresh, audio device/connection, sample rate, reported audio latency, power mode, and warm/cold state. Cover supported current desktop Chromium, Firefox, Safari and Electron on the three desktop OSs; declare exact tested versions in release evidence. Hardware keyboard input is the primary SLA scenario. Mobile browsers and IME must remain functionally usable, but require separate qualification. Test 5/15/30 input events per second, bursts, one-hour endurance, simultaneous history/save work, and constrained CPU. Only prepared sessions enter the measured typing state.

## 2. Multi-Profile & State Management System

### 2.1 Contract conventions and ownership

The following are declarative TypeScript interface designs. Identifier aliases (`ProfileId`, `SessionId`, `LessonId`, `DocumentId`) are UUID strings except stable bundled lesson IDs. `Instant` is an ISO-8601 UTC string; `DurationMs` is a nonnegative finite number; counters are nonnegative safe integers. Dates use `YYYY-MM-DD`; zones are IANA names. Serialized records contain no Date objects, functions, undefined fields, or class instances. Enumerated fields reject unknown values unless handled by a version migration. Runtime validation accompanies compile-time typing at all storage/import/IPC boundaries.

| Interface | Required fields and types | Rules |
|---|---|---|
| `Profile` | id: ProfileId; name: string; avatarToken: string; createdAt/updatedAt: Instant; analyticsZone: string; settings: ProfileSettings; revision: integer | Name 1–40 graphemes; profiles do not imply passwords or OS-level isolation |
| `ProfileSettings` | themePreference: light/dark/system; soundProfileId: string; volume: number; muted: boolean; motion: full/reduced/system; fontSizePx: number; keyboardLayout: string; showKeyboard: boolean; practiceDefaults: PracticeConfig | Volume 0–1; font 16–40 px; defaults versioned; initial lesson layout US QWERTY |
| `InstallationSettings` | schemaVersion: integer; activeProfileId: ProfileId or null; lastResolvedTheme: light/dark; appBuild: string; onboardingComplete: boolean | Installation-level, not shared across profile exports unless selected |
| `SessionConfig` | mode: lessons/practice/custom; correctionPolicy: strict/advance; durationLimitMs: number or null; targetLength: integer or null; sourceRef: string; contentVersion: string; metricVersion: integer; layout: string | Exactly one meaningful termination rule except explicit endless practice; immutable after ready |
| `SessionRecord` | id/profileId; config: SessionConfig; startedAt/endedAt: Instant; analyticsZone: string; status: completed/aborted/interrupted; activeMs: number; attempts/correctAttempts/errorAttempts/backspaces: integer; retainedCorrect/retainedErrors: integer; completedWords: integer; grossCpm/adjustedWpm/accuracy: number or null; eligibleForBest: boolean; seed: string or null | Immutable finalized source of truth; stores enough counts to recompute metrics |
| `SessionSeries` | sessionId; samplePeriodMs: integer; samples: array of MetricSample | Default 1-second durable samples; capped/downsampled after 3,600 samples |
| `SessionDaySlice` | sessionId/profileId; day/zone; activeMs/attempts/correctAttempts/errorAttempts/completedWords: integer; eligibleActiveMs/eligibleRetainedCorrect: integer | Durable per-day source counters; daily aggregates are rebuilt from these slices |
| `MetricSample` | activeElapsedMs; windowMs; attempts/correctAttempts: integer; grossCpm/adjustedWpm: number or null; accuracy: number or null | Explicit null means insufficient data, never NaN |
| `MistakeBucket` | profileId/sessionId; expected: grapheme or named whitespace token; attempted: grapheme or named token; count: integer | No raw custom-text sequence; deletions tracked separately |
| `CharacterExposure` | profileId/sessionId; expected: token; attempts/errors: integer | Denominator for heatmap error rate; includes repeated attempts |
| `LessonProgress` | profileId/lessonId/curriculumVersion; attemptCount/passCount: integer; bestWpm/bestAccuracy: number or null; lastAttemptAt: Instant or null; masteredAt: Instant or null; qualifyingSessionIds: SessionId array | Unlocks derived from prerequisites; duplicate save cannot award twice |
| `DailyAggregate` | profileId/day/zone; metricVersion; activeMs/attempts/correctAttempts/errorAttempts/completedWords: integer; eligibleActiveMs/eligibleRetainedCorrect: integer; eligibleSessionCount: integer; bestWpm: number or null; revision: integer | Rebuildable; separates activity from comparable performance |
| `CustomDocument` | id/profileId; title: string; createdAt; normalizationVersion; hash: string; graphemeCount/byteLength: integer; chunkCount: integer; retained: boolean | Text retention opt-in; default is session-only memory |
| `DocumentChunk` | documentId; chunkIndex: integer; startGrapheme: integer; text: string | Bounded chunks, never one giant UI node |
| `ActiveCheckpoint` | sessionId/profileId; config; checkpointAt; lastSequence: integer; activeMs; counts; textCursor; generationState; cappedRecentEdits | Supports interrupted-run detection, not silent scored resume |
| `BackupEnvelope` | formatVersion/schemaVersion; exportedAt; profiles; sessions; progress; aggregates; optionalDocuments; contentVersions; checksum | Size-limited, validated in staging before import commit |

`ProfileSummary` is a derived read model: lifetime active time, completed sessions, historical WPM series, weighted accuracy, completed lesson count, and mistake/exposure maps. Do not embed an ever-growing history array inside Profile.

### 2.2 Repository contract and schemas

Repository operations: initialize/migrate; list/create/update/delete profiles; read/save settings; query sessions with cursor pagination; commit a finalized session with its progress/aggregate effects; read/rebuild aggregates; save/delete documents; write/read checkpoint; export/validate/import backup. All are asynchronous and return typed success or error results (`quota`, `permission`, `corrupt`, `conflict`, `unavailable`, `version-too-new`). Domain consumers see one contract on both platforms.

| Logical collection | Primary key | Indexes or access patterns |
|---|---|---|
| metadata | key | schema version, migration status, active profile |
| profiles | profileId | updatedAt |
| sessions | sessionId | [profileId, endedAt], [profileId, mode, endedAt] |
| sessionSeries | sessionId | Fetch only for selected session |
| sessionDaySlices | [sessionId, zone, day] | [profileId, zone, day]; required for midnight-safe rebuilds |
| sessionMistakes / sessionExposure | [sessionId, expected, attempted] / [sessionId, expected] | Session deletion and profile rebuild |
| lessonProgress | [profileId, curriculumVersion, lessonId] | Profile curriculum overview |
| dailyAggregates | [profileId, zone, day, metricVersion] | Date-range dashboard queries |
| profileCharacterStats | [profileId, expected] | Exposure/error totals, rebuildable |
| customDocuments | documentId | [profileId, createdAt] |
| documentChunks | [documentId, chunkIndex] | Sequential bounded reads |
| checkpoints | sessionId | profileId, checkpointAt |

Browser: IndexedDB is authoritative. Use one transaction for final session, samples, exposures, mistakes, lesson progress, aggregate changes, and checkpoint removal. LocalStorage holds only a tiny early theme hint; no history and no synchronous writes while typing. If the hint is unavailable, boot still succeeds. A missing IndexedDB backend produces a visible temporary mode rather than an unbounded LocalStorage substitute.

Desktop: main process owns a single-writer repository under Electron's per-user application data directory. Do not use a growing electron-store JSON blob for session history. Implement a versioned snapshot plus append-only journal: one framed, checksummed transaction record contains the complete finalized-session mutation; flush before acknowledging durable success. Replay accepts only complete valid records and ignores a truncated final record. A damaged middle record triggers recovery mode and backup restoration, not silent omission. Periodic compaction writes and verifies a new snapshot to a temporary file, durably replaces the snapshot, and rotates the journal only after that succeeds. Retain one prior generation. Serialized logical collections match the browser schemas; in-memory indexes support bounded queries. A utility process performs large serialization/compaction work if main-process responsiveness requires it. This approach needs crash tests on all three filesystems before qualification.

No database dual-writing: the Electron renderer never separately persists authoritative history to IndexedDB. The bridge exposes repository-level operations, file selection, and bounded backup streams; it never exposes arbitrary paths, filesystem primitives, or raw IPC. Desktop file destinations come from native dialogs and main-owned handles.

### 2.3 Consistency, retention, and recovery

A session UUID is its idempotency key. Retrying a commit returns the existing result without doubling daily totals or lesson passes. Aggregate updates are part of the same logical transaction as the source session; aggregates can be dropped and rebuilt. Profile deletion cascades through all owned records in an atomic operation (or a journaled deletion transaction), with a clear user confirmation and backup option.

Checkpoint at most every five seconds of active time and on explicit pause, using a small detached snapshot queued outside input handling. A crash can lose activity since the last checkpoint. On relaunch, offer to keep the checkpoint as an interrupted session or discard it; do not treat it as a completed scored attempt. Normal finalization remains pending until storage acknowledges success. On save failure, retain the in-memory result and offer retry/export; block profile switching that would discard unsaved work unless explicitly discarded. Page unload is not a reliable persistence guarantee.

Use a single active session per profile per installation. Browser tabs coordinate ownership through a Web Lock where available and a transactionally renewed IndexedDB lease otherwise; BroadcastChannel reports status but is not the lock. Desktop uses one repository writer and one active session owner. Background tabs pause input; stale owner tokens cannot commit checkpoint updates.

Migrations are sequential, versioned, and tested against fixtures. Browser structural migrations run in versionchange transactions; large data backfills are resumable outside the upgrade transaction with feature gating until complete. Desktop makes a backup before migration and never overwrites a newer unsupported schema. Imports validate and stage before mutation; v1 imports profiles under fresh IDs and remaps owned records to avoid accidental merges. A repeated backup import may create an explicitly labeled duplicate profile, never silently merge histories.

Keep session summaries and daily aggregates until user deletion. Keep detailed series for the most recent 1,000 sessions by default, with optional expansion if quota permits. Compact old series without changing source counters. Mistake/exposure summaries remain available for aggregate rebuilds. Export excludes custom documents unless selected. History must never retain the user's full typed input by default.

### 2.4 Zustand layout and update frequencies

| Store/module | Data | Update policy |
|---|---|---|
| `appStore` | Boot state, route, adapter status, installation settings, errors | User/lifecycle events |
| `profileStore` | Profile summaries, active ID, hydration/switch status | CRUD or session completion |
| `settingsStore` | Active profile preferences, resolved theme | User changes; debounced persistence |
| `runtimeStore` | Session ID/state, low-frequency counters, duration, completion result | Lifecycle immediately; metrics at 4 Hz |
| `TypingEngine` private memory | Cursor, bounded edit ledger, clock, counters, event buckets | Every accepted input; no React dependency |
| Visual/audio controllers | DOM references, layout map, decoded buffers, active voices | Direct engine deltas |
| History query cache | Date range, paginated records, aggregate views | Explicit queries/invalidation |

Use vanilla Zustand with selector subscriptions. React components subscribe to stable scalar/small object slices with explicit equality; never the entire runtime object. Zustand does not itself eliminate render cost or persistence cost. Per-key updates stay in engine memory; a transient event bus emits minimal deltas to sound/visual consumers, and a 250 ms sampler publishes snapshots. Avoid global persist middleware over runtime/history. Zustand documents selector subscriptions for targeted external updates. [Zustand subscribeWithSelector](https://zustand.docs.pmnd.rs/reference/middlewares/subscribe-with-selector)

Profile switching sequence: stop or finalize active session → resolve pending save → release engine/controllers → cancel obsolete profile queries → load profile/settings/progress → select and prepare assets → publish one coherent ready state. Generation tokens prevent slow requests for the old profile from overwriting the new profile. Switching never leaks one profile's mistakes, settings, or documents into another's view.

## 3. Audiovisual & Animation Engine Design

### 3.1 Product layout and interaction

The desktop shell contains a compact mode navigation rail, active profile control, and settings access. The main area presents mode configuration above a centered typing card, with a small metrics row and optional live graph beneath it. During active typing, secondary controls visually recede without changing layout. Results show speed, accuracy, time, mistake focus, and a clear retry/continue action. History offers progress and activity tabs.

At narrow widths the rail becomes a compact navigation menu; the typing surface remains the dominant region. Support 200% zoom, keyboard-only navigation, visible focus, high-contrast modes, and a screen-reader-friendly equivalent for all charts. Tab and Escape remain accessible commands; no global keyboard trap.

Text uses a locally bundled, licensed monospace font with tabular metric numerals. Upcoming characters are muted; correct characters become foreground/accent; errors have an underline or distinct marker as well as color. Space/newline errors have visible glyph markers. Errors never rely on red/green distinction alone.

### 3.2 Input semantics and session lifecycle

States: idle → preparing → ready → running ↔ paused → finalizing → completed. Aborted/interrupted are explicit result outcomes; asset/storage errors have retry paths. Session starts on the first accepted text attempt, with the start timestamp recorded before scoring that attempt. Timer uses a monotonic clock; wall time labels records only. Pauses exclude elapsed time, but voluntary pauses disqualify timed practice records from personal bests. Blur/visibility loss auto-pauses and requires explicit resume. Background throttling never silently consumes an entire test.

Use a focused, labeled native text input surface as the canonical text source. `beforeinput`/`input` normalization handles committed text and backward deletion; composition commits are processed once, not once per keyboard and input event. `keydown` handles commands and supplementary physical-key feedback only, avoiding duplicate scoring. Compare logical input graphemes against target graphemes; `event.code` is only for a keyboard illustration. Modifier shortcuts and function keys do not score or sound as text.

Reject paste, drop, predictive replacement, and multi-character insertion during a scored ordinary keyboard test; allow IME committed batches in compatibility sessions, marked separately for comparison and audio (one sound per commit). Pasting belongs in custom-text setup. Disable spellcheck/autocorrect where supported. Ignore held-key repeat for scored input, allow repeat Backspace at a bounded rate; record this policy in session config. Reject forward-delete, cursor jumps, arbitrary selection replacements, and undo during scored typing; the trainer owns the target cursor. Do not suppress OS/browser shortcuts.

Advance policy (default practice/custom): each attempted grapheme fills the current target position, correct or incorrect, then advances. Backspace removes the most recent editable position; it does not remove the historical attempt/error counters. Strict policy (default lessons): an incorrect attempt increments errors but stays at the current position; a correct attempt advances. In either policy Backspace can remove accepted prior positions within a 512-grapheme correction window. Retained-correct counters decrement when correct positions are deleted. Older committed chunks are immutable, making endless memory bounded. Navigation arrows do not edit text. Completion uses cursor/target termination, not “zero mistakes.”

### 3.3 Visual engine

Render at most three visible text lines plus two overscan lines; use a maximum 2,048-grapheme mounted window. Precompute line breaks and caret coordinates after font readiness and container layout, away from input handlers. Resize/font changes pause or briefly reprepare the surface so stale coordinates never move the caret to an unrelated position. During input, mutate only affected character state and write the cached caret transform; never perform a layout read after a write.

Feedback layers:

- Essential: character state and caret destination change in the input turn; actual presentation waits for the browser/display.
- Decorative: optional 25–40 ms caret interpolation that starts at the new state immediately; tiny keycap compression/opacity pulse lasting 60–90 ms. A precision setting snaps the caret with no interpolation.
- Completion: one restrained 180–250 ms card bounce and up to 24 pooled particles in a single overlay canvas. No particle creation during ordinary character input.

Coalesce paint-oriented work into at most one animation frame callback. Do not defer engine scoring or audio to that callback. Maintain bounded effect pools; cancel animation loops when idle, hidden, or unmounted. Reduced motion disables interpolation, bounce, and particles, while keeping static correctness feedback. A live region announces start/pause/completion and occasional summaries, never every typed character. The native input remains operable for assistive technology; the visual character layer is decorative where it duplicates accessible text.

### 3.4 Audio architecture

Sound packs: muted, soft, mechanical linear, and mechanical clicky. Each manifest records pack/version, licensing attribution, local file hashes, sample category, duration, gain normalization, and 2–4 subtle variants. Key categories include ordinary letter, space, Enter, Backspace, and optional gentle error accent. Do not derive sounds from a proprietary application's package.

Create one AudioContext after a user gesture with interactive latency preference. Load and decode the selected pack before entering ready, then reuse immutable AudioBuffers. Cache at most two decoded packs and release least recently used buffers when switching. Target at most 16 MiB decoded audio and 24 simultaneous voices. Bundled short PCM WAV samples favor predictable offline decoding; trim leading silence and apply offline gain/headroom normalization. AudioContext latency preferences are requests, not guarantees; report available latency properties diagnostically. [AudioContext baseLatency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/baseLatency), [AudioContext outputLatency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency)

Each accepted input directly selects an already decoded buffer, creates a short-lived buffer source, connects it through reusable pack/master gain nodes, and starts it at the current audio clock without a deliberate scheduling delay. Buffer sources are one-shot; cache buffers, not used source nodes. Avoid a lookahead sequencer or waiting for React effects. Maintain master headroom and a fixed voice cap; ramp out the oldest voice over a few milliseconds on overflow. Disconnection occurs after voice completion. Slight seeded sample variation may be used, with conservative gain variation and no expensive processing graph.

Sound handling never awaits a fetch, decode, IPC response, or storage write. First-run gesture unlock, suspended contexts, output changes, and device removal get explicit readiness states. If audio cannot resume, offer immediate muted training and a retry control; training correctness must still work. On return from background, re-check/resume within a gesture before sounding. AudioContext telemetry is an estimate, not proof of speaker onset. Baseline worklet usage is unnecessary for sample playback; consider an AudioWorklet only after traces establish a problem it can solve.

### 3.5 Assets and resource budgets

Initial installed runtime payload target: no more than 25 MiB uncompressed, including all sounds, dictionaries, fonts, lessons, and worker chunks. Enforce complete precaching even for assets loaded lazily into RAM. Initial application script target: at most 300 KiB compressed, excluding Electron runtime and deferred dashboard chunks. Typing working set targets: text window ≤2,048 graphemes, correction history ≤512, live buckets ≤120 seconds, effects ≤24, voices ≤24. Targets are measured budgets, not unsupported cross-platform guarantees. A one-hour endless test must show a plateau in retained engine memory.

## 4. Real-Time Metrics & Performance Visualization Engine

### 4.1 Canonical metric definitions

All metrics use active elapsed time and grapheme-based input units. Spaces and explicit newlines count as one unit. Backspaces/modifiers/rejected commands do not count as character attempts. “Word” in WPM means five character units; completed dictionary words are a separate volume metric.

Let T be active seconds, A all accepted character attempts, C correct attempts at the moment attempted, E incorrect attempts, R correct characters currently retained in the target buffer, and B backspaces. A = C + E. R may decrease on correction and must not be confused with C.

| Metric | Definition | Meaning |
|---|---|---|
| Gross CPM | 60 × A / T | Input attempt rate, including errors/retries |
| Gross WPM | 12 × A / T | Gross CPM divided by five |
| Adjusted WPM (primary final score) | 12 × R / T | Correct retained target output per minute |
| Attempt accuracy | 100 × C / A | Corrections never erase mistakes |
| Rolling correct-attempt WPM | 12 × window correct attempts / window seconds | Live fluency estimate, explicitly different from final output score |
| Output accuracy (secondary) | 100 × R / retained positions | Final text correctness, not lesson gate accuracy |

At zero elapsed time or zero relevant denominator, return null and display an em dash. Live rates wait until at least one active second; before a full rolling window fills, label “warming up.” No rounding before aggregation or comparison; display one decimal. Example: T=60, A=300, C=285, E=15, R=270 gives 300 gross CPM, 60 gross WPM, 54 adjusted WPM, and 95% attempt accuracy. Retyping a correct deleted letter increases C again but cannot artificially increase R beyond the correct retained target positions.

### 4.2 Live pipeline and chart

Maintain 100 ms active-time buckets containing attempt and correct-attempt deltas. A fixed 120-second ring bounds memory. Every 250 ms calculate the trailing five active seconds (or elapsed time if shorter), publish the numerical snapshot, and append a chart point. The live graph label is “5-second rolling correct-attempt WPM”; optionally show gross WPM as a distinct trace. The primary numerical score remains cumulative adjusted WPM. Pauses do not inject zero-speed time; idle time while still running does.

Use Canvas 2D with a cached grid and a fixed-capacity 480-point display buffer (two minutes at four points per second). Draw only on sample, resize, theme change, or pointer interaction; use requestAnimationFrame to coalesce pending draws, not a perpetual 60 fps loop. Limit pixel density to a measured cap, initially 2. Y-axis range changes use hysteresis; no per-point animated axis transitions. React owns chart controls and receives 4 Hz scalar labels, not the entire point array. Pointer tooltips query the nearest sample in memory without a state update on each movement. Provide a textual current/min/max summary and optional sample table for accessibility.

Persist one-second series samples, downsample older sections after 3,600 samples to bounded multiresolution bins retaining min/max/mean and counts. Infinite sessions maintain cumulative counters independently of the bounded graph. A worker may prepare historical series, but chart input must never wait for it. A general-purpose React chart package is unnecessary for this tiny live chart.

### 4.3 Historical progress bar charts

Default dashboard shows 30 local calendar days with weekly grouping available. Daily performance is duration-weighted adjusted WPM over eligible completed sessions: 12 × summed retained-correct / summed active seconds. Weekly bars use the same pooled counters, not an average of daily averages. Show best session speed as an optional marker and weighted attempt accuracy as a separate measure. Empty days have no performance score; distinguish missing data from a zero.

Sessions shorter than 15 active seconds, compatibility input sessions, interrupted/aborted runs, and paused timed practice are excluded from comparative speed trends by default. Lessons/practice/custom are independently filterable because difficulty affects speed. Show the included sample count and do not imply a mixed-mode trend measures a controlled improvement. Recompute mode-filtered totals from indexed sessions or a mode-specific cache; do not misuse unfiltered daily aggregates.

Use SVG bars for at most 104 daily/weekly bins, accessible labels, keyboard focus, and a parallel table. Dashboard views update after commits or filter changes, so normal React rendering is appropriate. Query only the visible date range; worker aggregation prevents a large history import/rebuild from blocking input.

### 4.4 Activity calendar, streaks, and calendar correctness

Calendar defaults to 53 weeks × 7 days, with profile's configured analytics zone and Monday as the initial week start. Each cell has date, active milliseconds, completed words, attempts, and session count; tooltip/table contains the exact values. Default intensity is active time: zero, under 2 minutes, 2–under 5, 5–under 15, and 15+ minutes. This fixed scale allows comparison over time; optional word-volume view uses fixed published word thresholds. Zero is visibly distinct from low activity.

A streak day qualifies at ≥60 active seconds and ≥20 character attempts. Show current streak through today or yesterday so an unfinished current day does not erase yesterday's streak, and longest streak over stored history. Completed, aborted, and recoverable interrupted sessions contribute actual activity; only eligible completed sessions contribute speed records.

For runs crossing midnight, accumulate day-local counters as events happen and split elapsed active intervals at timezone boundaries; do not assign the entire run to its finish date. Capture the profile analytics zone in every session. DST uses calendar-date arithmetic, not fixed 24-hour subtraction. Detect wall-clock jumps relative to monotonic time, split/reanchor later buckets, and flag the run for calendar review while preserving its monotonic duration. Keep the profile analytics zone fixed after activity exists in v1; device timezone changes do not rewrite history. Backup preserves the zone. A future timezone migration needs an explicit rebuild design.

Retained positions carry their original day attribution while editable. Deleting a correct position decrements that day's retained-correct contribution; retyping assigns the new position to the current day. On finalization, persist SessionDaySlice records together with the session and its aggregates. Determine performance eligibility for the whole session first, then assign eligible duration/output contributions to its slices. This preserves the equivalence between session totals and pooled daily/weekly scores across midnight. Backups include these source slices and character summaries, not only the derived aggregates.

### 4.5 Mistake heatmaps and aggregate validation

Heatmaps report errors divided by exposures for each expected character, with raw counts available. Display “insufficient practice” below 20 exposures instead of ranking noisy percentages. An optional confusion table lists expected → attempted pairs. The keyboard visualization uses the session layout; unsupported layouts use a character table. No inference of a user's actual finger is claimed from key events.

Every aggregate must be reproducible from source session records and their per-day/character summaries. Required invariants include A=C+E, nonnegative durations, daily activity sums matching source activity, idempotent commits, and no double counting on profile import. Preserve metricVersion so formula changes cannot silently rewrite historical interpretation.

## 5. Core Training Modes Specification

### 5.1 Shared mode contract

A mode supplies a `TrainingSource`: source ID/version, display title, normalized grapheme chunks, termination rule, correction policy, scoring eligibility rules, and optional progress evaluator. The typing engine knows none of the curriculum or dictionary UI. All generators accept explicit seed/state so fixture sessions are reproducible. Preparation completes before ready; asynchronous refill must maintain sufficient buffered text without blocking input.

Shared flow: choose profile → choose mode/configuration → prepare text/audio/layout → ready instruction → first accepted input starts time → running feedback → completed/aborted result → durable commit → retry/next/history. Failure to save is shown beside the result, not silently swallowed.

### 5.2 Mode 1 — Lessons

Curriculum uses a versioned acyclic prerequisite graph. `LessonDefinition` fields: id, curriculumVersion, title, stage, prerequisites, introducedKeys, reviewKeys, fingerHints, exercisePolicy, targetGraphemes, correctionPolicy, minimumAccuracy, minimumWpm, requiredQualifyingPasses, contentSeedPolicy. `fingerHints` map logical QWERTY keys to teaching fingers; they are instructional, not detected.

| Stage | Content | Qualification |
|---|---|---|
| 1 | F/J anchors; D/K; S/L; A/semicolon; spaces and home-row pairs | ≥95% attempt accuracy, ≥10 adjusted WPM |
| 2 | G/H reach; balanced home-row combinations and short valid words | ≥95%, ≥15 WPM |
| 3 | Upper-row reaches by corresponding finger, then cumulative mixtures | ≥96%, ≥20 WPM |
| 4 | Lower-row reaches, then all-letter combinations | ≥96%, ≥25 WPM |
| 5 | Shift, capitals, punctuation, digits introduced in short groups | ≥96%, ≥25 WPM |
| 6 | Sentences and mixed prose with cumulative review | ≥97%, ≥30 WPM |

Each stage contains atomic lessons for each newly introduced key or pair before mixed review. Foundational lessons require at least 120 target graphemes; later lessons 240. Strict correction is default; wrong attempts do not advance. Target content contains only introduced/review keys plus explicitly allowed spaces, preventing accidental locked-key exposure. New-key drills allocate 60% of generated positions to current keys and 40% to mastered review keys when review exists. Curriculum assets include vetted pronounceable combinations or valid words, not arbitrary unlicensed copied exercises.

A qualifying pass completes the target, lasts at least 15 active seconds, meets both accuracy/speed gates, and has no compatibility input or pause. Mastery requires two qualifying completed sessions among the latest three completed attempts for that lesson. Recommitting one session cannot count twice. A failed attempt remains visible and does not revoke already earned mastery. A lesson unlocks when every prerequisite is mastered; the first lesson is always available. Users may replay all unlocked lessons and may practice any keys freely in Practice Mode.

Result flow explains the exact unmet criterion, highlights high-error keys, and offers retry or the next unlocked lesson. Curriculum version changes preserve old attempts and mastery records; new requirements apply to new versioned lessons, with explicit migration mappings for unchanged lessons. No silent loss of prior achievements.

### 5.3 Mode 2 — Practice

Bundle a reviewed, licensed English dictionary with approximately 10,000 unique entries. Target disjoint pools: 1,000 beginner entries (common, 2–5 letters), 4,000 intermediate (common/general, 4–8 letters), and 5,000 advanced (longer or less common, 6–14 letters); length overlaps are resolved by curated frequency/difficulty metadata. The exact accepted count and provenance are build-validated, not assumed. Entries carry stable ID, lowercase spelling, grapheme length, difficulty, frequency band, and optional punctuation/capitalization suitability. Exclude offensive content and surprising proper nouns from the default set.

`PracticeConfig`: pool/tier, duration preset (15/30/60/120 seconds) or word target (25/50/100) or endless, punctuation/capitalization flags, seed, correction policy, optional key filter. Only one termination choice is active. Configuration is snapshotted into session history.

Generator uses a seeded PRNG and shuffled bags; avoid the same word within the previous 20 words when the pool permits. Small filtered pools shrink the exclusion window instead of looping forever. A zero-size filter displays a configuration error; it never starts an empty session. Difficulty is static during a scored run. Optional mistake-focused key filters are explicit, not hidden changes in difficulty.

Prepare an initial 200-word buffer. Refill in batches of 100 at a low-water mark of 80 words, on a worker or an idle preparation task. Maintain a bounded 400-word working buffer plus generation index/PRNG state and the correction window. Release old committed text chunks. Delimiters are single spaces; display wrapping is layout-only. Word-count tests end after the final word without requiring a trailing space. Endless tests end by the explicit Finish action; cumulative metrics survive discarded display chunks. If refill unexpectedly fails, pause active time, show a recoverable preparation state, and disqualify that run from records instead of losing keystrokes.

Timed sessions check the monotonic deadline before accepting each input; a delayed UI timer cannot admit late events. The visible countdown is derived from elapsed time, never decremented as a source of truth.

### 5.4 Mode 3 — Custom Text

Accept paste into a setup textarea and local `.txt` files up to 5 MiB encoded bytes; cap normalized content at 500,000 graphemes. Reject larger input before constructing a full rendering model. UTF-8 is the default; strip a UTF-8 BOM, detect UTF-16 LE/BE BOMs, and reject invalid sequences with a clear conversion instruction rather than silently replacing characters. File type extensions are hints: reject binary-like NUL/control patterns. Render content strictly as text; never HTML, Markdown execution, or remote-resource embedding.

Worker preparation pipeline: read bounded chunks → decode with carryover across byte boundaries → normalize CRLF/CR to LF → normalize Unicode NFC with boundary carryover → segment graphemes → produce preview, counts, and chunk index. Segmenter support is feature-detected; a bundled local fallback supplies equivalent grapheme handling where required. Long unbroken words and emoji must not cause unbounded DOM nodes or surrogate splitting.

Two explicit normalization policies:

- Reading practice (default): tabs become one space; horizontal whitespace runs collapse; blank paragraphs become one newline; curly punctuation may be converted to common keyboard punctuation only when the user enables that option. Preview shows the result before starting.
- Preserve formatting: keep spaces and newlines; tabs expand to four spaces; Enter is a scored newline. Unsupported controls are identified, not invisibly scored.

Trimming leading/trailing whitespace is an explicit setup option with a visible before/after character count. Empty normalized text cannot start. English/Latin hardware-keyboard text is the primary scored experience; other scripts and IME are supported through clearly labeled compatibility sessions with matching grapheme semantics. Physical keyboard availability and lesson keymap restrictions do not block reading arbitrary Unicode in the preview.

Store text in logical chunks of approximately 4,096 graphemes without splitting clusters. The typing controller mounts only its bounded current window and advances around line boundaries. Pagination/auto-scroll follows the caret between prepared windows; scrolling does not change target positions. Backspace can traverse chunks only within the shared correction window. The full target remains addressable by logical grapheme index independent of page width.

Custom text stays in memory by default and is released at session exit. “Save this text locally” explicitly creates a CustomDocument and chunks. History stores an opaque document reference/hash and metrics, not the source content or clipboard payload. A missing unsaved source makes replay unavailable with a clear explanation. Exports include saved documents only by selection. Test file errors, encoding errors, cancellation, large paste, emoji, combining marks, CRLF, tabs, and very long lines.

## 6. Theming & Customization Architecture

### 6.1 Theme resolution and persistence

Persist light/dark/system per profile; keep the resolved light/dark palette separate. On startup use a tiny local last-resolved hint to avoid a bright flash, then hydrate authoritative settings. System mode follows the platform color-scheme media query and responds to changes. An explicit light/dark choice ignores subsequent OS palette changes. One root theme attribute controls all React and imperative surfaces; remove media-query listeners on teardown. Tailwind supports theme variables and selector-driven dark styling. [Tailwind theme variables](https://tailwindcss.com/docs/theme), [Tailwind dark mode](https://tailwindcss.com/docs/dark-mode)

### 6.2 Semantic token contract

| Token family | Named roles | Consumer |
|---|---|---|
| Surface | background, surface, raised, border, overlay | Shell, card, dialogs |
| Text | primary, secondary, muted, inverse | Labels, target text, annotations |
| Typing | upcoming, correct, error, error-background, caret, selection | Imperative text/caret renderer |
| Action | accent, accent-hover, focus-ring, disabled | Interactive controls |
| Chart | grid, speed, gross-speed, accuracy, activity-0 through activity-4 | Canvas and SVG |
| Typography | font-ui, font-typing, size-body, size-typing, line-height-typing | Layout and measured glyph map |
| Geometry | radius-card, radius-control, spacing steps | Shared surfaces |
| Motion | duration-fast, duration-caret, duration-completion, easing | Visual controllers and transitions |

Use custom properties with a consistent `--ff-` prefix as runtime values, bridged into Tailwind semantic theme aliases at build time. Both light and dark palettes implement every semantic role. No literal palette colors in feature components or canvas drawing logic. Theme changes publish a resolved token snapshot to canvas controllers; computed-style reads occur once on theme change, never per key. Dynamic utility names must be statically discoverable or mapped explicitly so production builds retain required styles.

Proposed identity: warm near-white/light charcoal in light mode, deep graphite/off-white in dark mode, restrained teal accent, and clearly marked coral error feedback. Exact colors are finalized against measured contrast: at least 4.5:1 for ordinary text and 3:1 for relevant non-text controls. High-contrast/forced-colors support uses system colors where appropriate. Typing correctness has a shape/underline cue independent of color.

Settings include sound/volume, motion, text size, keyboard illustration, and theme. Font/size/layout changes remeasure the text surface only while ready/paused; changing theme or volume is safe during a test. Reduced-motion system preference is followed unless the user explicitly sets a stronger reduction. Audio mute is independent of reduced motion. Remember settings locally per profile and apply only after the profile-switch barrier.

## 7. Multi-Stage Implementation Blueprint & Prompt Strategy

### 7.1 Continuity protocol

Each micro-prompt below is a standalone task to paste into a future session. Paths are relative to `/home/medys/WORKSPACE/FlashFinger`. The authoritative design is `docs/DESIGN_SPECIFICATION.md`. Future code sessions must inspect existing files and applicable workspace instructions before editing. An unexpected prerequisite gap must be documented and resolved within scope or reported; it must not trigger a speculative full-app rewrite.

Every implementation session updates `docs/IMPLEMENTATION_STATUS.md` with completed prompt IDs, actual output paths, contract/schema/content versions, commands run and outcomes, known limitations, and the next eligible prompt. Record any architectural change in `docs/DECISIONS.md` with reason and migration impact. These documentation updates are allowed in every prompt in addition to its listed outputs. Keep mocks deterministic and dependency-injected; never let a mock silently become a production persistence path. Do not claim a check passed if it was not run. Commit-sized tasks may span multiple sessions without widening their scope.

Dependency order: M01 → M02 → M03. M04 and M05 depend on M03. M06 depends on M03; M07 depends on M02/M06; M08 depends on M06/M07; M09 depends on M08; M10 depends on M09; M11 depends on M04/M05/M08/M10. M12–M14 depend on M11. M15 depends on M11–M14. M16 depends on M02/M05/M12–M14. M17 depends on all prior outputs.

### M01 — Record contracts and test fixtures

> Work in FlashFinger. Read `docs/DESIGN_SPECIFICATION.md`, especially §§2, 4, and 5. Implement only shared TypeScript data contracts and runtime boundary validation. Prerequisite: the design document exists; no application boilerplate is assumed. Inputs: the declarative interface tables, metric rules, repository operations, training source contract, and finite session states. Create deterministic fixtures for two profiles, one completed session, one interrupted session, one failed lesson, an empty history, and a session crossing midnight. Expected outputs: `src/contracts/{models,repository,platform,training,validation}.ts`, `tests/fixtures/contracts/`, `docs/IMPLEMENTATION_STATUS.md`, and `docs/DECISIONS.md`. Do not build screens or storage. Validate field constraints, enum handling, ownership references, and version rejection; executable test wiring is completed in M02. Preserve the specified semantics rather than inventing alternative formulas. Update the handoff with actual paths and unresolved choices.

### M02 — Shared Vite and secure Electron shell

> Work in FlashFinger. Read the design and implementation status. Prerequisite: M01 contracts and fixtures exist. Build only the TypeScript/React/Vite shell, Electron main/preload, platform detection, and test tooling. Inputs: one shared renderer artifact and the secure protocol/bridge boundaries in §1. Mock repository capabilities return an explicit unavailable status; show a static shell with a ready-to-configure placeholder. Expected outputs: `package.json`, lockfile, TypeScript/Vite/test configuration, root renderer entry, `src/app/{bootstrap,App}.tsx`, `src/platform/{factory,capabilities}.ts`, `electron/{main,preload,protocol}.ts`, and `tests/integration/shell.test.ts`. Select compatible pinned versions. Verify browser root and nested-path builds plus Electron loading the identical renderer output; verify Node APIs are absent from the renderer and protocol traversal is rejected. Do not implement typing, persistence, or PWA caching. Update the handoff and record verification limitations.

### M03 — Pure typing and timing engine

> Work in FlashFinger. Read the design and status. Prerequisite: M01 contracts and M02 test tooling. Implement only the framework-independent typing engine and canonical metric primitives. Inputs are normalized character/delete/clock/pause commands; outputs are bounded deltas and serializable snapshots. Use fake monotonic time and fixtures containing ASCII, spaces, newlines, emoji, corrections, and a timed deadline. Expected outputs: `src/domain/typing/{engine,clock,ledger,types}.ts`, `src/domain/metrics/formulas.ts`, `tests/unit/typing.test.ts`, and `tests/unit/formulas.test.ts`. Verify strict/advance behavior, deleted-correct counters, zero-time metrics, late-input rejection, state transitions, and bounded correction history. No React, DOM, audio, or storage dependencies. Update the continuity files.

### M04 — Browser repository

> Work in FlashFinger. Read the design/status and repository contract. Prerequisites: M01–M03, including test tooling and finalized-session shape. Implement only IndexedDB persistence and its browser repository adapter. Inputs: validated contracts and deterministic profile/session fixtures; no real typing UI is required. Expected outputs: `src/platform/web/{database,migrations,repository,ownership}.ts` and `tests/integration/web-repository.test.ts`. Verify atomic session commit, duplicate commit, profile isolation/deletion, migration failure, multi-tab ownership, quota errors, pagination, and rebuildable aggregates. Test important transactions in a real browser as well as any database mock. LocalStorage may hold a theme hint only. Do not implement desktop persistence or profile screens. Update the handoff.

### M05 — Desktop durable repository

> Work in FlashFinger. Read the design/status and repository contract. Prerequisites: M02 secure bridge and M03 finalized-session shape. Implement only the main-owned local repository and typed renderer adapter. Inputs: the same M01 fixtures used by the browser contract, temporary test directories, and injected crash/failure points. Expected outputs: `electron/storage/{repository,journal,snapshot,migrations}.ts`, `electron/ipc/repository.ts`, `src/platform/desktop/repository.ts`, and `tests/integration/desktop-repository.test.ts`; narrowly extend preload contracts. Verify retry idempotency, truncated-tail recovery, corrupted-middle detection, compaction crashes, unsupported versions, path confinement, payload limits, and sender validation. Acknowledge saves only after the defined durable boundary. Do not add profile UI, unrestricted filesystem APIs, or parallel IndexedDB writes. Update the handoff with platform-specific crash-test evidence.

### M06 — Profile orchestration and Zustand stores

> Work in FlashFinger. Read the design/status, especially §2. Prerequisites: M03 pure engine and M01 repository contract; real repositories are optional for this slice. Implement vanilla Zustand app/profile/settings/runtime stores and the profile lifecycle coordinator. Inputs: an injected in-memory repository fixture for two profiles with different settings, delayed requests, and failing saves. Expected outputs: `src/state/{app,profiles,settings,runtime}.ts`, `src/app/profileCoordinator.ts`, `src/features/profiles/`, and `tests/integration/profile-switch.test.ts`. Verify unsaved-result barriers, old-request cancellation, coherent hydration, no cross-profile leakage, and ≤4 Hz metric publications. Do not persist per key or subscribe components to entire stores. Profile CRUD is the only screen scope. Update the handoff.

### M07 — Theme and accessible shell

> Work in FlashFinger. Read the design/status and §6. Prerequisites: M02 React shell and M06 settings store. Implement only semantic Tailwind theme tokens, light/dark/system resolution, motion preference, shared controls, and accessible navigation. Inputs: mock ready/paused screen content and two profile settings fixtures; no live engine needed. Expected outputs: `src/styles/{index,themes}.css`, `src/app/themeController.ts`, `src/components/{Button,Dialog,Navigation}.tsx`, `src/features/settings/AppearanceSettings.tsx`, and theme/accessibility integration tests. Verify system changes, explicit overrides, first-paint hint fallback, 200% zoom, keyboard focus, contrast, and reduced motion. Ensure canvas consumers can request a token snapshot. Do not implement character rendering or sound. Update continuity files.

### M08 — Native input adapter and text viewport

> Work in FlashFinger. Read the design/status, §§3.2–3.3 and §5.1. Prerequisites: M03 engine, M06 runtime store, and M07 tokens/shell. Implement only browser input normalization and the bounded imperative text/caret surface. Inputs: a fixed prepared TrainingSource of 300 characters plus long-line and Unicode fixtures; audio is a silent injected sink and persistence is a mock. Expected outputs: `src/features/typing/{TypingSurface,inputAdapter}.tsx` (split helpers into `.ts` as appropriate), `src/engines/visual/{textRenderer,layout,caret}.ts`, and input/viewport integration tests. Verify one score per committed input, IME compatibility, blocked paste, shortcuts, focus pause, resize, correction-window boundaries, and no full React render per character. No decorative particles or real sound yet. Update the handoff and capture an initial renderer trace.

### M09 — Low-latency audio and feasibility spike

> Work in FlashFinger. Read the design/status and §§1.6/3.4. Prerequisite: M08 working input-to-delta surface. Implement only the AudioContext service and its direct input subscription. Inputs: a tiny locally generated/licensed test pack with letter/space/backspace variants and mute fallback; no remote assets. Expected outputs: `src/engines/audio/{context,soundBank,voices}.ts`, `public/assets/sounds/test-pack/`, `public/content/sound-packs.json`, audio lifecycle tests, and `docs/PERFORMANCE_BASELINE.md`. Verify gesture unlock, predecode readiness, one-shot voice handling, suspension/device failures, memory/voice caps, and input scheduling instrumentation. Measure browser and Electron scheduling separately from physical output; record unavailable hardware measurements honestly. Do not build sound-pack UI or claim a universal <10 ms result. Update continuity files.

### M10 — Bounded feedback effects

> Work in FlashFinger. Read the design/status and §3.3. Prerequisites: M08 essential text/caret feedback and M09 audio timing baseline. Implement only optional caret interpolation, keycap pulse, and completion effects using fixed pools. Inputs: synthetic engine deltas, completion events, full/reduced motion preferences, and theme snapshots. Expected outputs: `src/engines/visual/{effects,keyFeedback,motion}.ts`, minimal TypingSurface wiring, and effect lifecycle tests. Verify immediate essential state changes, no layout reads in input handlers, pooled particle cap, cancellation on pause/unmount, and static reduced-motion feedback. Repeat the existing performance scenario to detect regressions. Do not add training modes or charts. Update the handoff.

### M11 — Session lifecycle and durable result integration

> Work in FlashFinger. Read the design/status and §§2–4. Prerequisites: M04 browser repository, M05 desktop repository, M08 input surface, and M10 feedback. Implement only the cross-platform coordinator from ready through finalization and result display. Inputs: a fixed TrainingSource, real platform repository, fake-time failure fixtures, and interrupted checkpoints. Expected outputs: `src/app/sessionCoordinator.ts`, `src/features/typing/{SessionScreen,ResultScreen}.tsx`, `src/domain/metrics/sessionSummary.ts`, and lifecycle integration tests. Verify start/pause/finish, immutable config, checkpoint cadence, durable save acknowledgement, retry idempotency, quota failure, interrupted recovery, and profile-switch barriers. No randomized mode, curriculum, or custom file UI. Update continuity files.

### M12 — Lessons slice

> Work in FlashFinger. Read the design/status and §5.2. Prerequisite: M11 working shared session coordinator and repository. Implement only lesson catalog, deterministic lesson generation, mastery evaluation, and lesson selection/results integration. Inputs: versioned curriculum assets with a complete stage-one set and one fixture per later stage; ship the full planned curriculum before marking the slice complete. Expected outputs: `src/domain/training/{lessons,progression}.ts`, `src/features/lessons/`, `public/content/lessons/`, curriculum validation tests, and lesson-flow integration tests. Verify graph acyclicity, allowed-key content, two-of-three qualifying passes, unlocks, duplicate-commit resistance, failure explanations, and retained old-version progress. Do not change scoring formulas or build dashboards. Update the handoff with exact curriculum coverage.

### M13 — Seeded practice slice

> Work in FlashFinger. Read the design/status and §5.3. Prerequisite: M11 shared session coordinator. Implement only local dictionary preparation, seeded shuffled-bag generation, configuration, and bounded endless refill. Inputs: a ten-word fixture for edge cases and a licensed production pool matching the declared manifest counts. Expected outputs: `src/domain/training/{practice,dictionary}.ts`, `src/workers/dictionary.worker.ts`, `src/features/practice/`, `public/content/dictionaries/`, content license records, and generator/refill tests. Verify reproducible seeds, difficulty filters, tiny/empty pools, timed/word/endless termination, refill stalls, bounded memory, and no repeated-word infinite loops. No remote word source or adaptive hidden difficulty. Update continuity files.

### M14 — Custom-text slice

> Work in FlashFinger. Read the design/status and §5.4. Prerequisite: M11 shared coordinator and document-capable repository contracts/adapters. Implement only local text import/paste setup, worker normalization, preview, chunk source, and opt-in document retention. Inputs: fixtures for UTF-8/UTF-16 BOMs, invalid bytes, binary content, CRLF/tabs, combining marks, emoji, empty text, a 5 MiB boundary file, and a long unbroken line. Expected outputs: `src/workers/text.worker.ts`, `src/domain/training/customText.ts`, `src/features/custom-text/`, and parser/long-text integration tests. Verify byte/grapheme limits, deterministic normalization, cross-chunk corrections, safe text rendering, cancellation, default non-retention, and missing-source replay. Do not persist clipboard text implicitly. Update the handoff.

### M15 — Live chart and historical dashboards

> Work in FlashFinger. Read the design/status and §4. Prerequisites: M11–M14 produce valid session/source metrics; M07 supplies theme snapshots. Implement only rolling sampling, Canvas live graph, historical bars, activity calendar, and mistake views. Inputs: synthetic 30 Hz bursts; fixtures for zero denominators, corrections, 400 days of history, midnight/DST, sparse data, mixed modes, and aborted sessions. Expected outputs: `src/domain/metrics/{rolling,aggregates,calendar}.ts`, `src/features/typing/LiveGraph.tsx`, `src/features/history/`, `src/workers/analytics.worker.ts`, metric/calendar tests, and a graph performance trace. Verify weighted formulas, mode filtering, fixed bucket caps, accessible chart equivalents, streak boundaries, and aggregate rebuild equivalence. No chart-library rendering on every key. Update continuity files.

### M16 — Offline delivery and local backups

> Work in FlashFinger. Read the design/status and §§1.5/2.3. Prerequisites: M02 shared artifact, M05 desktop file bridge, and M12–M14 complete content manifests. Implement only complete PWA precaching, safe update lifecycle, storage-status messaging, and validated local backup import/export. Inputs: full production manifest, interrupted-download fixtures, low-quota storage, corrupted/oversized/newer-version backups, and offline first-launch scenarios. Expected outputs: service-worker/build integration, `public/manifest.webmanifest`, local app icons, `src/platform/web/offline.ts`, `src/features/settings/BackupSettings.tsx`, `src/contracts/backup.ts`, narrow Electron backup handlers, and offline/backup end-to-end tests. Verify all modes and sound packs after network disconnect/reload, nested deployment paths, desktop first launch offline, staged import with remapped IDs, and update deferral during typing. Do not require a remote endpoint or cache desktop assets through a service worker. Update the handoff.

### M17 — Cross-platform qualification and release artifacts

> Work in FlashFinger. Read the design, decisions, status, and performance baseline. Prerequisites: M01–M16 complete with actual test evidence. Implement only packaging configuration, audit tooling, missing acceptance coverage, and defects directly discovered during qualification. Inputs: production builds, clean browser profiles, clean desktop installations on Windows/macOS/Linux, and the hardware/environment matrix in §1.6. Expected outputs: packaging configuration, `tests/e2e/acceptance/`, `tests/performance/qualification/`, `docs/RELEASE_CHECKLIST.md`, `docs/PERFORMANCE_REPORT.md`, and generated web/desktop release artifacts when the host/toolchain supports them. Verify offline behavior, asset licensing, security boundaries, crash recovery, accessibility, bounded one-hour memory, and latency percentiles/maxima. Report unsigned/unavailable platform artifacts and missing physical latency tests explicitly; never mark untested targets as qualified. No new features. Update the handoff with remaining release blockers.

### 7.2 Release acceptance gates

| Gate | Required evidence |
|---|---|
| Architectural | One renderer artifact across targets; no Node/Electron imports in domain/UI; no remote runtime dependency |
| Offline | Every mode, sound pack, profile action, and dashboard works after disconnect and restart; fresh desktop launch works offline |
| Correctness | Contract validation, scoring fixtures, grapheme semantics, progression, seeded generation, deadline and correction tests |
| Durability | Duplicate commits, interrupted saves, migrations, snapshot/journal recovery, quota errors, backup round trip |
| Isolation | Profile switch/save barriers and multi-tab ownership; no cross-profile content leakage |
| Performance | Application latency evidence and separately reported physical audio/visual measurements; no universal claim beyond evidence |
| Accessibility | Keyboard navigation, focus, zoom, contrast, reduced motion, chart equivalents, composition compatibility |
| Continuity | Handoff names actual files, versions, checks, known failures, and the next bounded task |

The earliest critical decision is M09's feasibility result. Continue functional development with clearly recorded limits if hardware cannot meet the requested end-to-end SLA; qualifying a release against that strict SLA remains blocked until the target environments have measured supporting evidence.
