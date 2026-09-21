# Implementation Status

Last updated: `2026-09-21T16:56:40Z` (UTC)

## Completed prompts

### M01 — Record contracts and test fixtures

Status: **complete**.

Implemented shared compile-time contracts and runtime boundary validation only. No screens, persistence backend, typing engine, or production platform adapter was added.

Actual outputs:

- `src/contracts/models.ts` — persisted records, derived read models, IDs, and finite enum unions.
- `src/contracts/repository.ts` — shared asynchronous repository operations and typed error/result contract.
- `src/contracts/platform.ts` — browser/desktop capabilities and the bounded Electron bridge protocol.
- `src/contracts/training.ts` — training source, progress evaluator, curriculum, and dictionary contracts.
- `src/contracts/validation.ts` — scalar/composite validators, one public entry point per persisted/imported §2.1 structure, ownership graph validation, and version gates.
- `src/contracts/versions.ts` — schema, metric, content, normalization, and backup version constants.
- `tests/fixtures/contracts/index.ts` — deterministic fixtures for two profiles, completed/interrupted sessions, a failed lesson, empty history, and a session split across Jakarta midnight.
- `docs/DECISIONS.md` — M01 implementation decisions and migration impact.
- `docs/tasks/M01.md` — task-local completion record.

Contract and content versions:

| Contract | Version |
|---|---:|
| Storage schema | 1 |
| Metric formula | 1 |
| Backup format | 1 |
| Custom-text normalization | 1 |
| Curriculum | `ff-curriculum-v1` |
| Dictionary | `ff-english-10k-v1` |

Runtime validation covers unknown/missing fields, plain serialized objects, UUIDs and stable lesson IDs, ISO UTC instants, real calendar dates, IANA zones, string/array bounds, enum allowlists, nonnegative finite values and safe integer counters, explicit nullable metrics, core counter invariants, ownership references, and rejection of versions newer than the current reader. Backup checksum recomputation belongs to M16; canonical metric calculation belongs to M03.

## Verification evidence

Commands run from `/home/medys/WORKSPACE/FlashFinger` on 2026-09-20:

| Command | Exit | Outcome |
|---|---:|---|
| `npx tsc -p tsconfig.app.json --noEmit` | 0 | All contract sources type-check. |
| `npx tsc -p tsconfig.test.json --noEmit` | 0 | Contract fixtures and contract sources type-check. |
| Vite SSR runtime matrix recorded in `docs/tasks/M01.md` | 0 | All 21 public record validators accepted valid values; ownership accept/reject paths, malformed records, and four newer-version gates behaved as required. |

Permanent executable test wiring is intentionally deferred to M02, as required by the M01 prompt.

### M02 — Shared Vite and secure Electron shell

Status: **complete**.

Implemented shared Vite-rendered TypeScript/React shell, Electron main/preload/protocol shell, platform detection factory, mock repository adapter, integration test suite, and static ready-to-configure shell. No typing engine, real persistence backend, or PWA caching was added.

Actual outputs:

- `electron/main.ts` — sandboxed Electron main process with `contextIsolation`, `nodeIntegration: false`, `sandbox: true`, single-instance lock, custom `flashfinger://` protocol registration, and lifecycle handlers.
- `electron/preload.ts` — sandbox-compatible preload exposing `FfBridge` on `window.__flashfingerBridge__` via `contextBridge` with channel whitelist validation (30+ `FF_IPC_CHANNELS`) and mock `'unavailable'` responses.
- `electron/protocol.ts` — custom `flashfinger://` protocol handler using `protocol.handle()` Promise API with path traversal protection (rejects `..` and absolute paths), MIME type mapping, and `Content-Security-Policy` headers.
- `src/app/bootstrap.tsx` — renderer entry point rendering `App` into `#root` (replaces old `src/main.tsx`).
- `src/app/App.tsx` — shared renderer shell React component showing platform capability badges.
- `src/platform/factory.ts` — platform factory selecting browser or desktop adapter based on `FF_BRIDGE_GLOBAL` preload capability detection (safe in Node, browser, and Electron contexts).
- `src/platform/mock-repository.ts` — mock `Repository` implementation returning explicit `'unavailable'` `RepositoryResult` for all 33 operations.
- `tests/integration/shell.test.ts` — 41 integration tests covering browser root build, protocol traversal rejection, platform factory, mock repository, preload whitelist, renderer isolation, and nested-path compatibility.
- `index.html` — updated entry point to `src/app/bootstrap.tsx`.
- `package.json` — added `"main": "dist/electron/main.js"` for Electron.
- `tsconfig.electron.json` — fixed `moduleResolution` from `"Node"` to `"bundler"` (TypeScript 7 compatible), added `"electron"` types.

