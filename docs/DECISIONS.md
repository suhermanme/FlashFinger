# Architectural Decisions

## D-001 — Centralize contract versions

Date: 2026-09-20
Status: accepted in M01

Version constants live in `src/contracts/versions.ts` instead of being repeated across models and validators. This extra M01 file makes all readers compare against one storage schema, metric formula, content, normalization, and backup format version.

Migration impact: version increments must update this module and add the corresponding migration or compatibility reader. Numeric gates accept older versions for migration and reject newer versions with repository error code `version-too-new`.

## D-002 — Record input-policy facts in SessionConfig

Date: 2026-09-20
Status: accepted in M01

`SessionConfig` includes `compatibilityInput` and fixed `heldKeyRepeat: 'ignored'`. The §2.1 table omits these fields, but §3.2 requires compatibility sessions and repeat policy to be recorded, and §4.3 uses compatibility input when deciding eligibility.

Migration impact: these fields are required in schema v1 records. An importer for any earlier draft shape must supply explicit values rather than infer them after a session is committed.

## D-003 — Keep shape validation and ownership validation composable

Date: 2026-09-20
Status: accepted in M01

Each record has a standalone `validate*` entry point. Cross-record references use `validateOwnershipReferences` after record shapes pass. `validateBackupEnvelope` composes both steps. This lets repository transactions validate only the graph present in a write without requiring global state inside scalar validators.

Migration impact: repository/import implementations must validate shapes before invoking ownership checks. Checkpoints require an existing profile but not a finalized session because the checkpoint represents an active session.

## D-004 — Represent optional backup documents as an empty-or-populated collection

Date: 2026-09-20
Status: accepted in M01

The design table calls the backup field `optionalDocuments`, while the detailed retention rule says documents are excluded unless selected. `BackupPayloads.documents` is always present and is empty when documents were not selected. Each entry groups one `CustomDocument` with its chunks, keeping document ownership local and avoiding `undefined` in serialized data.

Migration impact: schema-v1 producers always emit `payloads.documents`. Future wire shapes that add an optional top-level field require a schema migration rather than silent acceptance.

## D-005 — Use named whitespace tokens in analytics buckets

Date: 2026-09-20
Status: accepted in M01

`WHITESPACE_TOKENS` contains `space`, `newline`, and `tab`; `GraphemeToken` otherwise represents one grapheme cluster. This gives analytics and accessible UI stable labels without retaining custom-text sequences.

Migration impact: aggregate migrations must preserve these stable token names. Unknown future token names are rejected until a versioned migration handles them.

## D-006 — Keep M01 fixtures as typed data modules

Date: 2026-09-20
Status: accepted in M01

Deterministic fixtures are exported from `tests/fixtures/contracts/index.ts` with fixed UUIDs, timestamps, zones, counts, and seeds. TypeScript `satisfies` checks keep literal values useful while verifying each contract at compile time. Permanent runner configuration remains M02 work.

Migration impact: schema changes must update the fixture module. Migration tests should retain copies of older serialized fixtures when those versions exist.

## D-007 — Use `protocol.handle()` Promise API for custom protocol

Date: 2026-09-20
Status: accepted in M02

Electron 44 bundles the modern `protocol.handle()` method which accepts standard Web `Request`/`Response` objects. The `flashfinger://` protocol handler in `electron/protocol.ts` uses this API instead of the deprecated `registerFileProtocol` callback style. This simplifies path resolution (uses standard URL APIs), avoids Node-stream plumbing, and makes CSP headers straightforward.

Migration impact: protocol implementations on Electron ≥27 are compatible. Downgrading Electron below 27 would require reverting to the callback-based `registerFileProtocol` API.

## D-008 — Guard platform factory with `globalThis` for test compatibility

Date: 2026-09-20
Status: accepted in M02

The `detectDesktopBridge()` function in `src/platform/factory.ts` reads `globalThis[FF_BRIDGE_GLOBAL]` instead of `window[FF_BRIDGE_GLOBAL]`. This allows the same factory code to run in Node (vitest test environment), browser, and Electron renderer contexts without conditional imports or build-time flags.

Migration impact: all platform adapters must follow this pattern for testability. Direct `window` references in shared code are anti-patterns.

## D-009 — Mock repository satisfies interface with explicit `unavailable` result

Date: 2026-09-20
Status: accepted in M02

`src/platform/mock-repository.ts` implements the full `Repository` interface but returns `RepositoryResult.err({ code: 'unavailable', retryable: true, message: ... })` for every method. This allows renderer shell, platform factory, and integration tests to exercise the full interface without any persistence dependency. The mock is used by default in `getPlatformAdapter()` when no real storage backend is wired (M04/M05).

Migration impact: the mock must be replaced by the real implementation in M04 (browser IndexedDB) and M05 (Electron durable storage). Method signatures in the mock must track any future `Repository` interface changes.

## D-010 — Engine is framework-independent pure TypeScript

Date: 2026-09-20
Status: accepted in M03

