import {access} from 'node:fs/promises';
import path from 'node:path';
import {isIP} from 'node:net';
import {run} from './process.mjs';
import {coordinates} from './validation.mjs';

const PACKAGE = 'io.appium.settings';
const SERVICE = `${PACKAGE}/.LocationService`;
const TRACKER_SERVICE = `${PACKAGE}/.ForegroundService`;
const VALID_SERIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const COMMAND_ERROR = /(?:^|\n)\s*(?:error\b|failure\b|exception\b|security\s*exception\b|java\.[\w.]*exception\b)|permission denial|permission denied|not allowed to start|requires? permission|device (?:offline|unauthorized)|no devices\/emulators found|more than one device/i;
const exists = async file => { try { await access(file); return true; } catch { return false; } };

export function wifiEndpoint(value) {
  if (typeof value !== 'string') throw new Error('Enter the phone’s IP address and port, such as 192.168.1.20:37123.');
  const match = value.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}):([1-9]\d{0,4})$/);
  if (!match || isIP(match[1]) !== 4 || Number(match[2]) > 65535) throw new Error('Enter a valid IPv4 address and port from Wireless debugging.');
  return `${match[1]}:${Number(match[2])}`;
}

function networkSerial(serial) {
  try { return wifiEndpoint(serial) === serial; } catch { return /^adb-[A-Za-z0-9_-]+\._adb-tls-connect\._tcp\.?$/.test(serial); }
}

export function parseDevices(output, connection = 'usb') {
  return output.split(/\r?\n/).map(line => {
    const match = line.match(/^(\S+)\s+(device|unauthorized|offline)\b(.*)$/);
    if (!match) return null;
    const [, serial, adbState, tail] = match;
    const wifi = networkSerial(serial);
    if (connection === 'wifi' ? !wifi : (!VALID_SERIAL.test(serial) || /^emulator-|_adb-tls-|\.local$/i.test(serial))) return null;
    const fields = Object.fromEntries([...tail.matchAll(/\b([a-z_]+):([^\s]+)/g)].map(m => [m[1], m[2]]));
    return {serial, adbState, fields, usb: Boolean(fields.usb)};
  }).filter(Boolean);
}

export class AndroidAdapter {
  constructor({rootPath = process.cwd(), resourcesPath, runner = run, onSessionEnd = () => {}, onLocationRefresh = () => {}} = {}) {
    this.rootPath = rootPath;
    this.resourcesPath = resourcesPath;
    this.runner = runner;
    this.onSessionEnd = onSessionEnd;
    this.onLocationRefresh = onLocationRefresh;
    this.connection = 'usb';
    this.knownUsb = new Set();
    this.knownWifi = new Map();
    this.active = new Map();
    this.endedNotifications = new Set();
    this.healthFailures = new Map();
  }

  resourceRoots() {
    return [...new Set([this.resourcesPath, this.resourcesPath && path.join(this.resourcesPath, 'resources'), path.join(this.rootPath, 'resources')].filter(Boolean))];
  }

  async executable() {
    if (this.adbPath) return this.adbPath;
    const binary = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const candidates = this.resourceRoots().map(root => path.join(root, 'adb', `${process.platform}-${process.arch}`, binary));
    if (process.env.GHOST_ADB_PATH) candidates.unshift(process.env.GHOST_ADB_PATH);
    for (const candidate of candidates) if (await exists(candidate)) return (this.adbPath = candidate);
    // A developer-provided platform-tools installation is also supported.
    return binary;
  }

  async command(args, {timeoutMs = 15_000, tolerateFailure = false, input} = {}) {
    let result;
    try { result = await this.runner(await this.executable(), args, {timeoutMs, input}); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Android tools are missing. Run the Android resource preparation script or install Android Platform Tools.');
      throw error;
    }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (!tolerateFailure && (result.code !== 0 || COMMAND_ERROR.test(output))) {
      throw new Error(`Android command failed: ${output.slice(0, 1200) || `exit ${result.code}`}`);
    }
    return {...result, output};
  }

  async status() {
    try {
      const result = await this.command(['version']);
      return {available: true, message: result.stdout.trim().split('\n')[0] || 'Android tools are available.'};
    } catch (error) { return {available: false, message: error.message}; }
  }

