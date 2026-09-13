# iPhone bridge

The app communicates with `ios_bridge.py` over a private JSONL child-process pipe.
The runtime pins pymobiledevice3 11.12.4 (GPL-3.0-or-later). The Python API was
checked against that published wheel, including its DVT acknowledgement and
connection-disconnected event implementations.

## Build

Use Python 3.12 on a native Windows x64, macOS Intel, or macOS Apple Silicon host:

```sh
# Optional when python3 / python is not the intended interpreter:
GHOST_BUILD_PYTHON=/path/to/python3.12 node scripts/build-ios-sidecar.mjs
```

PowerShell: set `$env:GHOST_BUILD_PYTHON = 'C:\path\python.exe'` before running
`node scripts/build-ios-sidecar.mjs`. The script creates `sidecar/.venv`, installs
the pinned runtime/build requirements, and builds a standalone PyInstaller folder
under `resources/ios/<platform>-<arch>/ghost-ios/`. It performs an import/protocol
smoke check without discovering or changing a phone. Subsequent offline rebuilds
can use `--skip-install`. Each build records its resolved dependency versions.
Build on every target OS/architecture; PyInstaller does not cross-compile here.

For development the adapter can run the same bridge in `sidecar/.venv`. Packaged
builds prefer the self-contained sidecar and do not require user-installed Python.
The build is ad-hoc signed on macOS; public release signing/notarization belongs
to the Electron packaging workflow.

## Device requirements

- iOS 17.4 or later, USB data cable, phone unlocked and trusted, Developer Mode on.
- macOS uses its Apple USB service. Windows needs Apple USB services; upstream
  documents installing iTunes from the Microsoft Store.
- First preparation may download/cache the personalized developer image and
  request a device-specific ticket from Apple. It does not install a phone app,
  change the phone passcode, enable Wi-Fi, or enable Developer Mode silently.
- No Wi-Fi discovery or fallback is allowed. Every lockdown connection sets
  `connection_type="USB"` and the exact selected UDID. Services inherit that
  connection type. The pinned userspace tunnel's provider factory is narrowed to
  the same behavior because its upstream default omits the connection type.
  Review this small private-API override when upgrading pymobiledevice3.

## Protocol and lifetime

Request: `{"id":1,"method":"set","params":{"udid":"…","latitude":1,"longitude":2}}`.
Response: `{"id":1,"ok":true,"result":{"applied":true,"latitude":1,"longitude":2}}`.
Failures return `ok:false,error`. Methods are status/discover/prepare/set/clear/reset/shutdown.
No method defaults to the first device. Location mutations are serialized and one
tunnel remains alive for the selected phone. Discovery uses independent USB
connections and does not hold the lock used by the location-update loop. A DVT disconnect emits
`{"event":"session-ended","deviceId":"ios:…","error":"…"}`.

Set completes only after the device returns from the DVT set selector. This
confirms the developer operation, not how a third-party app interprets location.
For v0.1.1, the bridge reasserts the fixed coordinates on a one-second loop and
awaits every DVT acknowledgement, with a bounded timeout. Each accepted reply
emits a `location-refreshed` event containing the exact device, session ID,
target generation, coordinates, acknowledgement time, and update count. This is
a command-acknowledgement timestamp, not a measured GPS-fix timestamp; the DVT
selector accepts only latitude and longitude. A new target replaces the old
target under the same lock as the refresh loop.

The desktop adapter uses fresh acknowledgements as evidence that the selected
USB phone is still connected, avoiding redundant discovery probes during a
healthy session. The controller also tolerates a transient discovery miss while
recent iOS acknowledgements continue. Stale or failed acknowledgements still
lead to recovery; an acknowledgement does not verify a phone app's GPS reading.

Clear uses Apple's no-reply stop selector, so it confirms the restore command was
sent, without claiming independent GPS readback. Normal shutdown/EOF attempts
clear before closing by default. `shutdown` with `params.restore:false` closes
the transport without sending clear; this does not guarantee the OS will retain
the simulated location. The adapter exposes this as `dispose({restore:false})`.
An interrupted live session can be automatically reconnected by the desktop
controller while the same Ghost process stays open. Recovery is limited to the
same device and last applied target; a newly selected preview pin is not applied
automatically. Restore cancels automatic recovery, even when USB is absent, and
waits for an in-progress recovery operation before clearing the simulation.
After Ghost restarts, the recovery journal requires an explicit Retry location
or Restore. Neither disconnect nor process exit guarantees that real location
has resumed.

Tests use replaced transports and never operate a phone:
`node --test tests/ios*.test.mjs`. The longer end-to-end refresh harness is
`npm run test:ios-stream` and writes its report under `artifacts/`.

Hardware validation is still required for each supported iOS release, OS/CPU
target, phone lock/sleep, unplug/replug, crash/normal quit, and intended phone app.
