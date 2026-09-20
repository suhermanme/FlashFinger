# Implementation Status

Last updated: `2026-09-20T10:15:51Z` (UTC)

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

## Known limitations and next eligible prompt

M02 scaffolding exists but is incomplete: `src/main.tsx` and `electron/` are absent, `tsconfig.electron.json` uses TypeScript 7-incompatible `moduleResolution: Node`, `npm run typecheck` therefore fails in the Electron project, and `npm run build` cannot resolve the renderer entry. These are M02 work and were not counted against M01.

Next eligible prompt: **M02 — Shared Vite and secure Electron shell**.