  serialOf(device) {
    const serial = typeof device === 'string' ? device.replace(/^android:/, '') : device?.serial;
    if (!serial || !(this.connection === 'wifi' ? networkSerial(serial) : VALID_SERIAL.test(serial) && !/^emulator-|_adb-tls-/i.test(serial))) throw new Error(`A valid ${this.connection === 'wifi' ? 'Wi-Fi' : 'USB'} Android device must be selected.`);
    if (typeof device === 'object' && (device.platform !== 'android' || device.id !== `android:${device.hardwareId || serial}` || (device.hardwareId && !VALID_SERIAL.test(device.hardwareId)))) throw new Error('Android device identity does not match its serial.');
    return serial;
  }

  shell(serial, args, options) { return this.command(['-s', serial, 'shell', ...args], options); }

  async transports() {
    const {stdout} = await this.command(['devices', '-l']);
    const devices = [];
    for (const entry of parseDevices(stdout, this.connection)) {
      if (this.connection === 'wifi') {
        if (entry.adbState === 'device') {
          try {
            const identity = (await this.shell(entry.serial, ['getprop', 'ro.serialno'], {timeoutMs: 5000})).stdout.trim();
            if (!VALID_SERIAL.test(identity) || identity === 'unknown') continue;
            this.knownWifi.set(entry.serial, identity);
          } catch { continue; }
        }
        entry.hardwareId = this.knownWifi.get(entry.serial);
        if (entry.hardwareId) devices.push(entry);
        continue;
      }
      if (!entry.usb) {
        try {
          const devpath = await this.command(['-s', entry.serial, 'get-devpath'], {timeoutMs: 5_000});
          entry.usb = /^usb:/m.test(devpath.stdout.trim());
        } catch { /* Unauthorized devices may not return a device path. */ }
      }
      if (entry.usb) this.knownUsb.add(entry.serial);
      if (entry.usb || (entry.adbState !== 'device' && this.knownUsb.has(entry.serial))) devices.push(entry);
    }
    // ADB can list both an IP endpoint and an mDNS alias for the same phone.
    const unique = new Map();
    for (const entry of devices) {
      const key = entry.hardwareId || entry.serial;
      const previous = unique.get(key);
      if (!previous || (previous.adbState !== 'device' && entry.adbState === 'device') ||
          (previous.adbState === entry.adbState && this.active.has(entry.serial))) unique.set(key, entry);
    }
    return [...unique.values()];
  }

  async assertConnected(device) {
    const serial = this.serialOf(device);
    const transport = (await this.transports()).find(item => item.serial === serial);
    if (!transport) throw new Error(`This Android phone is not connected over ${this.connection === 'wifi' ? 'Wi-Fi' : 'USB'}. Reconnect it before continuing.`);
    if (`android:${transport.hardwareId || serial}` !== device.id) throw new Error('The phone at this address has changed. Refresh and select it again.');
    if (transport.adbState === 'unauthorized') throw new Error('Unlock the Android phone and accept the USB debugging authorization prompt.');
    if (transport.adbState !== 'device') throw new Error('The Android phone is offline. Unlock it and reconnect.');
    return serial;
  }

  async info(serial) {
    const [sdk, release] = await Promise.all([
      this.shell(serial, ['getprop', 'ro.build.version.sdk']),
      this.shell(serial, ['getprop', 'ro.build.version.release']),
    ]);
    const api = Number(sdk.stdout.trim());
    if (!Number.isInteger(api) || api < 1) throw new Error('Could not determine the Android version.');
    return {api, osVersion: release.stdout.trim() || `API ${api}`};
  }

