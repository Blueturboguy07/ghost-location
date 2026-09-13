# Local validation

## Public 0.1.5 native builds

[GitHub Actions run 34771723845](https://github.com/Blueturboguy07/ghost-location/actions/runs/34771723845) passed on all three native targets at source commit `cb0ccc0ecb4c6168dfa996458b0a3b62e2081d4f`:

- Windows x64: bundled runtime preparation, adapter/sidecar tests, and EXE installer.
- macOS Apple Silicon: bundled runtime preparation, adapter/sidecar tests, DMG and ZIP.
- macOS Intel: bundled runtime preparation, adapter/sidecar tests, DMG and ZIP.

The Intel build links cryptography's OpenSSL statically to avoid a shared-library collision with sslpsk in the frozen runtime. The Windows x86-ADB unit check uses a PE fixture on Mac and the real Windows binary on Windows. A separate local run passed all 113 tests.

These checks establish native packaging and software behavior, not all four physical USB pairings. Mac → iPhone use has been reported and observed locally; the remaining phone combinations still need physical validation. The public setup guide keeps that distinction explicit.

The Publik screenshot uses the actual renderer with an isolated example phone and a public Chicago OSRM route. It does not contain a user's phone identity or make device commands.


## v0.1.5 route playback — 2026-09-13

| Check | Result |
| --- | --- |
| `node --test --test-concurrency=1 tests/*.test.mjs` | 113 passed, 0 failed, 0 skipped. Includes both adapter paths, 45 mph arc-distance interpolation around bends, one-second backend scheduling, pause/resume, arrival, disconnect/sleep, slow writes, in-flight Restore, and rejection of old or different-phone sessions. |
| Android moving targets | Fake ADB transport confirms one service-target command per update without setup/readback retry loops; recent tracker lag is tolerated, unrelated coordinates are rejected. Appium 8.0.9 source confirms each new intent schedules an immediate mock fix. No APK modification. |
| Renderer regression | Passed: ten heartbeats over 9.27 seconds preserve fixed-location controls and drafts. Route stops, planning without mutation, Start/Pause/Resume, backend-driven marker movement, and compact controls pass with a fake phone and all external requests blocked. |
| Live OSRM / native IPC | Passed with both source and packaged app. A Chicago driving route returned 115 geometry points and 2,652 metres. No route was started and no phone location commands were sent. |
| macOS arm64 app | Built as 0.1.5. Packaged smoke confirms both bundled runtimes, all four onboarding guides, saved-place CRUD, live search, route preview, settings, and compact layout. |
| Installer integrity | DMG verified with `hdiutil verify`; ZIP passed `unzip -tq`; SHA-256 values recorded in `release/SHA256SUMS-0.1.5.txt`. |

One concurrent test run and the first packaging attempt hit process-startup timeouts
while the host was under load. The full suite passed when run serially; renderer
and packaging retries passed unchanged. No timeouts or assertions were weakened.

Artifacts: `release/mac-arm64/Ghost.app`, `release/Ghost-0.1.5-mac-arm64.dmg`, and
`release/Ghost-0.1.5-mac-arm64.zip`. Screenshots include
`artifacts/ghost-route-preview.png`, `artifacts/ghost-route-playback.png`, and
`artifacts/ghost-route-compact.png`.

Physical route playback was not tested. The running user's iPhone session was
observed separately and was not a route test. These checks do not establish
Windows USB behavior or how a particular phone app consumes mock location fixes.

## v0.1.4 onboarding and interface checks

| Check | Result |
| --- | --- |
| `npm test` | 97 tests passed, 0 failed, 0 skipped. Includes onboarding preference validation for both host and phone platforms. |
| Renderer production build | Passed with package version 0.1.4. |
| `npm run test:renderer-session` | Passed with no device adapters and external requests blocked. Ten heartbeats over 9.15 seconds preserved the selected phone, pending target, enabled Update action, and focus; only explicit Update submitted the target. |
| `npm run test:native` | Passed with isolated settings and no phone commands. The test completed first-run onboarding, verified all four tailored setup guides, exercised coordinates, saved-place CRUD, live search, settings, and the 960×680 layout. |
| Visual review | First-run survey, setup checklist, map workspace, settings, destination, and compact-window screenshots were generated in `artifacts/`. Text remains legible over the map, and the interface uses neutral system styling with blue reserved for actions. |
| macOS arm64 package | The v0.1.4 app bundle, DMG, and ZIP were built. The packaged smoke test confirmed both runtimes and the complete UI flow with isolated settings and no phone commands. Bundled iPhone, ADB, and Android helper resources match the validated source resources. |
| Installer integrity | `hdiutil verify` accepted the DMG, `unzip -tq` found no ZIP errors, and SHA-256 values were written to `release/SHA256SUMS-0.1.4.txt`. |

These checks verify the setup logic and interface. They do not replace the physical
USB tests listed in `hardware-test-matrix.md`.

The v0.1.4 macOS arm64 artifacts are `release/Ghost-0.1.4-mac-arm64.dmg`
and `release/Ghost-0.1.4-mac-arm64.zip`.

## v0.1.3 simulator and regression checks

| Check | Result |
| --- | --- |
| `npm test` | 96 tests passed, 0 failed, 0 skipped at the time of the v0.1.3 build. |
| Android 14 emulator helper integration | Passed on API 34 through the real Android adapter and bundled Appium Settings 8.0.9. Two targets were applied and read back, including an update; two health callbacks arrived; both services stopped; the temporary helper was uninstalled. A test-only seam bypassed the production emulator/USB filter, so this is not physical USB acceptance. |
| Android Restore regression | Confirmed Android's status-255 `Service stopped` response is accepted only after `dumpsys` reports the service absent. |
| iOS Simulator exclusion | A booted iOS 26.3 iPhone 17 Pro simulator was not returned by the real Ghost USB discovery sidecar, as designed. No location command was sent. |
| Windows ADB resource | The actual pinned Google `adb.exe` PE header is now tested and accepted as Windows x86-compatible on Windows x64. The iPhone sidecar remains strict x64. |
| Windows VM/nested simulator | Not run: this host has no Windows VM, ISO, or installer. Nested phone simulators cannot verify USB drivers, pairing/debug prompts, cable behavior, or physical-device location results. |
| iOS refresh stress | Passed with 14 acknowledged DVT calls and 12 refresh callbacks; discovery overlapped and clear stopped the loop. The USB/DVT peer is controlled test code. |
| Renderer production build | Passed with package version 0.1.3. |
| `npm run test:renderer-session` | Passed with no device adapters and external requests blocked. Ten heartbeats over 9.37 seconds preserved the selected phone, pending target, enabled Update action, and focus; only explicit Update submitted the target. |
| macOS arm64 package | DMG, ZIP, and app bundle built as 0.1.3. The packaged smoke test confirmed both runtimes, UI/IPC, six search results, saved-place CRUD, settings, and compact layout with isolated settings and no phone commands. |
| Installer integrity | SHA-256 checks passed; `hdiutil verify` accepted the DMG and `unzip -tq` found no ZIP errors. |

The v0.1.3 macOS arm64 artifacts are `release/Ghost-0.1.3-mac-arm64.dmg`
and `release/Ghost-0.1.3-mac-arm64.zip`.

## v0.1.2 software regression checks

| Check | Result |
| --- | --- |
| `npm test` | 94 tests passed, 0 failed, 0 skipped. Includes 16 Python bridge cases plus Android/controller and iOS adapter regression coverage. |
| iOS refresh stress | Passed through the real Node adapter, JSONL main loop, Python bridge, and pinned upstream location API with a fake USB/DVT peer. Ten acknowledgements kept the first target active beyond nine seconds; four acknowledged the replacement target; updates continued during a 6.25-second discovery probe; Restore stopped all later calls; no loss event occurred. |
| Renderer production build | Passed with package version 0.1.2. |
| Native resource validation | Passed for macOS arm64. The iPhone runtime's recorded bridge SHA-256 matches the current streaming source. |
| `npm run test:renderer-session` | Passed with an isolated test bridge, no device adapters, and 382 external requests blocked. Ten state heartbeats over 9.17 seconds preserved the selected phone, unapplied target, enabled Update action, and focused controls. Recovery transitions passed; only explicit Update submitted the pending target. |
| Recovery and target-update interface | Mocked waiting → reconnecting → active transitions, same-phone retry, iOS setup-required recovery, offline Restore, availability of Restore during pending recovery, and an explicit subsequent target update passed. A different ready USB phone now clears an old `unknown`, `waiting`, or `error` record, cancels retries, and resets the old transport without sending Restore; same-phone records and `active`, `applying`, `reconnecting`, or `stopping` sessions remain protected. |
| Confirmation wording | iOS command acknowledgements and Android helper readbacks are identified separately; neither is presented as an independently verified phone-app GPS reading. |
| macOS arm64 package | The v0.1.2 DMG, ZIP, and app bundle built successfully. A packaged-app smoke test used isolated settings, found no phones in that process, confirmed both bundled runtimes available, returned six live search results, and completed the native UI flow without Prepare, Set, or Restore. |
| Installer checksums | DMG and ZIP SHA-256 verification passed; values are in `release/SHA256SUMS.txt`. |

These software checks do not exercise a real USB transport. The historical
packaging and physical-discovery observations below remain scoped to the initial
0.1.0 build; they are not new physical Set/Update/Restore results for v0.1.2.

The v0.1.2 macOS arm64 artifact names are
`release/Ghost-0.1.2-mac-arm64.dmg` and `release/Ghost-0.1.2-mac-arm64.zip`.
The bundle path remains `release/mac-arm64/Ghost.app`; generated checksums are
written to `release/SHA256SUMS.txt`. Rebuilding these artifacts does not itself
establish phone compatibility.

## Initial v0.1.0 baseline — 2026-09-13

Ghost 0.1.0 was built on macOS Apple Silicon with Node 24.18.0, Electron 44.3.0,
pymobiledevice3 11.12.4, Appium Settings 8.0.9, and Android Platform Tools 37.0.1.

| Check | Result |
| --- | --- |
| `npm test` | 51 tests passed, 0 failed, 0 skipped. Includes Python bridge checks. |
| Renderer production build | Passed. |
| Native resource validation | Both runtimes launch; architecture, APK/ADB integrity, and required notices pass. |
| `npm run test:native` | Passed in isolated settings. |
| Packaged `Ghost.app` native smoke | Passed in isolated settings; bundled iPhone and Android runtimes report available. |
| Live Photon search | Six selectable results returned for Millennium Park Chicago. |
| Native interface | Coordinates, saved-place create/rename/delete, setup tabs, preferences, and 960×680 window exercised; no renderer errors. |
| USB discovery | One physical iPhone running iOS 26.6.1 discovered through the iOS USB adapter. |
| macOS arm64 installers | DMG and ZIP produced successfully; local unsigned build. |
| Windows x64 / macOS Intel | Native CI workflow defined; builds have not been run here. |
| Physical Set / Update / Restore | Not exercised on any phone. No phone location commands were sent during these checks. |

Screenshots from the initial packaged-app check were written to `artifacts/`.
That check used the v0.1.0 installer; later builds may replace the bundle,
screenshots, and checksum file at the shared output paths.

The transport tests use controlled doubles. They check correct USB targeting,
acknowledgement/error handling, cleanup, permission behavior, process termination,
and persistent recovery. They do not establish that a particular phone app accepts
simulated coordinates. Complete `hardware-test-matrix.md` before a public claim of
verified support across all four host/phone combinations.
