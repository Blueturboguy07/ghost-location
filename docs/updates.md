# Updates

Ghost updates itself on macOS (Apple chip and Intel) and Windows. The code is `electron/publik-updater.cjs`
(the Electron part) and `electron/publik-update-verify.cjs` (the signature check). Both files are the same in
every publik Electron app (the first copy is SurfCam's). Ghost starts them first in `boot()` in
`electron/main.mjs`, before the Sign in with publik window.

## How it works

1. Ghost asks `https://publikhq.com/api/updates/ghost/` for two files: `latest.yml` (Windows) or
   `latest-mac.yml` (macOS), and the signature of that file (`latest.yml.sig` or `latest-mac.yml.sig`).
   It asks at launch, every 24 hours, and when you click **Check for Updates…** (macOS: the Ghost menu;
   Windows: the Help menu of the application menu).
2. Ghost verifies the signature with the publik update public key, which is in `publik-update-verify.cjs`.
   If the signature is missing or wrong, Ghost stops there. It downloads nothing.
3. The feed must name this app (`publikApp: ghost`) and give a sha512 for each file.
4. electron-updater downloads the file that the feed names for this computer. It refuses the file if its
   sha512 is not the one in the signed feed.
   - Windows downloads the NSIS installer. The installer replaces the whole installed app.
   - macOS downloads a zip: on a Mac with an Apple chip the zip whose name has `arm64`, on an Intel Mac the
     other zip (`x64`). An Intel build that runs under Rosetta also takes the `arm64` zip. Squirrel.Mac
     refuses an app that does not satisfy the code signature of the running app (same bundle ID
     `org.ghostlocation.desktop`, same Developer ID), then swaps the whole `Ghost.app`.
   - The whole app is replaced in both cases: `app.asar` (the interface, `electron/` and `backend/`), the
     iPhone sidecar (the PyInstaller build of `sidecar/ios_bridge.py` in `resources/ios/<target>/`), adb,
     the Android helper and Electron itself.
5. Ghost asks: "Ghost X is ready to install. Restart now?" **Restart Now** quits Ghost, installs the
   update and starts Ghost again. **Later** installs the update when you quit Ghost. Ghost never restarts
   by itself. (Restore the phone location before you click **Restart Now**.)

A failure in the background is silent (the log has it). A manual check always shows its result.
`PUBLIK_UPDATES=0` in the environment stops the automatic checks. The CI workflows set it.

Limits:

- macOS updates need a release that is signed with the same Developer ID as the installed copy (the 0.1.9
  Mac downloads are). An unsigned Mac build cannot update itself: Squirrel.Mac has no signature to
  compare.
- Ghost 0.1.9 and older have no updater. Their users install the first version with the updater by hand.
- On Windows, Ghost's window has no menu bar (the title bar is hidden for the custom title area), so the
  Help menu with **Check for Updates…** is not visible there. The checks at launch and every 24 hours run.

## The feed contract (what publik serves)

| Request | Response |
|---|---|
| `GET /api/updates/ghost/latest.yml` | the release asset `latest.yml`, byte for byte |
| `GET /api/updates/ghost/latest.yml.sig` | the release asset `latest.yml.sig`, byte for byte |
| `GET /api/updates/ghost/latest-mac.yml` | the release asset `latest-mac.yml`, byte for byte |
| `GET /api/updates/ghost/latest-mac.yml.sig` | the release asset `latest-mac.yml.sig`, byte for byte |

- Serve the files from the scan-approved release without changes. One changed byte breaks the signature.
- The app adds `?noCache=<random>` to each request. Ignore the query string.
- A redirect is fine. A 404 means "no update" for the app.
- The base URL must not carry a query string: electron-updater copies the base query onto every file URL.
- The feed lists ABSOLUTE GitHub asset URLs. electron-updater's generic provider resolves each URL with
  `new URL(url, base)`, so an absolute URL stays as it is. The app downloads the installer from GitHub,
  not from publik.
- The app does not send electron-updater's `x-user-staging-id` header.

A Mac feed file looks like this (`scripts/publik-update-feed.cjs` makes it):

```yaml
version: '0.1.10'
publikApp: 'ghost'
files:
  - url: 'https://github.com/Blueturboguy07/ghost-location/releases/download/v0.1.10/Ghost-0.1.10-mac-arm64.zip'
    sha512: '<base64>'
    size: 184917844
  - url: 'https://github.com/Blueturboguy07/ghost-location/releases/download/v0.1.10/Ghost-0.1.10-mac-x64.zip'
    sha512: '<base64>'
    size: 193178061
  - url: '.../Ghost-0.1.10-mac-arm64.dmg'
    sha512: '<base64>'
    size: 185237377
  - url: '.../Ghost-0.1.10-mac-x64.dmg'
    sha512: '<base64>'
    size: 193212447
path: '<the url of the first file>'
sha512: '<the sha512 of the first file>'
releaseDate: '2026-11-18T00:00:00.000Z'
```

The script accepts at most one Mac zip (and one dmg) with `arm64` in its name and one without. Two files
for one architecture would make the choice depend on their order, so the script stops.

The `.sig` file is a minisign signature of the feed file. The app accepts these forms:

| Made with | Algorithm | File form |
|---|---|---|
| `tauri signer sign` (what `scripts/publik-update-feed.cjs` uses) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text, wrapped in base64 |
| `minisign -S` (minisign 0.8 and later) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text |
| `minisign -S -l` (legacy) | `Ed`: Ed25519 over the file | minisign text |

Electron's crypto has no BLAKE2b-512, so the app computes it with the `blakejs` package. The trusted
comment must name the file (`file:latest.yml` or `file:latest-mac.yml`). tauri and minisign write that by
default; do not replace it with `-t`.

## Cut a release

1. Set the new version in `package.json`. Commit and push the release branch.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. `build.yml` builds the three targets. Its
   `release` job then puts the Windows installer on the tag's release (it makes a DRAFT release if the tag
   has none; an `.exe` already on the release is kept) and runs `update-feed.yml`, which adds `latest.yml`
   and its `.sig`. (Or run **Publik build** by hand with the tag: it does the same with its own Windows
   installer.) CI never publishes a release and never puts its unsigned Mac files on it.
