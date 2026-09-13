# Third-party components

Ghost's original application code is offered under GPL-3.0-or-later. See LICENSE.
Dependencies retain their own copyright and license terms. No code from iDescriptor,
GeoPort, or LocationSimulator is copied into this application.

| Component | Version | Role | License / source |
| --- | --- | --- | --- |
| pymobiledevice3 | 11.12.4 | iPhone USB discovery, developer services, location simulation | GPL-3.0-or-later; https://github.com/doronz88/pymobiledevice3 |
| Appium Settings | 8.0.9 | Android mock-location helper APK | Apache-2.0; https://github.com/appium/io.appium.settings |
| Android Platform Tools / ADB | See resources/adb/*/provenance.json | Android USB transport | Bundled NOTICE files; https://developer.android.com/tools/releases/platform-tools |
| Electron | 44.3.0 | Desktop runtime | MIT and Chromium third-party notices; https://github.com/electron/electron |
| Leaflet | 1.9.4 | Interactive map | BSD-2-Clause; https://github.com/Leaflet/Leaflet |
| Lucide | See package-lock.json | Interface icons | ISC; https://github.com/lucide-icons/lucide |
| Vite | 8.3.0 | Renderer build tooling | MIT; https://github.com/vitejs/vite |
| electron-builder | 26.15.3 | Installer tooling | MIT; https://github.com/electron-userland/electron-builder |
| PyInstaller | See sidecar/requirements-build.txt | Python runtime packaging | GPL with distribution exception; https://github.com/pyinstaller/pyinstaller |

Appium Settings is bundled unmodified. Its source is available at the pinned v8.0.9
tag in the repository above. The iPhone sidecar imports the pinned upstream package;
Ghost-specific transport selection and lifecycle logic live in sidecar/ios_bridge.py.
The source and build instructions for Ghost are part of this project. When publishing
binaries, accompany them with the matching source, lockfiles, build scripts, dependency
notices, and corresponding-source material required by the bundled licenses.

Map data © OpenStreetMap contributors (ODbL). Map tiles are requested from
https://tile.openstreetmap.org under its usage policy; no offline tile downloads or
prefetching are implemented. Attribution remains visible on the map.

Place search uses Photon's public demonstration API for moderate, manually submitted
requests. Photon is Apache-2.0; underlying OpenStreetMap data is ODbL. The endpoint is
configurable in Ghost's settings. A public release with significant traffic should
use an appropriately hosted Photon service. The API operator does not guarantee uptime:
https://github.com/komoot/photon#demo-server

The application does not use the public Nominatim search API.

Road routing uses the public OSRM demo API on explicit request. OSRM is BSD-2-Clause;
Ghost does not bundle its server. Source: https://github.com/Project-OSRM/osrm-backend
The service uses OpenStreetMap data (ODbL). Stop coordinates are sent to the service
when the user plans a route; playback uses the downloaded geometry locally.
Demo limits: reasonable noncommercial use, at most one request per second, no uptime guarantee.
https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server
