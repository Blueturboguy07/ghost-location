#!/usr/bin/env node
// Stand-in for a real `adb.exe` talking to one real, physically-connected,
// USB-debugging-authorized Android phone. It answers the exact subset of
// commands AndroidAdapter (backend/android.mjs) issues, using output shaped
// like real `adb devices -l` / `adb shell getprop` output for an authorized
// USB phone (matching the reporter's description: OS detected it, RSA/USB
// debugging prompt accepted -> adb state "device", not "unauthorized" or
// absent). This does not simulate any OS/USB-driver-level condition -- only
// the text-level contract between adb and Ghost's parser.
const args = process.argv.slice(2);
const SERIAL = process.env.MOCK_ADB_SERIAL || 'R3CX70ABCDE';
const joined = args.join(' ');

function out(stdout, code = 0) {
  process.stdout.write(stdout);
  process.exit(code);
}

if (joined === 'version') {
  out('Android Debug Bridge version 1.0.41\nVersion 37.0.1-12345678\nInstalled as C:\\mock\\adb.exe\n');
} else if (joined === 'devices -l') {
  if (process.env.MOCK_ADB_EMPTY === '1') out('List of devices attached\n\n');
  else out(`List of devices attached\n${SERIAL}\tdevice usb:2-3 product:Spacewar model:A065 device:Spacewar transport_id:4\n\n`);
} else if (args[0] === '-s' && args[2] === 'shell') {
  const shellArgs = args.slice(3).join(' ');
  if (shellArgs === 'getprop ro.build.version.sdk') out('34\n');
  else if (shellArgs === 'getprop ro.build.version.release') out('14\n');
  else if (shellArgs === 'pm path io.appium.settings') out('', 1); // helper not installed yet (pre-Prepare)
  else out(`mock-adb: unhandled shell command: ${shellArgs}\n`, 1);
} else if (args[0] === '-s' && args[2] === 'get-devpath') {
  out('usb:2-3\n');
} else {
  out(`mock-adb: unhandled command: ${joined}\n`, 1);
}