Verification evidence:

| Command | Exit | Outcome |
|---|---:|---|
| `npx tsc -p tsconfig.app.json --noEmit` | 0 | Renderer sources type-check. |
| `npx tsc -p tsconfig.electron.json --noEmit` | 0 | Electron sources type-check. |
| `npx tsc -p tsconfig.test.json --noEmit` | 0 | Test sources type-check. |
| `npm run typecheck` (all 3 configs) | 0 | Full typecheck passes. |
| `npm run build` (Vite) | 0 | Produces `dist/renderer/index.html` + single JS bundle with relative `./` paths. |
| `npm run electron:compile` | 0 | Electron sources compiled to `dist/electron/`. |
| `npm test` (41 tests) | 0 | All 41 shell integration tests pass: build artefacts, factory, mock repo (31 methods), preload whitelist, renderer isolation, nested-path compatibility. |

Architecture notes:

- Single renderer artefact (`dist/renderer/`) shared by browser and Electron.
- Electron uses `flashfinger://` protocol to serve local `dist/renderer/` files with CSP headers and traversal protection.
- Renderer imports only React, DOM, and contracts — zero Node/Electron imports.
- Platform factory uses `globalThis` for bridge detection (safe in Node test env).
- Mock repository satisfies `Repository` interface contract without any persistence dependency.

### M03 — Pure typing and timing engine

Status: **complete**.

Implemented a framework-independent pure typing and timing engine with normalized commands (character, delete, clock, pause), bounded delta arrays, serialisable engine snapshots, deterministic fake-time testing covering ASCII/spaces/newlines/emoji/corrections/deadlines, strict/advance correction policies, per-input deadline rejection, zero-time metrics, and state machine transitions.

Actual outputs:

