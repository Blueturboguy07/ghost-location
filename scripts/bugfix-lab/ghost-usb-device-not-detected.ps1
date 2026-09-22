# bugfix-lab controlled-environment recipe for ghost-usb-device-not-detected.
#
# What this DOES exercise, on a real Windows host in CI: the exact
# AndroidAdapter code (backend/android.mjs) that ships in the Ghost release,
# run under real Node child_process.spawn on Windows, fed adb output shaped
# exactly like a real, physically-connected, USB-debugging-authorized Android
# phone (adb state "device", a usb: transport field, getprop responses) --
# matching what the reporter described (OS detected the phone, USB debugging
# prompt accepted).
#
# What this does NOT and CANNOT exercise: any real OS/USB-driver-level
# condition (missing OEM ADB driver, a real physical Nothing Phone 2, the
# bundled adb.exe binary actually launching on the reporter's machine). No
# physical Android hardware is attachable in GitHub Actions. See RESULT.json
# notes for why this stays "not fully reproduced" regardless of this script's
# outcome.

$ErrorActionPreference = 'Stop'
node --version
npm --version

Write-Host '--- npm ci ---'
npm ci

$env:GHOST_ADB_PATH = Join-Path $PWD 'scripts\bugfix-lab\mock-adb\mock-adb.cmd'
Write-Host "GHOST_ADB_PATH = $env:GHOST_ADB_PATH"

Write-Host '--- oracle-check.mjs (realistic authorized-USB-device adb output) ---'
node scripts/bugfix-lab/oracle-check.mjs
$deviceExit = $LASTEXITCODE
Write-Host "oracle-check exit code: $deviceExit"

Write-Host '--- sensitivity self-test: adb reports zero devices ---'
$env:MOCK_ADB_EMPTY = '1'
node scripts/bugfix-lab/oracle-check.mjs
$emptyExit = $LASTEXITCODE
Write-Host "oracle-check (empty-adb) exit code: $emptyExit"
Remove-Item Env:\MOCK_ADB_EMPTY

if ($deviceExit -eq 1) {
    Write-Host 'BUGFIX_LAB_PRESENT'
} else {
    Write-Host 'BUGFIX_LAB_ABSENT'
}

Write-Host "SENSITIVITY_CHECK_EMPTY_ADB_EXIT=$emptyExit (expected 1 = oracle correctly flags a real zero-device scan as PRESENT)"

if ($deviceExit -eq 1) { exit 1 } else { exit 0 }
