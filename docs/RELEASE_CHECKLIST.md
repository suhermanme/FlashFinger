# FlashFinger release checklist

Status: **release candidate audit complete; cross-platform qualification remains open**.

## Verified on this host

- [x] Single renderer build, typecheck, Electron compilation, and 22 test files / 238 tests.
- [x] Contract, grapheme, scoring, lesson, practice, custom-text, analytics, and backup validation coverage.
- [x] Browser IndexedDB and desktop journal/repository tests, including duplicate commits and crash-cut-point coverage.
- [x] Offline shell assets, relative PWA manifest, dictionary/license assets, sound-pack manifest, and release asset audit.
- [x] Synthetic bounded analytics-window performance check.

## Qualification still required

- [ ] Clean browser profiles with disconnect/restart across all modes and profile actions.
- [ ] Clean Electron installs on Windows, macOS, and Linux; unsigned artifacts must be reported.
- [ ] Native Firefox/Safari, physical keyboard-to-paint, and physical audio onset measurements.
- [ ] One-hour memory/endurance run and real quota/disk-full/power-loss tests.
- [ ] Screen-reader/composition testing and hardware matrix execution.

No unavailable platform or physical-latency gate is marked passed by this repository.