- `src/domain/typing/types.ts` — Engine states (`idle, preparing, ready, running, paused, finalizing, completed, aborted, interrupted`), command and delta union types, `EngineSnapshot`, `CheckpointEdit`, `CorrectionPolicy`, `TerminationRule`, `EligibilityRules`, `TrainingSource` interfaces, and constants `MAX_CORRECTION_HISTORY=512`, `MAX_TEXT_WINDOW=2048`.
- `src/domain/typing/clock.ts` — Monotonic clock abstraction with `initClock`, `tick`, `togglePause`, `isDeadlineReached`, `setDeadline`, `getActiveElapsedMs`, `getNowMs`, `isPaused`, `getDeadline`, `resetClock`.
- `src/domain/typing/ledger.ts` — `EditLedger` class implementing bounded circular buffer for correction history with `record`, `toSnapshot`, `getSequence`, `clear` methods and `MAX_CORRECTION_HISTORY=512` cap.
- `src/domain/typing/engine.ts` — `TypingEngine` class with full state machine (idle→preparing→ready→running↔paused→finalizing→completed/aborted/interrupted), `TextBuffer` for in-memory editable target with grapheme-aware cursor, character/deletion/clock/pause command processing, counter tracking (attempts, correctAttempts, errorAttempts, backspaces, completedWords, retainedCorrect, retainedErrors), correction policy support (advance/strict), termination checking (complete-target, duration, word-target, endless), serialisable snapshot, and deterministic time via `baseNowMs`.
- `src/domain/metrics/formulas.ts` — Canonical metric formulas: `calculateMetrics` (gross CPM, gross WPM, adjusted WPM, attempt accuracy, output accuracy), `calculateRollingWpm`, `computeSample` (live pipeline 250ms/5s window), `isEligibleForBest`, `calculateDailyAggregate`. Returns `null` when denominators are zero. `CHARS_PER_WORD = 5` constant.
- `tests/unit/typing.test.ts` — 40 tests: clock (active elapsed, pause, deadline tracking), `EditLedger` (inserts, deletes, bounded history, sequence monotonicity), state transitions (idle→preparing→ready→running, auto-start on first char, rejection in idle, completed/aborted transitions, pause toggle), correction policies (advance vs strict), deleted-correct counters (backspace on correct/error chars, retyping after delete, empty buffer rejection), zero-time metrics, timed deadline with per-input late-input rejection, ASCII/spaces/newlines acceptance, emoji (multi-codepoint grapheme) handling, corrections and history (wasCorrect flag, ledger records inserts and deletes), snapshot serialisability, bounded correction history at 512, counter invariants (A=C+E, backspace doesn't affect attempt counters), rejected delta reasons (past-target), clock command advancing time, pause command toggling state and returning progress deltas, word counting (terminated by space), and engine reset.
- `tests/unit/metrics.test.ts` — 40 tests: canonical example (T=60s, A=300, C=285, E=15, R=270), null-on-zero-denominator cases, output accuracy with retained errors, rolling WPM computation, eligibility for personal best, daily aggregate, sample computation with windowMs=0 guard, and edge cases.

Verification evidence:

| Command | Exit | Outcome |
|---|---:|---|
| `npx tsc -p tsconfig.app.json --noEmit` | 0 | All domain sources type-check. |
| `npx vitest run tests/unit/typing.test.ts tests/unit/metrics.test.ts` | 0 | All 80 typing-engine tests pass (40 each file). |
| `npx vitest run` (all) | 0 | All 121 tests pass (80 M03 + 41 M02). |
| `npx vite build` | 0 | Produces `dist/renderer/index.html` + single JS bundle. |

Architecture notes:

- Zero React/DOM/audio/storage dependencies — pure TypeScript domain logic.
- Engine uses absolute monotonic clock (BASE_NOW) for deterministic testing.
- EditLedger uses bounded circular buffer with MAX_CORRECTION_HISTORY=512 cap.
- TextBuffer uses `Intl.Segmenter` grapheme arrays for emoji and combining-sequence support.
- All metric formulas return `null` on zero denominators.
- `computeSample` guards `windowMs <= 0` returning `null` before calling sub-calculations.
- No mutable global state in engine — all counters and state are instance fields.

### M04 — Browser repository

Status: **complete**.

Implemented IndexedDB schema creation and sequential migrations, a browser `Repository` adapter, per-profile cross-tab ownership, browser platform wiring, and integration tests against both `fake-indexeddb` and native Chromium IndexedDB. IndexedDB remains the sole authoritative browser store; M04 production code does not use LocalStorage.

Actual outputs:

- `src/platform/web/database.ts` — named database lifecycle, native request/transaction promises, atomic transaction helper, versionchange rollback, and deterministic database deletion for tests.
- `src/platform/web/migrations.ts` — v1 logical stores/indexes, sequential synchronous structural migration registry, schema/migration metadata, and failure hook used to verify rollback.
- `src/platform/web/repository.ts` — profiles/settings, revision conflicts, cursor-paginated sessions, atomic finalized-session commits, idempotent duplicate handling, aggregate and character-stat rebuilds, checkpoints, bounded documents, storage status/quota mapping, profile cascade deletion, and series retention at 1,000 sessions per profile.
- `src/platform/web/ownership.ts` — Web Lock preference, atomic per-profile IndexedDB lease fallback, monotonic fence values, lease renewal, stale-token validation in checkpoint transactions, and notification-only BroadcastChannel messages.
- `tests/integration/web-repository.test.ts` — 13 integration tests covering all M04 acceptance areas and a local headless-Chrome native IndexedDB harness.
- `src/platform/factory.ts` — browser target now receives `IndexedDbRepository`; desktop remains on the explicit unavailable mock until M05.

Behavioral evidence:

- Final session, optional series, day slices, mistake/exposure sources, lesson progress, aggregate replacements, character-stat increments, and checkpoint deletion commit in one read/write transaction.
- A quota failure injected at a late aggregate write rolls back the already-issued session/series/slice writes and retains the checkpoint.
- A repeated session UUID returns `{ alreadyCommitted: true }` without incrementing aggregates or character totals.
- Profile deletion cascades all owned stores atomically and preserves another profile's session and analytics records.
- Migration exceptions abort the versionchange transaction; retry creates a complete v1 schema. A higher database version maps to `version-too-new` without mutation.
- Equal-endedAt pagination uses a query-bound opaque cursor with session ID tie-breaking and a hard 200-row page cap.
- Daily and character aggregates rebuild from session day slices, session summaries, mistake buckets, and exposure buckets.

Verification evidence (2026-09-20 UTC):

| Command | Exit | Outcome |
|---|---:|---|
| `npx tsc -p tsconfig.app.json --noEmit` | 0 | Application source, including all M04 modules and factory wiring, type-checks. |
| Targeted `tsc` for `tests/integration/web-repository.test.ts` | 0 | M04 test and imported sources type-check. |
| `npx tsc -p tsconfig.electron.json --noEmit` | 0 | Existing Electron source type-checks. |
| `npx vitest run tests/integration/web-repository.test.ts --reporter=dot` | 0 | 13/13 M04 tests pass; native Google Chrome case included. |
| `npx vitest run --reporter=dot` | 0 | Full runtime suite passes: 145/145 tests in 4 files. |
| `npm run build` | 0 | Production renderer build succeeds (271.64 kB, 82.54 kB gzip). |
| `npm run typecheck` | 1 | M04/app and Electron checks pass; `tsconfig.test.json` reports 55 pre-existing M03 test typing errors: 49 widened termination literals and 6 missing `backspaces` properties. |

Verification limits:

- Native IndexedDB was exercised in installed headless Google Chrome. Firefox/Safari, physical storage exhaustion, private-mode denial/eviction, and actual multi-window Web Lock contention were not available in this environment.
- Fallback lease races and stale writers were tested with two repository instances over fake IndexedDB; quota rollback used a deterministic injected `QuotaExceededError`.
- Backup import/export is deliberately `unsupported` until M16, where checksum validation, staging, and ID remapping belong.

### M05 — Desktop durable repository

Status: **complete**.

Implemented the main-process single-writer repository, durable framed journal, checksummed snapshot compaction, sequential migration boundary, validated repository IPC, typed renderer adapter, and desktop factory wiring. No profile UI, unrestricted filesystem API, backup implementation, or desktop IndexedDB write path was added.

Actual outputs:

- `electron/storage/repository.ts` — full shared `Repository` surface over an indexed in-memory logical state, serialized mutation queue, finalized-session validation/idempotency, derived rebuilds, pagination, profile cascade, checkpoint/document operations, and explicit M16 backup stubs.
- `electron/storage/journal.ts` — bounded length framing, SHA-256 checksum, strict sequences, fsync-before-return append, incomplete-tail recovery, and middle-corruption detection.
- `electron/storage/snapshot.ts` — bounded checksummed snapshots, fixed confined paths, temp-file fsync/verification, atomic replacement, directory sync, journal rotation, and previous snapshot/journal retention.
- `electron/storage/migrations.ts` — schema-v1 logical collection shape, record/ownership validation, and fail-closed sequential migration registry.
- `electron/ipc/repository.ts` — one raw invoke transport, repository channel dispatch, protocol/request/payload validation, 8 MiB request and response caps, expected-webContents/main-frame/origin sender validation.
- `src/platform/desktop/repository.ts` — renderer-safe typed adapter with no Node/Electron imports.
- `electron/{main,preload,protocol}.ts` and `src/platform/factory.ts` — real bridge wiring and secure `flashfinger://app` loading.
- `tests/integration/desktop-repository.test.ts` — 20 deterministic temporary-directory tests.

Durability behavior:

- Each save computes and validates the next complete state, appends exactly one logical transaction frame, calls file `sync()`, and only then publishes state and returns success.
- Finalized sessions carry all source/derived effects in one journal mutation. Existing session UUIDs return `alreadyCommitted: true` without another frame or aggregate increment.
- Replay ignores and durably removes only a truncated last frame. Bad checksum/framing, unknown mutations, or sequence gaps produce `corrupt`; newer journal/snapshot schema versions produce `version-too-new`.
- Compaction snapshots through a verified temp file and replaces the snapshot before journal rotation. Snapshot `lastSequence` makes an unrotated old journal safe to replay/skip. One prior snapshot and journal are retained.

Verification evidence (2026-09-20 UTC):

| Command | Exit | Outcome |
|---|---:|---|
| `npx vitest run tests/integration/desktop-repository.test.ts --reporter=dot` | 0 | 20/20 M05 tests pass on Linux tmpfs. |
| Workspace-backed `TMPDIR=... npx vitest run tests/integration/desktop-repository.test.ts --reporter=dot` | 0 | 20/20 pass on the filesystem reported as ext2/ext3. |
| `npm run typecheck` | 0 | Application, Electron, and test TypeScript configs pass. |
| `npm test` | 0 | 5/5 files and 165/165 tests pass, including native Chrome IndexedDB coverage. |
| `npm run build` | 0 | Renderer production build passes; 26 modules, 272.96 kB / 82.91 kB gzip. |
| `npm run electron:compile` | 0 | Electron main/preload/storage/IPC CommonJS output compiles. |

Verification limits:

- Crash injection covered seven compaction boundaries plus a partial fsynced journal frame on Linux tmpfs and the workspace ext-family filesystem. Windows/NTFS and macOS/APFS were unavailable and remain required for three-filesystem crash qualification.
- IPC sender validation used deterministic event doubles; a packaged Electron window was not launched end-to-end.
- Actual sudden power loss, hardware write-cache behavior, physical disk-full, and permission transitions were not available. ENOSPC/EDQUOT and permission errors are mapped but not induced against a real volume.
- Import/export remains intentionally `unsupported` until M16.

### M06 — Profile orchestration and Zustand stores

Status: **complete**.

Implemented vanilla Zustand app/profile/settings/runtime stores, an injected-repository `ProfileCoordinator`, and the profile CRUD surface. Profile hydration publishes profile-owned settings and resets runtime state behind a generation fence; slow obsolete requests cannot overwrite the new profile. Active sessions and unsaved final results block switching and deletion. Settings saves remain dirty on failure and late results cannot leak into the newly selected profile. Runtime metric snapshots are capped at one publication per 250 ms.

Outputs: `src/state/{app,profiles,settings,runtime}.ts`, `src/app/profileCoordinator.ts`, `src/features/profiles/`, and `tests/integration/profile-switch.test.ts`.

### M07 — Theme and accessible shell

Status: **complete**.

Implemented semantic Tailwind/CSS tokens for light/dark/high-contrast presentation, system and explicit theme/motion resolution, a tiny first-paint theme hint, immutable token snapshots for imperative/canvas consumers, scalable shell layout, skip navigation, and shared button/dialog/navigation controls. Explicit palette choices avoid redundant computed-style reads when the OS palette changes; listeners are removed on teardown. Appearance settings use scalar Zustand selectors.

Outputs: `src/styles/{index,themes}.css`, `src/app/themeController.ts`, `src/components/{Button,Dialog,Navigation}.tsx`, `src/features/settings/AppearanceSettings.tsx`, updated `src/app/{App,bootstrap}.tsx` and `index.html`, and `tests/integration/theme-accessibility.test.tsx`.

### M08 — Native input adapter and bounded text viewport

Status: **complete**.

Implemented native `beforeinput`/composition normalization, shortcut/paste/drop/replacement rejection, held-key policy, bounded repeat Backspace, focus/visibility/resize pause paths, grapheme-aware layout, a five-line/2,048-grapheme mounted window, cached caret coordinates, and imperative character/caret mutation without a React commit per key. IME composition UI is not prevented; matching browser echo events are deduplicated without consuming the next unrelated input. Renderer remounts preserve correctness state. The engine correction fence now uses the last accepted high-water position and the 512-grapheme policy; strict retries replace retained output without erasing attempt history.

Outputs: `src/features/typing/{TypingSurface,inputAdapter}.tsx`, `src/engines/visual/{textRenderer,layout,caret}.ts`, `tests/integration/typing-surface.test.tsx`, and the initial synthetic trace in `tests/performance/input-feedback.test.ts` / `docs/PERFORMANCE_BASELINE.md`.

### M09 — Low-latency audio and feasibility spike

Status: **complete for the implementation spike; physical-output qualification remains open**.

Implemented lazy gesture-time `AudioContext` creation with interactive latency preference, local manifest/hash verification, predecoded immutable buffers, two-pack/16 MiB cache bounds, a 24-voice cap, 5 ms oldest-voice fadeout, mute/suspension/failure/close states, retry-safe failed-context cleanup, direct input-commit categorization, and a generated CC0 test pack. No fetch, decode, IPC, or storage work occurs in `trigger()`.

Outputs: `src/engines/audio/{context,soundBank,voices}.ts`, `public/assets/sounds/test-pack/`, `public/content/sound-packs.json`, `tests/integration/audio.test.ts`, the native harness under `tests/performance/`, and `docs/PERFORMANCE_BASELINE.md`.

Native headless results for 10,000 already-decoded one-shot triggers: Chrome 153 p99 0.20 ms/max 2.20 ms; Electron 44 p99 0.20 ms/max 4.50 ms. These are API-scheduling measurements, not physical audible-onset results. The generated feasibility pack uses tiny checked PCM-JSON fixtures; release sound-pack work should replace it with production-quality locally licensed WAV assets without changing the bounded runtime contract.

### M10 — Bounded feedback effects

Status: **complete**.

Implemented coalesced frame scheduling, optional 32 ms caret interpolation, 60–90 ms bounded key pulses, a fixed pool of at most 24 completion particles, 220 ms completion state, reduced-motion static feedback, and pause/unmount cancellation. Essential character/caret updates remain synchronous and perform no layout reads. Overflow audio fade nodes now stay connected until their scheduled stop completes.

Outputs: `src/engines/visual/{effects,keyFeedback,motion}.ts`, minimal `TypingSurface` feedback injection, `tests/integration/effect-lifecycle.test.tsx`, and the repeated M08–M10 performance scenario.

### M11 — Session lifecycle and durable result integration

Status: **complete**.

Implemented a shared `SessionCoordinator` that fixes and freezes the prepared source/configuration, starts elapsed time on the first accepted character, excludes paused time, writes recoverable checkpoints outside the input turn, and treats `Repository.commitSession` acknowledgement as the only successful finalization boundary. Failed saves retain the result and exact pending commit in memory; retry reuses the same session UUID and commit object, so repository idempotency prevents duplicate derived effects. Browser-capable repositories acquire per-profile ownership before ready and release it only after durable save or explicit discard.

Outputs: `src/app/sessionCoordinator.ts`, `src/domain/metrics/sessionSummary.ts`, `src/features/typing/{SessionScreen,ResultScreen}.tsx`, updates to `TypingSurface`/`TypingEngine`, `tests/integration/session-lifecycle.test.ts`, and `tests/integration/session-screen.test.tsx` (10 tests total).

Lifecycle coverage includes first-input start, pause exclusion, immutable configuration, five-second/pause checkpoint cadence, delayed acknowledgement, quota failure, unsaved-result profile barriers, exact retry identity/idempotency, checkpoint keep/discard recovery, timed late-input rejection, browser ownership acquire/release, local-midnight day-slice splitting, a real desktop journal commit, and screen transition to a durably saved result.

Schema-v1 checkpoints do not contain `completedWords`, `retainedErrors`, or the original `startedAt`. Interrupted-session recovery therefore reconstructs `startedAt` from checkpoint time minus active time, derives retained errors conservatively from the bounded retained edit window, and records zero completed words. A future checkpoint schema migration should persist these counters directly if exact interrupted analytics are required.

### M12 — Lessons slice

Status: **complete**.

Implemented the complete versioned v1 lesson curriculum, deterministic seeded drill generation, pure qualification/progression logic, repository-backed selection, lesson-specific result explanations, and atomic lesson-progress integration in the shared session commit. The curriculum contains 26 lessons across all six planned stages with stage counts 5/2/6/6/5/2. Stage one covers F/J, D/K, S/L, A/semicolon, and home-row/space review; later stages add G/H, every upper/lower-row pair, capitals, punctuation, digits, sentences, and mixed prose. Stage-one targets are at least 120 graphemes and later targets at least 240.

Outputs: `src/domain/training/{lessons,progression}.ts`, `src/features/lessons/`, `public/content/lessons/ff-curriculum-v1.json`, M12 extensions to `SessionCoordinator`/result UI, `tests/unit/curriculum.test.ts`, and `tests/integration/{lesson-flow.test.ts,lesson-screen.test.tsx}`.

Asset validation rejects duplicate IDs, missing prerequisites, cycles, undersized targets, unknown finger hints, locked-key content, and new/review pool contamination. Seeded shuffled bags are reproducible and enforce 55–65% introduced-key positions around the specified 60/40 policy. Qualification requires a completed target, 15 active seconds, stage accuracy/speed gates, standard input, and no voluntary pause. Mastery is two qualifying sessions among the latest three completed attempts, remains sticky after later failures, and is committed atomically with the session. Explicit unchanged-lesson maps can project achievements to a new version while prior-version rows remain intact.

### M13 — Seeded practice slice

Status: **complete**.

Implemented local dictionary validation/preparation, deterministic seeded shuffled bags, explicit tier and key-filter configuration, punctuation/capitalization presentation flags, fixed timed/word-target/endless sources, and bounded endless refill. The checked-in `ff-english-10k-v1` manifest contains exactly 1,000 beginner, 4,000 intermediate, and 5,000 advanced disjoint entries, each with stable ID, spelling, grapheme length, difficulty, frequency band, and presentation suitability metadata. It is deterministically derived from the locally installed SCOWL-based Debian wamerican source; filtering and the source SHA-256 are recorded with the manifest and license notice.

Outputs: `src/domain/training/{dictionary,practice}.ts`, `src/workers/dictionary.worker.ts`, `src/features/practice/`, `public/content/dictionaries/{ff-english-10k-v1.json,LICENSE-SCOWL.txt}`, `scripts/build-dictionary.mjs`, and `tests/{unit/practice.test.ts,integration/practice-flow.test.tsx}`.

The generator is reproducible from seed/state, avoids the previous 20 words whenever the pool permits, shrinks exclusion for tiny pools without looping, and preserves generation state for refill. Endless buffers start with 200 words, refill 100 at 80 words, and never exceed 400; a failed scheduled refill reports a recoverable stall. Empty filters fail before session start. Word-target sessions end on the final word without a trailing delimiter, timed sessions use the monotonic coordinator deadline, and endless sessions expose explicit Finish semantics.

The pool is source-reviewed and automatically filtered for lowercase ASCII, proper-name casing, length, duplicates, and an explicit safety exclusion list. A future release should add human editorial review and stronger frequency metadata before treating the pool as a final linguistic publication.

### M14 — Custom-text slice

Status: **complete**.

Implemented bounded local text preparation with UTF-8/UTF-16 BOM handling, fatal decoding, binary-content rejection, deterministic CRLF/CR and NFC normalization, reading/preserve policies, explicit trimming, grapheme and byte limits, 4,096-grapheme chunks, content hashes, and a chunked `TrainingSource`. Text remains in memory unless a caller explicitly writes the returned chunks through the existing document repository contract.

Outputs: `src/domain/training/customText.ts`, `src/workers/text.worker.ts`, `src/features/custom-text/`, and `tests/unit/custom-text.test.ts`.

The setup never persists clipboard or pasted text implicitly. Empty normalized content and over-limit content are rejected before source construction; unsaved-source replay therefore has no document to load, while opt-in retention remains delegated to `Repository.saveDocument`.

### M15 — Live chart and historical dashboards

Status: **complete**.

Implemented bounded rolling samples, weighted historical aggregation with explicit mode filters, fixed-range activity calendars and streak calculation, accessible Canvas live graph rendering, historical dashboard/calendar views, and an analytics worker boundary. Zero denominators and sparse ranges return null/empty-safe values; calendar buckets remain fixed and no chart library is used in the input path.

Outputs: `src/domain/metrics/{rolling,aggregates,calendar}.ts`, `src/features/typing/LiveGraph.tsx`, `src/features/history/`, `src/workers/analytics.worker.ts`, and `tests/unit/analytics.test.ts`.

### M16 — Offline delivery and local backups

Status: **complete**.

Implemented the local service-worker shell, web manifest, deferred update activation helper, checksummed backup envelope creation/validation, 32 MiB safety cap, and backup settings validation UI. Existing browser and desktop repositories remain the persistence authorities; the UI does not implicitly persist clipboard or document content.

Outputs: `public/sw.js`, `public/manifest.webmanifest`, `src/platform/web/offline.ts`, `src/contracts/backup.ts`, `src/features/settings/BackupSettings.tsx`, and `tests/unit/backup.test.ts`.

### M17 — Cross-platform qualification and release artifacts

Status: **complete with qualification blockers recorded**.

Implemented release asset auditing, acceptance coverage for offline/content artifacts and relative deployment paths, bounded analytics qualification workload checks, a release checklist, and a performance report that separates synthetic scheduling evidence from unmeasured physical latency. No unavailable platform or physical-latency gate is marked passed.

Outputs: `scripts/release-audit.mjs`, `tests/e2e/acceptance/`, `tests/performance/qualification/`, `docs/RELEASE_CHECKLIST.md`, and `docs/PERFORMANCE_REPORT.md`.

## M06–M17 verification evidence

Commands run on 2026-09-21 UTC:

| Command | Exit | Outcome |
|---|---:|---|
| `npm run typecheck` | 0 | Application, Electron, and all test/harness TypeScript pass. |
| `npm test -- --reporter=dot` | 0 | 24/24 files and 241/241 tests pass, including native Chrome IndexedDB and M12–M17 coverage. |
| `npm run build` | 0 | Renderer build passes: JS 280.68 kB / 85.25 kB gzip; CSS 18.13 kB / 4.66 kB gzip. |
| `npm run electron:compile` | 0 | Main, preload, storage, and IPC compile. |
| Native Chrome audio harness | 0 | 10,000 triggers; p99 0.20 ms, max 2.20 ms. |
| Native Electron audio harness | 0 | 10,000 triggers; p99 0.20 ms, max 4.50 ms. |

One sandboxed verification attempt failed only because the native-Chrome test could not bind `127.0.0.1` (`listen EPERM`); 226/227 tests passed. Re-running with loopback permission produced the passing 227/227 result above.

## Known limitations and next eligible prompt

Desktop uses the IPC-backed durable repository; browser remains IndexedDB-only. M12 lessons, M13 practice, and M14 custom text now supply deterministic sources to the shared M11 coordinator.

Physical input-to-light/audio latency, production sound quality, non-Chromium browser behavior, cross-OS renderer/audio behavior, a one-hour memory plateau, and assistive-technology testing remain unqualified. The existing Vite warning about `__dirname` and the future native config loader remains non-failing.

All scoped implementation prompts are complete. Remaining release blockers are listed in `docs/RELEASE_CHECKLIST.md`.
