# FlashFinger

An offline-first, cross-platform typing trainer planned for TypeScript, React, Vite, Electron, Zustand, and Tailwind CSS.

M01, the shared contract and fixture foundation, is complete. The renderer, Electron shell, persistence, and typing engine have not been implemented yet; M02 is the next eligible task.

Read the [Design Specification](docs/DESIGN_SPECIFICATION.md) for architecture, data contracts, training behavior, performance qualification, and 17 standalone implementation micro-prompts. Current progress and handoff details are in [Implementation Status](docs/IMPLEMENTATION_STATUS.md) and [Work State](docs/WORK_STATE.md).

The requested sub-10 ms audiovisual latency is a qualification target. The specification distinguishes application processing time from physical display/audio latency and requires measured evidence for supported environments.