3. On the maintainer's Mac: sign, notarize and staple each `Ghost.app` (arm64 and x64) with the Developer ID,
   then make each zip FROM THE STAPLED APP with the release name:
   `ditto -c -k --sequesterRsrc --keepParent Ghost.app Ghost-X.Y.Z-mac-arm64.zip` (and `-mac-x64.zip`), and
   the dmgs. Upload them: `gh release upload vX.Y.Z Ghost-X.Y.Z-mac-*.zip Ghost-X.Y.Z-mac-*.dmg`.
4. Make the Mac feed: run **Actions › Update feed** with the tag (or
   `gh workflow run update-feed.yml -f tag=vX.Y.Z`). It adds `latest-mac.yml` and its `.sig`. It adds only
   missing feed files. Use **force** after you replace an installer file.
5. Check that the release holds the four feed files, then let publik scan the draft and publish it.

The update key is needed only by `update-feed.yml`: it reads the repo secrets `PUBLIK_UPDATE_KEY` and
`PUBLIK_UPDATE_KEY_PASSWORD`. Without CI, run the same script on a Mac that has the key in its keychain:

```sh
PUBLIK_UPDATE_KEY="$(security find-generic-password -s publik-update-key -a mann-private -w)" \
PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s publik-update-key -a mann-password -w)" \
node scripts/publik-update-feed.cjs release --tag vX.Y.Z --app ghost --repo Blueturboguy07/ghost-location
```

## Roll back

electron-updater never installs an older version. To roll back:

1. Stop the bad update: delete its feed files, and publik stops serving it.
   `gh release delete-asset vX.Y.Z latest.yml -y` (and `latest.yml.sig`, `latest-mac.yml`, `latest-mac.yml.sig`).
   Apps that have not downloaded it yet get a 404 and stay where they are.
2. Release the good code again with a HIGHER version (for example 0.1.12 with the code of 0.1.10), with its
   feed. Apps that installed the bad version update to it.

## Rotate the key

Every installed app trusts only the keys in `PUBLIK_UPDATE_PUBLIC_KEYS` (`publik-update-verify.cjs`).

1. Make a new key: `npx @tauri-apps/cli@2.12.4 signer generate -w new.key`. Put the private key and its
   password in the keychain and in the repo secrets. Do not delete the old key yet.
2. Add the new public key (the `RW…` line of `new.key.pub`, base64-decoded) to `PUBLIK_UPDATE_PUBLIC_KEYS`,
   next to the old key. Release that version, signed with the OLD key.
3. Wait until most users run that version. Then sign the feeds with the new key (change the secrets).
4. In a later release, remove the old key from the list.

Users who skip the transition release cannot verify feeds that the new key signs. They must install
again by hand. If the old private key leaks, do the same steps at once. On Windows the installer is not
code-signed, so the key is the only protection there. On macOS, Squirrel.Mac still requires the Developer
ID signature.

## Test builds and the proof

`.github/workflows/updater-proof.yml` proves the updater on GitHub's runners: Windows x64, macOS with an
Apple chip (`macos-15`) and Intel macOS (`macos-15-intel`). Each job builds the phone runtimes, then two
test versions, N and N+1, with `"publikUpdaterTest": true` in `package.json`. Only a test build reads these
environment variables:

| Variable | Effect (test builds only) |
|---|---|
| `PUBLIK_UPDATE_URL` | replaces `https://publikhq.com/api/updates/ghost/` |
| `PUBLIK_UPDATER_TEST=report` | writes the running version to `PUBLIK_UPDATER_RESULT` and exits |
| `PUBLIK_UPDATER_TEST=update` | runs the same check, download and install, writes the result, quits to install |

In these modes Ghost exits before the Sign in with publik window, the device scan and the main window.

The proof checks that N refuses a changed feed, a feed signed by another key, a feed with no `.sig`, an
installer with one changed byte, and (macOS) N+1 signed by another identity, and stays on N each time. Then
N updates to N+1 from the signed prerelease feed. After the update it checks that the downloaded file is
the one for this machine (by its sha512), that every file of the installed app equals the N+1 build
(the iPhone sidecar and `app.asar` included), that a marker file in the bundled backend resources went
from N to N+1, that the updated sidecar answers its status request, and (macOS) that the bundle ID,
designated requirement and signing authority did not change. The Mac feed lists both architectures; each
Mac job builds only its own (the runtimes are native builds), so the other architecture's zip is a decoy.

Test versions are `0.0.0-updtest.*`. A test feed that the real key signs is therefore never newer than a
real release. The proof puts N+1 on a prerelease with a `v0.0.0-updtest.*` tag and deletes it at the end.
The macOS test builds are signed with an identity made on the runner, not with the Developer ID.
