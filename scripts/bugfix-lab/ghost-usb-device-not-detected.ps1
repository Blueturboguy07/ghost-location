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

Write-Host '--- compiling mock-adb.exe (Ghost spawns adb with shell:false; a .cmd/.bat is refused with EINVAL, so the stand-in must be a real .exe) ---'
$csc = Get-ChildItem "$env:SystemRoot\Microsoft.NET\Framework64" -Recurse -Filter csc.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $csc) { $csc = Get-ChildItem "$env:SystemRoot\Microsoft.NET\Framework" -Recurse -Filter csc.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $csc) { throw 'ORACLE COULD NOT RUN: no csc.exe found to build the mock adb.exe stand-in.' }
Write-Host "Using compiler: $($csc.FullName)"
& $csc.FullName /nologo /target:exe /out:scripts\bugfix-lab\mock-adb\mock-adb.exe scripts\bugfix-lab\mock-adb\mock-adb.cs
if ($LASTEXITCODE -ne 0) { throw 'ORACLE COULD NOT RUN: mock-adb.exe failed to compile.' }

$env:GHOST_ADB_PATH = Join-Path $PWD 'scripts\bugfix-lab\mock-adb\mock-adb.exe'
Write-Host "GHOST_ADB_PATH = $env:GHOST_ADB_PATH"
& $env:GHOST_ADB_PATH version
Write-Host "mock-adb.exe self-check exit code: $LASTEXITCODE"

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
