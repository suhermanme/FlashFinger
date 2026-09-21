# FlashFinger performance report

The checked-in evidence covers renderer-side scheduling and bounded synthetic workloads only. Existing audio harnesses recorded p99 scheduling below 0.20 ms in headless Chrome and below 0.20 ms in Electron for 10,000 decoded triggers; the input-feedback Vitest baseline remains synthetic.

The release qualification test caps rolling analytics state at 240 points under a 30,000-event burst. These measurements do not establish physical keyboard-to-paint or audible/visible onset latency. Windows/macOS, non-Chromium browsers, constrained CPU, one-hour endurance, and physical output remain unqualified and are release blockers for a strict end-to-end SLA claim.
