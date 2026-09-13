# Location app — working design brief

Status: v0.1.5 adds road route playback to the first-run setup, interface, recovery, and Android cleanup features. Physical route playback and the remaining USB host/phone combinations remain unverified.
Updated for v0.1.5. See `validation.md` for version-specific evidence.

## Confirmed requirements

- Public, free, open-source application.
- Electron desktop application for Windows and macOS.
- Four connections: Windows → iPhone, Windows → Android, macOS → iPhone, macOS → Android.
- USB cable connections only in the first version.
- One selected phone session at a time: fixed location or a driving route.
- Plan a route through ordered stops; move at 45 mph and send coordinates every second.
- Choose a location by searching for a place or dropping a pin on a map.
- Reuse minimal existing open-source components.
- Gather product requirements and edge cases with the user before implementation.

## Implemented architecture

One shared Electron interface handles the map, search, device selection, setup guidance, and session status. A first-run survey stores the selected host and phone platforms and shows the matching checklist for Mac → iPhone, Windows → iPhone, Mac → Android, or Windows → Android. Two phone adapters handle device discovery, preparation, setting coordinates, stopping simulation, and recovery.

- iPhone: a bundled, persistent `pymobiledevice3` process with a structured stdio interface to Electron. End users do not install Python. Initial target is iOS 17.4+ with USB-only device selection and developer-service tunnels.
- The iPhone sidecar reasserts the selected coordinates on a one-second loop, awaiting each DVT acknowledgement. Fresh acknowledgements keep discovery polling from treating a healthy active connection as disconnected.
- Android: bundled ADB plus unmodified Appium Settings. The app installs and configures the helper only through the explicit Prepare action, then verifies requested coordinates through the helper's location receiver.
- The Android helper emits timestamped mock fixes every two seconds. Desktop readback confirms helper coordinates; its receiver does not expose the fix timestamp.
- Use underlying device components directly; full desktop management interfaces are unnecessary dependencies for this app.
- Road routing: request full driving geometry from OSRM on explicit Plan; interpolate distance along each road segment in the desktop backend at 45 mph. Route commands run every second, with Pause, Resume, and destination hold. Disconnect, sleep, or delayed updates pause progress until explicit Resume.
- Keep remote map/search content isolated from the privileged device-control process.

## Implementation defaults

- One selected USB phone and one unresolved session at a time. If an `unknown`,
  `waiting`, or `error` record belongs to a different phone and another usable USB
  phone appears, discard the old record automatically so the new phone can be used.
  Keep `active`, `applying`, `reconnecting`, and `stopping` sessions protected.
- Selecting a pin changes the preview; an explicit Set location action changes the phone.
- USB replug can automatically resume the same phone and applied target while the same Ghost process remains open. Same-phone manual retry is available after a connection failure; restarting Ghost requires manual Retry or Restore.
- Restore cancels automatic reconnection, including when the phone is absent, and waits for any in-progress recovery before sending clear. A disconnected phone must reconnect for clearing to succeed.
- Normal quit attempts restoration by default. The preference is configurable. Disconnect, crash, sleep, or unconfirmed cleanup leaves an unresolved session for recovery.
- Replacing an unresolved record does not send Restore to the old phone. Its simulated location may persist until the old phone is restarted or restored separately.
- Place search runs on explicit submission against a configurable Photon endpoint. No API key or autocomplete is required.
- Saved places, recent selections, preferences, and the recovery journal are local.
- Android 8.0+, iOS 17.4+, Windows x64, and macOS Intel/Apple Silicon are implementation targets. A supported target is not a hardware test result.

These defaults were chosen after the user instructed us to build. They are engineering decisions, not additional recorded user answers.

## Release validation still needed

- Test actual Windows/Mac computers and iPhone/Android models in the hardware test matrix.
- Verify the phone applications that define success; application-specific mock-location rejection is outside the USB transport guarantee.
- Configure signing/notarization for public installers and choose a hosted search service if use exceeds the public demo's moderate-use limit.
- Publish matching source and dependency notices alongside public binaries.

## Known constraints to validate

- The Android helper can continue supplying mock coordinates after USB disconnect. A connection heartbeat and phone-side expiry would be needed for a policy that stops simulation after connection loss.
- Once an iPhone disconnects, the desktop cannot issue a clear command. Persist an unresolved session and show that the phone's location state cannot be verified until reconnecting; do not promise restoration merely because USB was unplugged.
- iOS acknowledgement timestamps describe completed developer commands, not phone GPS measurements. Android helper readback does not establish a fresh fix or prove what a third-party app displays.
- First-time iPhone preparation may require an internet download of developer support files.
- Current public Nominatim policy disallows client-side autocomplete; public map/search services also have usage limits and attribution requirements.
- Hardware tests must cover all four connections, phone lock, laptop sleep, cable loss, application crash, normal stop, and reconnection.

## Primary references

- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3)
- [Modern iOS USB tunnels](https://doronz88.github.io/pymobiledevice3/guides/ios17-tunnels/)
- [iOS preparation and location commands](https://doronz88.github.io/pymobiledevice3/guides/cli-recipes/)
- [Appium Settings location commands](https://github.com/appium/io.appium.settings#setting-mock-locations)
- [Appium Android location service](https://github.com/appium/io.appium.settings/blob/master/app/src/main/java/io/appium/settings/LocationService.java)
- [ADB device setup](https://developer.android.com/studio/run/device)
- [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
- [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
