# WORK_STATE — Recovery Checkpoint

Last updated: `2026-09-20T23:49:34Z` (UTC)
Workspace: `/home/medys/WORKSPACE/FlashFinger`
Branch: `master`
Repository state: working tree contains the prior uncommitted M02/M03/M04 work and the M05 changes; unrelated changes were preserved.

## Current status

**M01 — Record contracts and test fixtures is complete.**
**M02 — Shared Vite and secure Electron shell is complete.**
**M03 — Pure typing and timing engine is complete.**
**M04 — Browser IndexedDB persistence is complete.**
**M05 — Desktop durable repository is complete.**

The next eligible prompts are the post-persistence tasks in `docs/DESIGN_SPECIFICATION.md`; this handover stopped after M05 as requested.

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

## Last verification

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | All application, Electron, and test TypeScript configs pass with no errors. |
| `npm test` | 0 | 5/5 test files and 165/165 tests pass, including native headless-Chrome IndexedDB coverage and 20 M05 cases. |
| `npm run build` | 0 | TypeScript and Vite production build pass; 26 modules transformed; renderer output is 272.96 kB / 82.91 kB gzip; Vite build duration 128 ms. |
| `npm run electron:compile` | 0 | Main, preload, storage, IPC, and imported contracts compile to the Electron CommonJS output. |
| M05 suite on `/tmp` (`tmpfs`) | 0 | 20/20 tests pass, including all seven compaction cut points. |
| M05 suite with workspace `TMPDIR` (`ext2/ext3` reported by `stat`) | 0 | 20/20 tests pass, including all seven compaction cut points. |

The initial sandboxed `npm test` attempt exited 1 with 144/145 passing because the native-browser test could not bind `127.0.0.1` (`listen EPERM`). Re-running the same full suite with loopback-port permission produced the passing result above. Tests and build emitted the existing non-failing Vite warning that `__dirname` is incompatible with the future native config loader default.

## Known verification limits

- Native-browser coverage ran in installed headless Google Chrome only; Firefox and Safari were not available.
- True multi-window Web Lock contention, browser eviction/private mode, and a physical quota-exhaustion condition were not exercised. Lease contention and quota rollback were tested deterministically with fake IndexedDB/fault injection.
- Desktop crash recovery ran on Linux tmpfs and the workspace filesystem reported as ext2/ext3. Windows/NTFS and macOS/APFS were unavailable, so M05 is not yet crash-qualified on all three target filesystem families.
- No real Electron `BrowserWindow` automation was launched; IPC sender logic was exercised with deterministic event doubles, while Electron TypeScript compilation passed.
- Physical power-loss/fsync behavior, disk-full during compaction, symlink attacks by a same-user local adversary, and multi-process access outside the enforced single-instance app were not exercised.
- Backup import/export intentionally returns `unsupported` until M16.

## Next handover action

Proceed from the M05-complete state. Desktop uses only the main-owned journal/snapshot authority; browser continues to use IndexedDB. Do not introduce dual writes. M11 should rely on `Repository.commitSession` acknowledgement as the durable finalization boundary, and M16 should replace the explicit backup stubs with staged validated import/export.