  async readiness(serial, api) {
    if (api < 26) return {ready: false, detail: 'Android 8.0 or newer is required.'};
    const installed = await this.shell(serial, ['pm', 'path', PACKAGE], {tolerateFailure: true});
    if (!/^package:/m.test(installed.stdout)) return {ready: false, detail: 'Install and configure the Android location helper.'};
    const [appops, packageInfo, mode] = await Promise.all([
      this.shell(serial, ['appops', 'get', PACKAGE, 'android:mock_location'], {tolerateFailure: true}),
      this.shell(serial, ['dumpsys', 'package', PACKAGE]),
      this.shell(serial, ['settings', 'get', 'secure', 'location_mode']),
    ]);
    if (!/MOCK_LOCATION:\s*allow|android:mock_location:\s*allow/i.test(appops.stdout)) return {ready: false, detail: 'Select Appium Settings as the mock location app in Developer options, or run setup.'};
    if (!/android\.permission\.ACCESS_FINE_LOCATION:\s*granted=true/.test(packageInfo.stdout)) return {ready: false, detail: 'The Android helper needs precise location permission. Run setup.'};
    if (/^(?:0|null)\s*$/.test(mode.stdout)) return {ready: false, detail: 'Turn on Location in the Android phone settings.'};
    return {ready: true, detail: `${this.connection === 'wifi' ? 'Wi-Fi' : 'USB'} connected. Ready to set a location.`};
  }

  async list() {
    const entries = await this.transports();
    return Promise.all(entries.map(async entry => {
      const device = {id: `android:${entry.hardwareId || entry.serial}`, serial: entry.serial, ...(entry.hardwareId ? {hardwareId: entry.hardwareId} : {}), platform: 'android', name: (entry.fields.model || entry.serial).replaceAll('_', ' '), osVersion: '', connection: this.connection};
      if (entry.adbState !== 'device') return {...device, state: entry.adbState, detail: entry.adbState === 'unauthorized' ? 'Unlock this phone and accept the USB debugging prompt.' : 'Phone is offline. Reconnect it.'};
      try {
        // Keep ownership when Android changes its Wi-Fi port or ADB uses an alias.
        // Identity was read from the authenticated device during this scan.
        for (const [oldSerial, target] of this.active) {
          if (target.id !== device.id || oldSerial === entry.serial) continue;
          this.active.delete(oldSerial);
          this.active.set(entry.serial, {...target, ...device});
          if (this.endedNotifications.delete(oldSerial)) this.endedNotifications.add(entry.serial);
          this.healthFailures.delete(oldSerial);
        }
        const info = await this.info(entry.serial);
        const check = await this.readiness(entry.serial, info.api);
        if (this.active.has(entry.serial)) {
          if (!check.ready || !await this.serviceRunning(entry.serial)) {
            await this.reportEnded(device, 'The Android location service stopped or lost permission. Reconnect and apply again, or restore the real location.');
          } else {
            await this.checkActiveLocation(device);
          }
        }
        return {...device, osVersion: info.osVersion, state: check.ready ? 'ready' : 'setup-required', detail: check.detail};
      } catch (error) { return {...device, state: 'setup-required', detail: error.message}; }
    }));
  }

  async connectWifi({endpoint, code} = {}) {
    const address = wifiEndpoint(endpoint);
    if (code !== undefined && (typeof code !== 'string' || !/^\d{6}$/.test(code))) throw new Error('Enter the six-digit pairing code shown on the phone.');
    if (this.connection !== 'wifi') throw new Error('Choose Wi-Fi before pairing or connecting.');
    const pairing = code !== undefined;
    // The short-lived pairing secret goes through stdin, never command arguments or settings.
    const result = await this.command([pairing ? 'pair' : 'connect', address], {
      timeoutMs: 30_000, tolerateFailure: true, input: pairing ? `${code}\n` : undefined,
    }).catch(() => { throw new Error('Wireless debugging did not respond. Check the address, port and Wi-Fi connection.'); });
    if (result.code !== 0 || !(pairing ? /Successfully paired to/i : /(?:already )?connected to/i).test(result.output) || /failed|cannot|unable/i.test(result.output)) {
      throw new Error(pairing ? 'Pairing failed. Open Pair device with pairing code and try the new code and pairing port.' : 'Connection failed. Use the IP address and port on the main Wireless debugging screen.');
    }
    return {ok: true};
  }

