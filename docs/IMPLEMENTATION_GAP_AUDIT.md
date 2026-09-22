# Implementation Gap Audit

Date: 2026-09-22  
Audited revision: `ac164eb` (`feat: improve analytics and session history`)  
Reference: `docs/DESIGN_SPECIFICATION.md` version 1.0

## Conclusion

The milestone modules and their focused tests are largely present, but the release-one design is not fully implemented in the user-facing application. The principal problem is integration: `src/app/App.tsx` routes all training modes through the simplified `PracticeSession` component rather than the shared `SessionCoordinator`, `SessionScreen`, and `TypingSurface` stack delivered by M08–M11. Several other milestones provide contracts, helpers, or validation without completing their production UI and platform wiring.

Accordingly, the earlier statement that all implementation work is complete and only external qualification remains is inaccurate. The repository has both implementation gaps and qualification gaps.

## Confirmed implementation gaps

### 1. Shared typing and session lifecycle is not used by the application

`App.tsx` renders `PracticeSession` for practice, lessons, and custom text. The production route does not instantiate `SessionCoordinator` or render `SessionScreen`/`TypingSurface`.

This leaves the active training experience without the designed pause/resume and visibility behavior, periodic checkpoints, interrupted-session recovery, active-session ownership, durable save retry/discard flow, and profile-switch protection. `PracticeSession` also renders the complete target with React spans and handles input through `textarea.onChange`, bypassing the bounded imperative viewport and normalized native-input adapter.

Correction policy is not honored consistently: incorrect input always blocks advancement in `PracticeSession`, while the design specifies advance-by-default for practice and custom text and strict correction for lessons.

### 2. Endless practice and configuration are incomplete

The bounded endless generator exists, but `PracticeSession` materializes only the initial prepared text and never consumes or refills `PreparedPractice.controller`. Reaching that initial target completes the run, and there is no explicit Finish action.

The visible setup offers only 60 seconds, 50 words, or endless. The required 15/30/60/120-second and 25/50/100-word presets are not exposed.

### 3. Lesson-specific result flow is disconnected

The curriculum, progress evaluation, and `LessonResult` component exist. Because lessons use `PracticeSession`, users receive the generic result screen instead of exact unmet criteria, high-error keys, and retry/next-unlocked-lesson actions.

### 4. Backup import/export is not implemented end to end

Both `IndexedDbRepository.exportBackup/importBackup` and `DesktopRepository.exportBackup/importBackup` return `unsupported`. `BackupSettings` validates selected JSON but does not import it, and its Export button does not create or save a backup. Staged import, fresh-ID remapping, optional document selection, and desktop-native backup file handling remain absent.

### 5. Custom-text mode is only partially exposed

`CustomTextSetup` implements paste, normalization options, and a preview, but it is not routed from `App.tsx`; the active UI only offers direct `.txt` selection. Opt-in `CustomDocument` retention, saved-document browsing/replay, missing-source replay messaging, cancellation, and native Electron file selection are not connected.

### 6. Historical analytics are below the specified behavior

The current dashboards omit or diverge from several §4 requirements:

- Speed trends do not exclude all ineligible, short, compatibility, interrupted, or voluntarily paused sessions by default.
- No independent mode filters, weekly grouping, included-sample count, optional best marker, or parallel accessible table are exposed.
- The activity calendar covers 28 days rather than 53 weeks and does not expose the specified attempts/words detail, current streak, or longest streak.
- Calendar intensity thresholds differ from the fixed design thresholds.
- Accuracy Focus ranks raw mistake counts rather than error rate per exposure, has no under-20-exposure “insufficient practice” treatment, and has no expected-to-attempted confusion table.
- The live graph component is not connected to an active session. Its implementation does not yet provide the specified 480-point display buffer, cached grid, rolling label, theme/resize behavior, tooltip, or current/min/max accessible summary.

### 7. Profile settings are not wired to persistence

The visible Settings screen stores theme, font size, sound, keyboard visibility, and pace options in local React state. It does not read or save the active profile's settings store. System theme, motion preference, keyboard layout, and application after a profile-switch barrier are not exposed through the active screen. The repository-aware `AppearanceSettings` and `ThemeController` exist but are not integrated into `App.tsx`.

### 8. Offline installation is incomplete

The service worker installation precaches only `./` and `./index.html`; it does not install a complete hashed manifest of renderer chunks, workers, dictionaries, lessons, sounds, fonts, and icons. There is no offline-ready/incomplete/retry UI, cache-completeness confirmation, robust versioned update lifecycle, or active-session update deferral wiring. The web manifest has no icons, and the app does not surface persistence/quota status. Service-worker registration is based on production mode rather than the platform adapter's service-worker capability.

### 9. Production audio and local assets are incomplete

The active application uses `KeyboardSoundPlayer`, an oscillator-based synthesizer, rather than the prepared sound-bank/context stack. The checked-in sound manifest contains only a generated test pack, not the complete production pack set described in §3.4. Audio readiness/failure/retry state is not shown. No bundled font or application icon assets are present.

### 10. Desktop file integration and packaging are incomplete

Desktop `fileAccess.openTextFile`, `fileAccess.saveTextFile`, and window controls are placeholders. Their IPC channel names are whitelisted, but the main process does not implement native dialog/window handlers. The project also has no Electron packager configuration or installer-generation script, and no generated Windows, macOS, or Linux release artifacts.

### 11. Acceptance coverage is not end to end

`tests/e2e/acceptance/release-assets.test.ts` is a Vitest file-existence/content check rather than a browser or packaged-desktop interaction suite. It does not demonstrate offline reloads for every mode, profile workflows, backup round trips, update deferral, or fresh desktop launch.

## Qualification gaps

The following remain external or environment-dependent qualification work after the implementation gaps above are closed:

- Clean browser disconnect/restart tests across all modes and profile operations.
- Clean Electron installation and crash testing on Windows, macOS, and Linux filesystems.
- Native Firefox and Safari coverage.
- Physical keyboard-to-paint and keyboard-to-audio onset measurement.
- One-hour endless-session memory/endurance testing and constrained-CPU runs.
- Real quota exhaustion, disk-full, power-loss, and browser eviction/private-mode behavior.
- Screen-reader, IME/composition, forced-colors, zoom, and hardware-matrix testing.

These qualification items must remain reported as open and must not be treated as substitutes for the implementation gaps.

## Recommended implementation order

1. Route all modes through `SessionCoordinator` + `SessionScreen` + `TypingSurface`, including recovery and save barriers.
2. Connect endless refill, explicit Finish, full practice presets, and lesson-specific results.
3. Complete repository backup import/export and desktop file-dialog bridges.
4. Route the full custom-text setup and opt-in document retention.
5. Bring analytics, live graph, settings persistence, and theme/motion wiring to specification.
6. Implement complete PWA precaching/status/update behavior and production assets.
7. Add desktop packaging and true browser/Electron acceptance tests, then execute the external qualification matrix.

## Recently completed follow-up work

The following post-audit-request UI changes are present and are not open gaps: history-day session expansion, Settings placement below the Review navigation group, improved mistake-report spacing, same-day analytics refresh after a saved session, and the Accuracy Focus statistics reset action.
