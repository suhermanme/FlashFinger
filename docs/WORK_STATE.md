# WORK_STATE — Recovery Checkpoint

Last updated: `2026-09-21T08:09:03Z` (UTC)
Workspace: `/home/medys/WORKSPACE/FlashFinger`
Branch: `master`
Repository state: working tree contains the completed M06–M10 tranche on top of committed M01–M05; changes remain uncommitted.

## Current status

**M01 — Record contracts and test fixtures is complete.**
**M02 — Shared Vite and secure Electron shell is complete.**
**M03 — Pure typing and timing engine is complete.**
**M04 — Browser IndexedDB persistence is complete.**
**M05 — Desktop durable repository is complete.**
**M06 — Profile orchestration and Zustand stores is complete.**
**M07 — Theme and accessible shell is complete.**
**M08 — Native input adapter and text viewport is complete.**
**M09 — Low-latency audio implementation/feasibility spike is complete; physical-output qualification remains open.**
**M10 — Bounded feedback effects is complete.**

The next eligible prompt is M11, session lifecycle and durable result integration.

The authoritative completion record is `docs/IMPLEMENTATION_STATUS.md`; design choices are in `docs/DECISIONS.md`; detailed M01 evidence is in `docs/tasks/M01.md`, M02 in `docs/tasks/M02.md`, M03 in `docs/tasks/M03.md`.

## Completed M01 outputs

- Contracts: `src/contracts/{models,repository,platform,training,validation}.ts`
- Central versions: `src/contracts/versions.ts`
- Deterministic fixtures: `tests/fixtures/contracts/index.ts`
- Status and decisions: `docs/{IMPLEMENTATION_STATUS,DECISIONS}.md`

Validation entry points cover every persisted/imported §2.1 record, nested backup payloads, field and enum constraints, ownership references, and newer schema/backup/metric/curriculum versions. The fixture set contains two profiles, completed and interrupted sessions, a failed lesson, empty history, and a completed session with day slices on both sides of Jakarta midnight.

## Completed M02 outputs

- Electron shell: `electron/{main,preload,protocol}.ts`
- Renderer bootstrap: `src/app/{bootstrap,App}.tsx`
- Platform factory: `src/platform/{factory,mock-repository}.ts`
- Integration test: `tests/integration/shell.test.ts`
- Entry point: `index.html`

Browser root build produces index.html + JS bundle. Platform factory detects browser target. Mock repository returns unavailable on every method. Preload bridge whitelist rejects unknown channels. No Node/Electron imports leak into renderer.

## Completed M03 outputs

- Engine: `src/domain/typing/engine.ts` (TypingEngine + TextBuffer, state machine, command/delta processing)
- Clock: `src/domain/typing/clock.ts` (monotonic clock, pause, deadline, reset)
- Types: `src/domain/typing/types.ts` (EngineState, EngineCommand, EngineDelta, constants)
- Ledger: `src/domain/typing/ledger.ts` (bounded circular buffer, 512 entries)
- Metrics: `src/domain/metrics/formulas.ts` (canonical formulas §4.1, rolling WPM, daily aggregate, sample)
- Engine tests: `tests/unit/typing.test.ts` (61 tests)
- Metrics tests: `tests/unit/metrics.test.ts` (30 tests)

Grapheme segmentation: `TextBuffer` uses `Intl.Segmenter('en', { granularity: 'grapheme' })` via `segmentGraphemes()` helper. Verified: ZWJ emoji (👩‍💻), regional indicator pairs (🇮🇩), decomposed combining marks (e + U+0301), mixed sequences. 11 dedicated tests added after fixing `[...text]` spread which incorrectly split these multi-codepoint graphemes.

The 55 M03 test-source typing errors reported after M04 are fixed without runtime changes: the shared typing fixture helper now declares its `EngineOptions` return type, preserving the `TerminationRule` discriminants at all 49 call sites, and the six eligibility fixtures explicitly provide `backspaces: 0` as required by `MetricInput`.

## Completed M04 outputs

- Browser schema/transaction layer: `src/platform/web/database.ts`
- Sequential structural migration registry: `src/platform/web/migrations.ts`
- Full IndexedDB repository adapter: `src/platform/web/repository.ts`
- Web Lock plus transactionally fenced per-profile lease coordinator: `src/platform/web/ownership.ts`
- Browser/fake-IndexedDB integration coverage: `tests/integration/web-repository.test.ts`
- Browser platform wiring: `src/platform/factory.ts`

IndexedDB is the browser authority. Final session, series, day slices, mistake/exposure sources, lesson progress, aggregate replacements, character-stat changes, and checkpoint removal share one transaction. Duplicate session UUIDs return `alreadyCommitted` before derived writes. Profile deletion is a single cross-store transaction. Daily and character aggregates rebuild from retained sources. No production M04 code reads or writes LocalStorage.

The integration suite covers transaction rollback on injected quota failure, duplicate idempotency, profile isolation/cascade deletion, failed migration rollback and newer-version rejection, stale-tab checkpoint fencing, opaque cursor pagination including equal timestamps, storage status, and aggregate rebuilds. One test launches installed headless Google Chrome and exercises native IndexedDB commit/idempotency/cascade behavior; the remaining transaction matrix uses `fake-indexeddb`.

## Completed M05 outputs

- Main-owned state and mutation repository: `electron/storage/repository.ts`
- Framed SHA-256 journal and replay: `electron/storage/journal.ts`
- Checksummed snapshots and crash-safe rotation: `electron/storage/snapshot.ts`
- Versioned desktop state/migration boundary: `electron/storage/migrations.ts`
- Validated main-process router: `electron/ipc/repository.ts`
- Typed renderer adapter: `src/platform/desktop/repository.ts`
- Preload/main/factory wiring: `electron/{preload,main,protocol}.ts`, `src/platform/factory.ts`
- Integration coverage: `tests/integration/desktop-repository.test.ts` (20 tests)

