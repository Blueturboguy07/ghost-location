# Hardware acceptance matrix

The implementations cover the four requested combinations. No physical phone
test is claimed until an operator records the actual devices and results below.

| Host | Phone | Transport | Acceptance status |
| --- | --- | --- | --- |
| Windows x64 | iPhone, iOS 17.4+ | USB | Not device-tested |
| Windows x64 | Android 8.0+ | USB | Not device-tested |
| macOS Apple Silicon / Intel | iPhone, iOS 17.4+ | USB | Apple Silicon Set and sustained command acknowledgements were user-observed with iOS 26.6; Restore is not recorded. Intel untested. |
| macOS Apple Silicon / Intel | Android 8.0+ | USB | Android 14 emulator helper flow passed; physical USB remains untested. |

For each cell, record host/phone versions, chipset, cable, helper/runtime versions,
target phone application, test date and operator.

1. Clean install: appropriate installer includes both runtime families.
2. No phone: map/search/saved places work; apply cannot run.
3. Plug in: only USB devices are listed; Wi-Fi/ADB TCP devices are excluded.
4. Locked or untrusted phone: actionable setup status, no false success.
5. Preparation: driver/trust/developer/helper prompts are understandable.
6. Set a known point and verify it in the chosen phone app.
7. Keep a fixed point active for at least 15 seconds, then change it and verify the second point in the phone app. Check that desktop acknowledgement/readback updates do not falsely claim an app-level GPS result.
8. Stop and confirm the phone resumes real location; note cache delays.
9. Unplug while active: state becomes waiting/unverified, not restored. Pressing Restore while unplugged cancels automatic reconnection.
10. Replug during the same Ghost process: with automatic recovery enabled, the exact same phone resumes the last applied target. An uncommitted preview pin must not replace it. Restore still works on that exact phone and prevents later automatic reapplication.
11. Normal quit while connected: restoration attempted before exit.
12. Force-quit and relaunch: recovery remains visible and requires manual Retry or Restore. A sidecar failure during the same running Ghost process may recover automatically; verify device and target identity.
13. Laptop sleep/wake and phone lock/unlock do not produce false state claims.
14. Two phones connected: only the explicitly selected serial changes.
15. Failed or slow search: coordinates/pins remain usable; no infinite spinner.
16. Offline first-time iOS image download: preparation error is actionable.
17. Repeated start/stop: no orphan helper processes, automatic resume after Restore, or automatic resume after restarting Ghost.
18. Healthy iPhone session across repeated discovery polls: fresh DVT acknowledgements keep the selected connection ready and Update usable; confirm an actual disconnect is still detected.
19. Restore during automatic reconnection: the retry is canceled, pending recovery finishes before clear, and a late acknowledgement does not reactivate the session.
20. Connect a different ready USB phone while the saved session is `unknown`,
    `waiting`, or `error`: Ghost discards the old recovery record, cancels its retry,
    and allows Prepare/Set on the new phone without sending Restore to the old phone.
    Confirm the old phone is described as potentially retaining its simulated location.
21. Repeat the replacement check while the old session is `active`, `applying`,
    `reconnecting`, or `stopping`: Ghost keeps that session and does not silently
    switch phones. Reconnect the same phone and confirm its unresolved record is kept.

Do not use a successful desktop command alone as the pass criterion for a target
application. Android mock-location detection and iOS app behavior are application-specific.

## Simulator results — 2026-09-13

- **Android emulator on macOS:** passed the real adapter/helper flow through a
  test-only bypass of Ghost's production USB filter: install and prepare Appium
  Settings, set and read back San Francisco, update and read back New York, then
  stop both services. The temporary helper was uninstalled afterward.
- **iOS Simulator on macOS:** an iOS 26.3 iPhone 17 Pro simulator was booted while
  Ghost USB discovery returned no devices. This is expected because the simulator
  does not expose the usbmux/DVT connection used for physical iPhones.
- **Windows:** no Windows VM or installer is available on this host. Nesting a
  phone simulator would not exercise Windows USB drivers or Ghost's USB-only
  transport, so the two Windows rows still require a native Windows x64 host and
  physical phones.