`TypingEngine` lives in `src/domain/typing/` with zero imports from React, DOM, audio, or storage modules. State transitions, command processing, and metric calculation all use deterministic absolute clock values (`baseNowMs`) for testability. The engine produces `EngineDelta[]` arrays and accepts `EngineCommand[]` — a serialisable, framework-agnostic interface. `EditLedger` enforces a bounded circular buffer (512 entries) for correction history, and `TextBuffer` uses grapheme-aware arrays via the spread operator for proper emoji/combining-character support.

Migration impact: future UI layers (M06+) must compose the engine through its command/delta interface rather than reaching into internal fields. Metric formulas in `src/domain/metrics/` are similarly pure and must be updated separately when the DESIGN_SPECIFICATION canonical definitions change.

## D-011 — Make IndexedDB versionchange the structural migration boundary

Date: 2026-09-20
Status: accepted in M04

Browser structural migrations are synchronous, sequential functions keyed by destination schema version. Schema objects plus `schemaVersion` and completed `migrationStatus` metadata are written in the same native `versionchange` transaction. Any thrown migration aborts the entire upgrade; missing sequential steps fail closed.

Migration impact: every future `SCHEMA_VERSION` increment must add exactly one structural step. Large backfills must use separately resumable metadata-gated work and must not keep a versionchange transaction open with unrelated asynchronous work.

## D-012 — Keep finalized sources and derived mutations in one IndexedDB transaction

Date: 2026-09-20
Status: accepted in M04

`commitSession` validates the finalized session and day-slice equivalence, then writes the session, optional series, slices, mistakes, exposures, lesson progress, supplied daily aggregate replacements, character-stat changes, and checkpoint removal in one transaction. The session UUID is checked before any effect write. Daily and character aggregates can be deleted and reproduced from retained source stores.

Migration impact: new finalized-session effects must join this transaction or remain independently rebuildable; they must not be acknowledged by a second authoritative write. Schema changes must preserve session UUID idempotency and source data needed by rebuilds.

## D-013 — Fence browser ownership with a per-profile IndexedDB lease

Date: 2026-09-20
Status: accepted in M04

The ownership coordinator prefers a held Web Lock and always records a per-profile IndexedDB lease containing owner ID, unique lease ID, expiry, and monotonically increasing fence. The fallback acquire operation is one read/write transaction. Checkpoint writes verify and renew that exact token in their own transaction. BroadcastChannel is used only for status notification.

Migration impact: M11 session coordination must acquire repository ownership before accepting input and retain the token until finalization/release. Any future checkpoint schema or IPC adapter must preserve transactional stale-token fencing; BroadcastChannel messages cannot authorize a write.

## D-014 — Defer backup mutation semantics to M16

Date: 2026-09-20
Status: accepted in M04

The browser repository implements the full persistence surface needed by M04 but returns typed `unsupported` results for backup import/export. A partial exporter with an empty checksum or an importer that mutates before validation would violate the M16 staging, checksum, fresh-ID remapping, and no-silent-merge rules.

Migration impact: M16 must replace these two explicit stubs with validated staged operations over the same logical collections. Until then, no browser history is copied through an unversioned or unchecked backup path.

## D-015 — Define desktop acknowledgement at journal fsync

Date: 2026-09-20
Status: accepted in M05

The desktop repository prepares and validates a complete next state, encodes one framed SHA-256 transaction, appends it to the journal, and calls file `sync()` before changing the visible in-memory state or returning success. A finalized-session mutation contains the session and all supplied series, slice, mistake, exposure, lesson, aggregate, character-stat, and checkpoint effects. Session UUID is checked before append, so a retry cannot double effects.

Migration impact: future desktop mutations must remain replay-idempotent and must not acknowledge before their journal frame crosses this boundary. Splitting a finalized save across frames would require a new atomic transaction envelope and migration.

## D-016 — Fence snapshot replay with a monotonic journal sequence

Date: 2026-09-20
Status: accepted in M05

Snapshots record the highest applied journal sequence. Compaction fsyncs and verifies a temporary snapshot, retains the previous generation, atomically replaces the current snapshot, and only then rotates the journal. On restart, records at or below the snapshot sequence are skipped and subsequent records must be contiguous. This makes a crash before journal rotation safe without silently dropping damaged middle records.

Migration impact: snapshot and journal migrations must preserve `lastSequence` monotonicity. A newer schema/format fails with `version-too-new`; checksum, frame, or sequence damage enters typed corruption recovery rather than attempting partial omission.

## D-017 — Use one validated Electron invoke transport

Date: 2026-09-20
Status: accepted in M05

Preload exposes the existing typed `FfBridge`, but all repository calls travel through one internal `flashfinger:invoke` transport. Main dispatches only the closed `repo.*` list after checking protocol, request ID, argument shape, an 8 MiB serialized payload cap, expected webContents ID, top-level frame identity, and `flashfinger://app` origin. Repository storage paths are fixed confined basenames under `app.getPath('userData')/repository`; IPC never accepts a filesystem path.

Migration impact: adding an IPC operation requires updating the shared whitelist, preload whitelist, renderer adapter, and main dispatcher together. File import/export in M16 must use separate narrow handlers and must not expose path or filesystem primitives.