  async prepare(device) {
    const serial = await this.assertConnected(device);
    const {api} = await this.info(serial);
    if (api < 26) throw new Error('Android 8.0 or newer is required by the bundled helper.');
    let apk;
    for (const root of this.resourceRoots()) {
      const candidate = path.join(root, 'android', 'settings.apk');
      if (await exists(candidate)) { apk = candidate; break; }
    }
    if (!apk) throw new Error('The Android helper APK is missing. Run the Android resource preparation script.');
    const install = await this.command(['-s', serial, 'install', '-r', apk], {timeoutMs: 120_000});
    if (!/\bSuccess\b/.test(install.output)) throw new Error(`Android did not confirm helper installation: ${install.output}`);
    // Do not use install -g: the general Appium helper declares unrelated permissions.
    for (const permission of ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', ...(api >= 29 ? ['ACCESS_BACKGROUND_LOCATION'] : [])]) {
      await this.shell(serial, ['pm', 'grant', PACKAGE, `android.permission.${permission}`]);
    }
    await this.shell(serial, ['appops', 'set', PACKAGE, 'android:mock_location', 'allow']);
    const check = await this.readiness(serial, api);
    if (!check.ready) throw new Error(check.detail);
    return {ok: true, message: 'Android helper installed and configured.'};
  }

  async serviceRunning(serial, component = SERVICE) {
    const result = await this.shell(serial, ['dumpsys', 'activity', 'services', component]);
    const name = component === SERVICE ? 'LocationService' : 'ForegroundService';
    return new RegExp(`ServiceRecord\\{[^\\n]*\\bio\\.appium\\.settings\\/(?:\\.${name}|io\\.appium\\.settings\\.${name})\\b`).test(result.stdout);
  }

