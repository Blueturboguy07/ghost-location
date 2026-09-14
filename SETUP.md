# Ghost setup guide

Ghost runs on your computer and sends simulated locations to a phone over a USB data cable or the same Wi-Fi network. It is free and open source. No Ghost account, API key, subscription, jailbreak, or root is needed.

## Download and open

Download **Ghost 0.1.6** from [GitHub Releases](https://github.com/Blueturboguy07/ghost-location/releases/tag/v0.1.6) or use the [Publik installation guide](https://publikhq.com/ghost/install).

| Your computer | Download |
| --- | --- |
| Mac with an Apple chip (M1 or newer) | `Ghost-0.1.6-mac-arm64.dmg` |
| Mac with an Intel processor | `Ghost-0.1.6-mac-x64.dmg` |
| Windows PC with an Intel/AMD 64-bit processor | `Ghost-0.1.6-win-x64.exe` |

On Mac, **Apple menu → About This Mac** identifies the chip. On Windows, look at **Settings → System → About → System type**. Windows ARM and Linux are not release targets. Native builds are checked on macOS 15 and Windows Server 2025; other OS versions have not been rehearsed.

**Mac:** open the DMG, drag **Ghost** into **Applications**, then open it from Applications. The app is unsigned and not notarized. If macOS blocks the launch, check **System Settings → Privacy & Security → Open Anyway**. If it instead reports the app as damaged, first compare the download with `SHA256SUMS.txt` on the release page and download it again if the checksum differs. For a matching download that you choose to trust, the scoped command below removes its quarantine flag; it does not sign the app or verify its safety:

```sh
xattr -dr com.apple.quarantine /Applications/Ghost.app
```

**Windows:** run the EXE and follow the installer. The release is unsigned. If SmartScreen shows **Windows protected your PC**, inspect the file and publisher warning; use **More info → Run anyway** only if you choose to trust this download. A managed computer may block unsigned apps.

The installer includes ADB, the iPhone runtime, and the Android location helper. You do not need Node.js, Python, Xcode, Android Studio, or Appium Server to use it.

## Choose your configuration

On first launch, choose your computer and phone, complete the matching checklist, and select **Continue to map**. **Setup** in the toolbar opens the checklist again. The checklist is guidance; the connected phone must also appear as **Ready** before starting a location session.

Use one unlocked phone and a USB cable that carries data. Keep the computer online for the first preparation. Charging alone does not confirm a data connection.

### Mac → iPhone

1. Connect and unlock the iPhone. In Finder, select the iPhone and choose **Trust** if asked; confirm **Trust** on the phone.
2. On iPhone, open **Settings → Privacy & Security → Developer Mode**. Enable it, restart, and confirm after restarting. Enter the passcode on the phone itself. See [Apple's Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
3. In Ghost, select the iPhone. If it shows **Setup needed**, click **Prepare** and wait while the matching developer support image is downloaded and mounted.
4. Continue when the phone shows **Ready**. If Developer Mode is missing, connect and trust the phone first, attempt Prepare, then check the setting again. Follow Ghost's specific error if preparation still fails.

The iPhone adapter targets **iOS 17.4 and later**. New iOS versions can require upstream support updates.

### Windows → iPhone

1. Install or update **Apple Devices** from the Microsoft Store and open it once. Connect the iPhone and confirm that Apple Devices can see it. [Apple explains connecting and trusting a PC](https://support.apple.com/en-us/109054).
2. Unlock the iPhone and approve **Trust** on the computer and phone when asked.
3. Enable **Settings → Privacy & Security → Developer Mode**, restart, then confirm it on the phone.
4. In Ghost, select the iPhone and click **Prepare** if shown. Wait for **Ready**.

If Ghost reports **Apple USB services are unavailable**, repair Apple's device-support installation and reconnect. The upstream iPhone library recommends Microsoft Store iTunes for its Windows USB service prerequisite; see the [pymobiledevice3 Windows prerequisites](https://github.com/doronz88/pymobiledevice3#windows). Do not install USB drivers from random download sites.

### Mac → Android

1. On Android, open **Settings → About phone**, find **Build number**, and tap it seven times. Some phones place it under **Software information**. Enter your screen lock if asked.
2. Open **Developer options** and enable **USB debugging**. Menu locations vary by manufacturer.
3. Connect and unlock the phone. Approve **Allow USB debugging?** for your own computer. A separate Mac USB driver is normally unnecessary.
4. In Ghost, select the phone and click **Prepare**. This installs **Appium Settings**, grants its location permissions, and selects it as the mock-location provider.
5. If Android requires a manual choice, open **Developer options → Select mock location app → Appium Settings**. Keep Android Location switched on and allow the helper's requested location access. Return to Ghost and check for **Ready**.

The Android adapter targets **Android 8 and later**. See [Android's developer settings](https://developer.android.com/studio/debug/dev-options) for menu and permission details.

### Windows → Android

1. Enable **Developer options** and **USB debugging** as above.
2. Connect and unlock the phone; accept its USB debugging authorization prompt.
3. If Windows cannot find the phone, install your manufacturer's ADB USB driver using [Android's official OEM driver links](https://developer.android.com/studio/run/oem-usb). Reconnect, and try a direct USB port with a data cable.
4. Select the phone in Ghost and click **Prepare**. Approve the helper's permissions; if prompted, select **Appium Settings** under **Select mock location app**.
5. Wait for **Ready** before setting a location.

## Set one location

1. Choose **Fixed location**. Search for a place and select a result, click the map, or enter latitude/longitude and select the coordinates.
2. Check the selected phone and point. Selecting a pin changes the preview only.
3. Click **Set location**. For another point, select it and click **Update location**.
4. Open a map on the phone, enable its location permission, and use its current-location button. Confirm the phone shows the selected area.

Ghost displays command acknowledgements on iPhone and helper readbacks on Android. Those are connection feedback, not independent proof of the location consumed by another app. Some apps reject or cache simulated locations.

## Follow a road route

1. Select **Route**. Search or drop a pin for the start, then click **Add selected pin to route**.
2. Add a destination the same way. You can add up to 12 stops, in travel order.
3. Click **Plan road route**. Inspect the road line and distance before starting. Pins may snap to nearby roads; disconnected roads fail planning.
4. Click **Start route · 45 mph**. The phone moves to the first road point, then follows the route at **45 mph**. Ghost sends a new target every **one second**.
5. **Pause route** holds the current point; **Resume route · 45 mph** continues. Arrival holds the destination. Check motion in the phone's map as well as Ghost's blue dot.
6. Click **Restore real location** when finished. Allow the phone's map a moment to refresh before unplugging.

The speed is constant, regardless of road limits or traffic. The blue dot represents the last sent point. Keep Ghost running, the cable connected, and the computer awake. Minimizing Ghost does not stop playback. Unplugging, sleep, or slow updates pause movement; reconnect the same phone and press **Resume**. Restarting Ghost does not recover route geometry.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| No phone / Disconnected | Unlock it, reconnect a data cable directly, then click the refresh button. Check the Trust or USB debugging prompt. On Windows, check the appropriate Apple/OEM driver. |
| Setup needed | Click Prepare while online. Complete Developer Mode or the mock-location selection on the phone. |
| Location jumps back / acknowledgements stop | Keep the computer awake. Check USB, reconnect the same phone, and use Retry or Resume. Confirm the result in the phone's map. |
| New phone blocked by an active session | Restore the previous session first. Old unresolved records are cleared when another usable phone appears; clearing a record does not restore the absent phone. |
| No Route tab | Open the installed Ghost 0.1.6 desktop app. A stale running copy must be quit and reopened; normal quit attempts to restore its active phone first. A browser preview cannot control USB phones. |
| Search or route planning fails | Check internet access. Try coordinates or a map pin. Public Photon, OSRM, and map services can be unavailable. Route planning needs reachable driving roads. |
| Restore failed after unplugging | Reconnect the same phone and click Restore. Do not assume unplugging restored it. If iPhone simulation remains stuck, restart the iPhone. |
| Android keeps the simulated point | Reconnect and Restore. If needed, stop Appium Settings on the phone and set Select mock location app to None, then refresh the phone's map. |

## Privacy and tested scope

Ghost has no account or telemetry. Device identifiers, saved places, and a recovery record stay on the computer. Map viewing requests OpenStreetMap tiles, submitted searches go to Photon, and planning sends stop coordinates to OSRM. These public services have usage limits and no uptime guarantee. Route playback itself does not contact OSRM.

Mac → iPhone has been used successfully on a physical phone. Windows → iPhone, Windows → Android, and Mac → Android have software/adapter coverage; they have **not all been verified with physical USB phones**. Native installer builds are separate from end-to-end phone compatibility. See [validation](docs/validation.md) and the [hardware test matrix](docs/hardware-test-matrix.md).

For help, [open an issue](https://github.com/Blueturboguy07/ghost-location/issues) with the Ghost version, computer OS/processor, phone OS, and exact error. Remove phone identifiers and private locations from logs and screenshots.

## Connect over the same Wi-Fi network (0.1.6)

Open **Connection: USB · Change** below the Phone card. Choose **Wi-Fi** in this panel after the pairing steps below. Both fixed locations and routes use the existing location update loop. Restore real location before switching between USB and Wi-Fi.

### iPhone on Mac or Windows

1. Connect by USB once. Unlock and trust the computer; enable Developer Mode. Windows needs Apple's device-support installation as described above.
2. Select the iPhone in Ghost. Open the connection panel and click **Enable Wi-Fi for selected iPhone**. Ghost saves the existing pairing record locally and enables Apple's wireless connection setting.
3. Put the computer and phone on the same Wi-Fi network. Choose **Wi-Fi**, wait for your iPhone to appear, then unplug the cable.
4. Close the panel. Choose **Prepare** if needed, then set a location or start a route normally. Keep Ghost open and the computer awake.

If the iPhone does not appear, reconnect USB and enable **Show this iPhone when on Wi-Fi** in Finder (Mac) or **Show this device when on Wi-Fi** in Apple Devices (Windows), then Apply. Unlock the iPhone and refresh Ghost. First-time trust still requires a cable; this is not wireless pairing with an untrusted iPhone. iOS 17.4+ is required. [Upstream iPhone network transport guide](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md).

### Android on Mac or Windows

1. Android 11+ is required for the cable-free pairing flow. Enable Developer options by tapping Build number seven times. Enable **Wireless debugging** while on the same Wi-Fi as your computer.
2. In Ghost's connection panel choose **Wi-Fi**, then **Android**.
3. On the phone, open **Pair device with pairing code**. Enter its IP address, pairing port and six-digit code in Ghost; click **Pair phone**. Ghost does not save the code.
4. Return to the phone's main **Wireless debugging** screen. Enter that screen's IP address and **connection port** in Ghost, then click **Connect paired phone**. The connection port differs from the pairing port.
5. Close the panel, select your phone and click **Prepare** if needed. Keep Location on; select Appium Settings as the mock location app. Set a pin or start a route as usual.

If the connection drops, check Wireless debugging and reconnect with its current IP address and port. ADB may also reconnect through its local discovery. Ghost checks the phone's hardware serial so a changed port stays the same phone. Android 8–10 uses the existing USB flow. [Android wireless debugging guide](https://developer.android.com/tools/adb#wireless-android11-command-line).

### Wi-Fi troubleshooting and verification

Allow Ghost and its bundled device tools through local-network/firewall prompts. Guest networks, client isolation and VPNs can block local discovery. Use the same ordinary Wi-Fi network for both devices. To remove trust later, forget the computer in Android's Wireless debugging settings, or disable Wi-Fi visibility in Finder/Apple Devices for iPhone.

Routes still request updates every second at 45 mph; slow or lost connections pause the route instead of jumping ahead. Fixed iPhone locations keep the one-second acknowledged refresh loop; Android's helper refreshes a fixed location every two seconds. Restore before disconnecting. Wi-Fi loss, sleep or a closed app cannot guarantee immediate restoration; reconnect the phone and use Restore, or restart it.

Wi-Fi has automated adapter, transport-selection, pairing, identity, refresh and UI coverage. It has **not yet been verified end to end on physical phones on either host OS**. The working Mac → iPhone USB result does not establish Wi-Fi compatibility on a specific phone/network.
