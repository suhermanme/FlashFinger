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