The desktop repository serializes writes in the main process. Each logical mutation is applied to a cloned state, encoded in one length-delimited SHA-256 frame, appended, and fsynced before it becomes visible or returns success. Session UUID retries short-circuit before derived effects. Replay discards and fsync-truncates only an incomplete final frame; invalid framing, checksum damage, or sequence gaps fail closed as `corrupt`.

Compaction writes/fsyncs/verifies a temporary snapshot, atomically replaces the current snapshot while retaining one prior snapshot, and only then rotates the journal while retaining its prior generation. Snapshot sequence fencing makes both pre-rotation and post-rotation crash states replay-safe. Seven injected cut points cover each durable phase.

IPC uses one raw transport channel with a closed method whitelist, 8 MiB JSON request/response caps, exact arity/scalar checks, current protocol gating, main-frame validation, expected `webContents` ID, and the `flashfinger://app` origin. Repository paths are fixed confined basenames below Electron's `userData/repository`; no renderer filesystem primitive is exposed. Retained documents are capped at 5 MiB and journal records at 8 MiB.

## Completed M06–M10 outputs

- Profile/state: `src/state/`, `src/app/profileCoordinator.ts`, `src/features/profiles/`
- Theme/shell: `src/styles/`, `src/app/themeController.ts`, `src/components/`, `src/features/settings/`
- Input/viewport: `src/features/typing/`, `src/engines/visual/{layout,caret,textRenderer}.ts`
- Audio: `src/engines/audio/`, `public/assets/sounds/test-pack/`, `public/content/sound-packs.json`
- Feedback: `src/engines/visual/{effects,keyFeedback,motion}.ts`
- Tests: five new integration files plus `tests/performance/`
- Evidence: `docs/PERFORMANCE_BASELINE.md`

Profile requests are generation-fenced; active/unsaved work blocks destructive profile transitions; metrics publish at no more than 4 Hz. Theme snapshots resolve semantic CSS tokens once per actual palette/motion change. Input is normalized through a native textarea and the imperative viewport mounts at most five lines/2,048 graphemes while preserving state across remounts. Audio is gesture-created, prepared ahead of ready, bounded to two decoded packs/16 MiB and 24 voices, and fails closed to muted training. Optional completion/key/caret motion is pooled, reduced-motion aware, and cancelled on pause/unmount.

## Last verification

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | All application, Electron, and test TypeScript configs pass with no errors. |
| `npm test -- --reporter=dot` | 0 | 11/11 test files and 199/199 tests pass, including native headless-Chrome IndexedDB coverage and the M06–M10 suites. |
| `npm run build` | 0 | TypeScript and Vite production build pass; renderer JS is 272.06 kB / 82.51 kB gzip and CSS is 15.87 kB / 4.17 kB gzip. |
| `npm run electron:compile` | 0 | Main, preload, storage, IPC, and imported contracts compile to the Electron CommonJS output. |
| Native Chrome scheduling harness | 0 | 10,000 decoded triggers: p99 0.20 ms, max 2.20 ms. |
| Native Electron scheduling harness | 0 | 10,000 decoded triggers: p99 0.20 ms, max 4.50 ms. |
| M05 suite on `/tmp` (`tmpfs`) | 0 | 20/20 tests pass, including all seven compaction cut points. |
| M05 suite with workspace `TMPDIR` (`ext2/ext3` reported by `stat`) | 0 | 20/20 tests pass, including all seven compaction cut points. |

The initial sandboxed `npm test` attempt exited 1 with 144/145 passing because the native-browser test could not bind `127.0.0.1` (`listen EPERM`). Re-running the same full suite with loopback-port permission produced the passing result above. Tests and build emitted the existing non-failing Vite warning that `__dirname` is incompatible with the future native config loader default.

## Known verification limits

- Native-browser coverage ran in installed headless Google Chrome only; Firefox and Safari were not available.
- True multi-window Web Lock contention, browser eviction/private mode, and a physical quota-exhaustion condition were not exercised. Lease contention and quota rollback were tested deterministically with fake IndexedDB/fault injection.
- Desktop crash recovery ran on Linux tmpfs and the workspace filesystem reported as ext2/ext3. Windows/NTFS and macOS/APFS were unavailable, so M05 is not yet crash-qualified on all three target filesystem families.
- A real headless Electron `BrowserWindow` ran the audio scheduling harness; repository IPC sender logic was still exercised only with deterministic event doubles.
- Physical power-loss/fsync behavior, disk-full during compaction, symlink attacks by a same-user local adversary, and multi-process access outside the enforced single-instance app were not exercised.
- Backup import/export intentionally returns `unsupported` until M16.
- Native audio numbers measure API scheduling only. Physical audible/visible onset, audio quality, real keyboard input-to-paint, non-Chromium browsers, Windows/macOS, constrained CPU, and endurance remain unqualified; see `docs/PERFORMANCE_BASELINE.md`.

## Next handover action

Proceed from the M10-complete state with M11 only. Desktop uses the main-owned journal/snapshot authority; browser uses IndexedDB. Do not introduce dual writes. M11 should compose the existing profile barrier, `TypingEngine`, `TypingSurface`, transient audio/feedback sinks, and `Repository.commitSession`; durable save acknowledgement is the finalization boundary. Keep an in-memory pending result on retryable failure. M16 remains responsible for replacing the explicit backup stubs with staged validated import/export.