  async waitForService(serial, expected, component = SERVICE) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await this.serviceRunning(serial, component) === expected) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(expected ? 'Android did not confirm that the location service started. Unlock the phone and check the helper permissions.' : 'Android still reports the location service running. Stop Appium Settings on the phone.');
  }

  async reportEnded(device, error) {
    if (this.endedNotifications.has(device.serial)) return;
    this.endedNotifications.add(device.serial);
    await this.onSessionEnd({deviceId: device.id, sessionId: this.active.get(device.serial)?.sessionId, error});
  }

  async readLocation(serial, {refresh = false} = {}) {
    const result = await this.shell(serial, ['am', 'broadcast', '-n', `${PACKAGE}/.receivers.LocationInfoReceiver`, '-a', `${PACKAGE}.location`, '--ez', 'forceUpdate', String(refresh)], {timeoutMs: 5_000});
    const match = result.stdout.match(/result=-1\b[^\n]*\bdata="(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)"/);
    if (!match) return null;
    const latitude = Number(match[1]), longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
    return {latitude, longitude};
  }

  matchesLocation(actual, expected) {
    return Boolean(actual) && Math.abs(actual.latitude - expected.latitude) <= 0.00000015 && Math.abs(actual.longitude - expected.longitude) <= 0.00000015;
  }

  async checkActiveLocation(device) {
    const target = this.active.get(device.serial);
    let actual;
    try { actual = await this.readLocation(device.serial); } catch { /* The next poll can recover a transient read failure. */ }
    // A route can advance while the helper's tracker readback is still pending.
    // Accept only recent points in this session, never an arbitrary old fix.
    const latest = this.active.get(device.serial);
    if (!latest || latest.sessionId !== target?.sessionId) return;
    const recent = latest.recentTargets?.filter(p => Date.now() - p.sentAt <= 6000) || [];
    if (this.matchesLocation(actual, latest) || recent.some(p => this.matchesLocation(actual, p))) {
      this.healthFailures.delete(device.serial);
      // This is a readback confirmation time, not the phone fix's timestamp:
      // the upstream receiver exposes coordinates but does not expose fix age.
      await this.onLocationRefresh({deviceId: device.id, sessionId: target.sessionId, ...actual, refreshedAt: new Date().toISOString(), refreshIntervalMs: 2000, source: 'helper-readback'});
      return;
    }
    const count = (this.healthFailures.get(device.serial) || 0) + 1;
    this.healthFailures.set(device.serial, count);
    if (count >= 2) await this.reportEnded(device, 'Android no longer confirms the selected coordinates. Apply the location again or restore the real location.');
  }

  async verifyLocation(serial, {latitude, longitude}) {
    // Appium's explicit receiver returns seven decimal places. Its tracker can
    // take five seconds to update on devices without Google Play Services.
    for (let attempt = 0; attempt < 11; attempt++) {
      if (this.matchesLocation(await this.readLocation(serial, {refresh: true}), {latitude, longitude})) return;
      if (attempt < 10) await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error('The Android helper did not report the requested coordinates. The previous location may still be active; apply again to retry or use Restore to stop simulation.');
  }

  async set(device, {latitude, longitude, sessionId}) {
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Latitude and longitude must be valid numbers.');
    const serial = await this.assertConnected(device);
    const {api} = await this.info(serial);
    const check = await this.readiness(serial, api);
    if (!check.ready) throw new Error(check.detail);
    // Journal cleanup responsibility before either phone-side service starts.
    this.active.set(serial, {...device, latitude, longitude, sessionId});
    this.endedNotifications.delete(serial);
    this.healthFailures.delete(serial);
    // The Settings activity starts Appium's LocationTracker and then finishes.
    // Without this bootstrap its coordinate readback always returns no data.
    if (!await this.serviceRunning(serial, TRACKER_SERVICE)) {
      await this.shell(serial, ['am', 'start', '-n', `${PACKAGE}/.Settings`, '-a', 'android.intent.action.MAIN']);
      await this.waitForService(serial, true, TRACKER_SERVICE);
    }
    // Appium 8.0.9 replaces the previous target in onStartCommand and then emits
    // fresh timestamped fixes every 2000 ms on-device; no desktop restart loop.
    await this.shell(serial, ['am', 'start-foreground-service', '-n', SERVICE, '--es', 'latitude', String(latitude), '--es', 'longitude', String(longitude), '--es', 'accuracy', '5']);
    await this.waitForService(serial, true);
    await this.verifyLocation(serial, {latitude, longitude});
    return {ok: true, message: 'The Android helper reports the selected coordinates. Other apps may take a moment to receive the new location.', latitude, longitude};
  }

  async update(device, input) {
    const point = coordinates(input), serial = this.serialOf(device);
    const target = this.active.get(serial);
    if (!target || target.sessionId !== input.sessionId || this.endedNotifications.has(serial)) throw new Error('The Android route session is no longer active. Reconnect this phone.');
    const sentAt = Date.now();
    const recentTargets = [...(target.recentTargets || []), {latitude: target.latitude, longitude: target.longitude, sentAt}].filter(p => sentAt - p.sentAt <= 6000).slice(-8);
    this.active.set(serial, {...target, ...point, recentTargets});
    // Appium 8.0.9 onStartCommand reschedules an immediate fix on the existing
    // service. No setup/readback retry loop on each one-second route update.
    await this.shell(serial, ['am', 'start-foreground-service', '-n', SERVICE, '--es', 'latitude', String(point.latitude), '--es', 'longitude', String(point.longitude), '--es', 'accuracy', '5'], {timeoutMs: 5000});
    return {ok: true, refreshedAt: new Date().toISOString()};
  }

  async clear(device) {
    const serial = await this.assertConnected(device);
    // Android 14 can return shell status 255 even while printing "Service
    // stopped". The following dumpsys check is the authoritative result.
    await this.shell(serial, ['am', 'stopservice', '-n', SERVICE], {tolerateFailure: true});
    await this.waitForService(serial, false);
    await this.shell(serial, ['am', 'stopservice', '-n', TRACKER_SERVICE], {tolerateFailure: true});
    await this.waitForService(serial, false, TRACKER_SERVICE);
    this.active.delete(serial);
    this.endedNotifications.delete(serial);
    this.healthFailures.delete(serial);
    return {ok: true, message: 'Android location simulation stopped. Apps may need time to obtain a fresh real location.'};
  }

  async reset(device) {
    // Reset only Ghost's ownership bookkeeping. It deliberately sends no ADB
    // command: recovery callers either replace the target immediately, or have
    // explicitly chosen to forget an unreachable phone's unresolved record.
    const serial = this.serialOf(device);
    this.active.delete(serial);
    this.endedNotifications.delete(serial);
    this.healthFailures.delete(serial);
    return {reset: true};
  }

  async dispose({restore = true} = {}) {
    if (!restore) return;
    const results = await Promise.allSettled([...this.active.values()].map(device => this.clear(device)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new Error(`Could not verify Android location cleanup: ${failures.map(result => result.reason.message).join(' ')}`);
  }
}
