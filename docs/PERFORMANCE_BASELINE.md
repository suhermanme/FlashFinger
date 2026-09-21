# M08–M10 Performance Baseline

Recorded: `2026-09-21T08:09:03Z` (UTC)

This is an engineering baseline, not a universal latency claim. It separates application/API scheduling from physical visible or audible onset as required by the design specification.

## Environment

- Ubuntu 26.04.1 LTS, Linux 7.2.6, x86-64
- Intel Core i7-9750H, 6 cores / 12 threads
- Node 22.22.1
- Headless Google Chrome 153.0.8010.47
- Electron 44.4.3 / Chromium 152.0.7977.130
- No display, keyboard actuator, audio loopback device, speaker, microphone, or photodiode was attached to the headless runs.

## Native audio scheduling spike

The repeatable harness is `tests/performance/{index.html,runtime-harness.ts,read-cdp.mjs,electron-harness.cjs}`. It loads and verifies the local generated test pack, creates one interactive-latency `AudioContext`, pre-creates decoded immutable buffers, then synchronously triggers 10,000 one-shot letter sounds through the bounded 24-voice pool. It measures JavaScript handler entry through `AudioBufferSourceNode.start()` return. Fetching, hash verification, and decoding happen before the measured loop.

| Runtime | Inputs | p50 | p95 | p99 | Max | Reported base/output latency |
|---|---:|---:|---:|---:|---:|---:|
| Chrome 153 headless | 10,000 | 0.10 ms | 0.10 ms | 0.20 ms | 2.20 ms | 10.67 / 40.00 ms |
| Electron 44 headless | 10,000 | 0.10 ms | 0.10 ms | 0.20 ms | 4.50 ms | 10.67 / 43.00 ms |

The measured scheduling path stayed below the provisional 4 ms p99 application budget, and neither run observed a sample at or above 10 ms. The reported `baseLatency`/`outputLatency` values are browser estimates and do not prove physical speaker onset.

## Combined synthetic input/renderer baseline

`tests/performance/input-feedback.test.ts` sends 10,000 committed inputs through `InputAdapter`, `TypingEngine`, the bounded imperative `TextRenderer`, and optional completion-effect inspection. It runs in Vitest/jsdom and is a regression control, not a qualification browser trace.

| Path | Total | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|
| Essential input/engine/DOM | 3,825.49 ms | 0.225 ms | 0.367 ms | 8.171 ms | 26.659 ms |
| With bounded feedback inspection | 3,633.51 ms | 0.220 ms | 0.313 ms | 8.175 ms | 15.184 ms |

The feedback run did not materially regress the jsdom control and remained within its generous runaway-work guards. The jsdom p99 is above the proposed 4 ms qualification budget; it is retained honestly and must not be substituted for a real browser input-to-paint trace.

## Qualification status

- Application-to-Web-Audio scheduling feasibility: supported by the two native headless measurements above.
- Physical key actuation to visible feedback: **not measured**; unavailable hardware instrumentation.
- Physical key actuation to audible onset: **not measured**; unavailable audio loopback/instrumentation.
- Browser input-to-paint trace, 60-second long-task run, constrained-CPU run, one-hour memory plateau, and 5/15/30 events-per-second hardware scenarios: **not yet qualified**.
- Firefox, Safari, Windows, and macOS measurements: **not available in this environment**.

Release qualification still requires the complete §1.6 platform/hardware matrix. These numbers demonstrate feasibility on the named headless Linux runtimes only and make no universal “under 10 ms” claim.
