import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AndroidAdapter, parseDevices} from '../backend/android.mjs';
import {Controller} from '../backend/controller.mjs';
import {defaults} from '../backend/store.mjs';

const phone = {id: 'android:USB123', serial: 'USB123', platform: 'android'};
function rig({devices = 'USB123 device usb:1-2 product:test model:Pixel_8 transport_id:1', override, installed = true, permitted = true, stopExitCode = 0} = {}) {
  const calls = [];
  let running = false, trackerRunning = false, latitude = 0, longitude = 0;
  const runner = async (file, args) => {
    calls.push({file, args});
    const answer = await override?.(args);
    if (answer) return {stdout: '', stderr: '', code: 0, ...answer};
    let stdout = '';
    const command = args.join(' ');
    if (command === 'devices -l') stdout = `List of devices attached\n${devices}\n`;
    else if (command === 'version') stdout = 'Android Debug Bridge version 1.0.41';
    else if (command.endsWith('getprop ro.serialno')) stdout = args[1].includes('other') ? 'OTHER123' : 'USB123';
    else if (command.endsWith('getprop ro.build.version.sdk')) stdout = '35\n';
    else if (command.endsWith('getprop ro.build.version.release')) stdout = '15\n';
    else if (command.endsWith('get-devpath')) stdout = 'usb:1-2\n';
    else if (command.endsWith('pm path io.appium.settings')) stdout = installed ? 'package:/data/app/settings/base.apk\n' : '';
    else if (command.includes('appops get')) stdout = permitted ? 'MOCK_LOCATION: allow\n' : 'MOCK_LOCATION: deny\n';
    else if (command.includes('dumpsys package')) stdout = 'android.permission.ACCESS_FINE_LOCATION: granted=true\n';
    else if (command.endsWith('settings get secure location_mode')) stdout = '3\n';
    else if (args.includes('install')) stdout = 'Performing Streamed Install\nSuccess\n';
    else if (args.includes('start')) { trackerRunning = true; stdout = 'Starting: Intent { cmp=io.appium.settings/.Settings }\n'; }
    else if (args.includes('start-foreground-service')) {
      running = true;
      latitude = args[args.indexOf('latitude') + 1]; longitude = args[args.indexOf('longitude') + 1];
      stdout = 'Starting service: Intent { cmp=io.appium.settings/.LocationService }\n';
    }
    else if (args.includes('stopservice')) {
      if (args.at(-1).includes('.LocationService')) running = false; else trackerRunning = false;
      return {stdout: `Stopping service: Intent { cmp=${args.at(-1)} }\nService stopped\n`, stderr: '', code: stopExitCode};
    }
    else if (command.includes('dumpsys activity services')) {
      const tracker = args.at(-1).includes('.ForegroundService');
      stdout = (tracker ? trackerRunning : running) ? `ServiceRecord{123 u0 ${args.at(-1)}}\n` : '(nothing)\n';
    }
    else if (args.includes('broadcast')) stdout = `Broadcast completed: result=-1, data="${latitude} ${longitude} 0.0000000"\n`;
    else if (!command.includes('pm grant') && !command.includes('appops set')) throw new Error(`Unexpected command: ${command}`);
    return {stdout, stderr: '', code: 0};
  };
  return {adapter: new AndroidAdapter({runner}), calls};
}

test('transport parsing excludes emulator, IPv4, IPv6 and ADB Wi-Fi names', () => {
  const parsed = parseDevices('List of devices attached\nUSB123 device usb:1-2 model:Pixel_8\n192.168.1.4:5555 device\n[fe80::1]:5555 device\nemulator-5554 device\nadb-123-aaa._adb-tls-connect._tcp device\nUSB456 unauthorized usb:1-3\n');
  assert.deepEqual(parsed.map(item => item.serial), ['USB123', 'USB456']);
});

test('USB path evidence is required even for a normal-looking serial', async () => {
  const {adapter} = rig({devices: 'USB123 device model:Pixel\nLOOKS_USB device model:Remote', override: args => args.includes('get-devpath') ? {stdout: args[1] === 'USB123' ? 'usb:123\n' : 'unknown\n'} : null});
  assert.deepEqual((await adapter.list()).map(device => device.serial), ['USB123']);
});

test('unauthorized USB phones are visible without permission or package reads', async () => {
  const {adapter, calls} = rig({devices: 'USB123 unauthorized usb:1-2'});
  const result = await adapter.list();
  assert.equal(result[0].state, 'unauthorized');
  assert.equal(calls.length, 1);
  await assert.rejects(adapter.set(phone, {latitude: 12, longitude: 13}), /accept the USB debugging/);
  assert.ok(!calls.some(call => call.args.includes('shell')));
});

test('set and clear address exactly the selected USB device and verify service state', async () => {
  const {adapter, calls} = rig();
  assert.equal((await adapter.list())[0].state, 'ready');
  await adapter.set(phone, {latitude: 41.8781, longitude: -87.6298});
  assert.equal(adapter.active.size, 1);
  const mutation = calls.find(call => call.args.includes('start-foreground-service'));
  assert.deepEqual(mutation.args.slice(0, 3), ['-s', 'USB123', 'shell']);
  assert.ok(mutation.args.includes('-87.6298'));
  assert.ok(calls.some(call => call.args.includes('services')));
  assert.ok(calls.some(call => call.args.includes('broadcast')));
  await adapter.clear(phone);
  assert.equal(adapter.active.size, 0);
});

test('clear trusts stopped-service readback when Android returns shell status 255', async () => {
  const {adapter} = rig({stopExitCode: 255});
  await adapter.set(phone, {latitude: 41.8781, longitude: -87.6298});
  await adapter.clear(phone);
  assert.equal(adapter.active.size, 0);
});

test('an existing service does not confirm new coordinates until helper readback changes', async () => {
  let stale = false, readbacks = 0;
  const {adapter} = rig({override: args => {
    if (stale && args.includes('broadcast') && readbacks++ === 0) return {stdout: 'Broadcast completed: result=-1, data="10.0000000 20.0000000 0.0000000"\n'};
    return null;
  }});
  await adapter.set(phone, {latitude: 10, longitude: 20});
  stale = true;
  await adapter.set(phone, {latitude: 30, longitude: 40});
  assert.equal(readbacks, 2);
});

test('updating the target reuses the running tracker and never stops the location scheduler', async () => {
  const {adapter, calls} = rig();
  await adapter.set(phone, {latitude: 10, longitude: 20, sessionId: 'first'});
  await adapter.set(phone, {latitude: 30, longitude: 40, sessionId: 'second'});
  assert.equal(calls.filter(call => call.args.includes('start')).length, 1);
  assert.equal(calls.filter(call => call.args.includes('start-foreground-service')).length, 2);
  assert.equal(calls.filter(call => call.args.includes('stopservice')).length, 0);
  assert.equal(adapter.active.get(phone.serial).sessionId, 'second');
});

test('route updates send one immediate target command without repeated setup or readback retries', async () => {
  const {adapter, calls} = rig();
  await adapter.set(phone, {latitude: 10, longitude: 20, sessionId: 'route'});
  calls.length = 0;
  for (let i = 1; i <= 10; i++) await adapter.update(phone, {latitude: 10 + i / 10000, longitude: 20, sessionId: 'route'});
  assert.equal(calls.length, 10);
  assert.ok(calls.every(c => c.args.includes('start-foreground-service') && c.args[1] === phone.serial));
  await assert.rejects(adapter.update(phone, {latitude: 10, longitude: 20, sessionId: 'old'}), /no longer active/);
  await assert.rejects(adapter.update(phone, {latitude: NaN, longitude: 20, sessionId: 'route'}));
  assert.equal(calls.length, 10);
});

test('route health accepts recent tracker lag but rejects unrelated coordinates', async () => {
  let readback = null;
  const {adapter} = rig({override: args => args.includes('broadcast') && readback ? {stdout: `Broadcast completed: result=-1, data="${readback} 20 0"`} : null});
  const ended = []; adapter.onSessionEnd = e => ended.push(e);
  await adapter.set(phone, {latitude: 10, longitude: 20, sessionId: 'route'});
  await adapter.update(phone, {latitude: 10.0002, longitude: 20, sessionId: 'route'});
  readback = '10';
  await adapter.list(); await adapter.list(); assert.equal(ended.length, 0);
  readback = '11';
  await adapter.list(); await adapter.list(); assert.equal(ended.length, 1);
});

test('health polling confirms the current session through readback without restarting or changing location', async () => {
  const {adapter, calls} = rig();
  const confirmations = [];
  adapter.onLocationRefresh = event => confirmations.push(event);
  await adapter.set(phone, {latitude: 10, longitude: 20, sessionId: 'current-session'});
  const baseline = calls.length;
  await adapter.list();
  await adapter.list();
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[0].deviceId, phone.id);
  assert.equal(confirmations[0].sessionId, 'current-session');
  assert.equal(confirmations[0].source, 'helper-readback');
  assert.equal(confirmations[0].refreshIntervalMs, 2000);
  assert.ok(Number.isFinite(Date.parse(confirmations[0].refreshedAt)));
  const pollCommands = calls.slice(baseline).map(call => call.args);
  assert.equal(pollCommands.filter(args => args.includes('broadcast')).length, 2);
  assert.ok(pollCommands.filter(args => args.includes('broadcast')).every(args => args.at(-1) === 'false'));
  assert.ok(!pollCommands.some(args => args.includes('start') || args.includes('start-foreground-service') || args.includes('stopservice') || args.includes('grant')));
});

test('health readback tolerates one miss, reports sustained mismatch once, and recovers after a new set', async () => {
  let wrongLocation = false;
  const {adapter} = rig({override: args => wrongLocation && args.includes('broadcast') ? {stdout: 'Broadcast completed: result=-1, data="-12.0000000 -34.0000000 0.0000000"\n'} : null});
  const ended = [], confirmations = [];
  adapter.onSessionEnd = event => ended.push(event);
  adapter.onLocationRefresh = event => confirmations.push(event);
  await adapter.set(phone, {latitude: 10, longitude: 20, sessionId: 'previous'});
  wrongLocation = true;
  await adapter.list();
  assert.equal(ended.length, 0);
  await adapter.list();
  await adapter.list();
  assert.equal(ended.length, 1);
  assert.equal(ended[0].sessionId, 'previous');
  assert.equal(confirmations.length, 0);
  wrongLocation = false;
  await adapter.set(phone, {latitude: 30, longitude: 40, sessionId: 'replacement'});
  await adapter.list();
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].sessionId, 'replacement');
  assert.equal(confirmations[0].latitude, 30);
});

test('reconnected USB phone accepts a replacement target without Restore or another helper install', async () => {
  let connected = true;
  const {adapter, calls} = rig({override: args => args[0] === 'devices' && !connected ? {stdout: 'List of devices attached\n'} : null});
  await adapter.set(phone, {latitude: 10, longitude: 20, sessionId: 'before-unplug'});
  connected = false;
  assert.deepEqual(await adapter.list(), []);
  connected = true;
  await adapter.set(phone, {latitude: 30, longitude: 40, sessionId: 'after-reconnect'});
  assert.equal(adapter.active.get(phone.serial).latitude, 30);
  assert.equal(adapter.active.get(phone.serial).sessionId, 'after-reconnect');
  assert.ok(!calls.some(call => call.args.includes('install') || call.args.includes('stopservice')));
});

test('forty-second Android/controller timeline keeps a healthy session active and recovers the same USB target', async () => {
  let connected = true;
  let elapsed = 0;
  const epoch = Date.parse('2026-09-13T12:00:00Z');
  const {adapter, calls} = rig({override: args => args[0] === 'devices' && !connected ? {stdout: 'List of devices attached\n'} : null});
  const saved = defaults();
  const store = {load: async () => structuredClone(saved), save: async value => Object.assign(saved, structuredClone(value))};
  const controller = new Controller({adapters: {android: adapter}, store, now: () => epoch + elapsed});
  adapter.onSessionEnd = event => controller.sessionEnded(event);
  adapter.onLocationRefresh = event => controller.locationRefreshed({...event, refreshedAt: new Date(epoch + elapsed).toISOString()});
  const scanAt = async milliseconds => { elapsed = milliseconds; await controller.scanDevices(); };
  const starts = () => calls.filter(call => call.args.includes('start-foreground-service'));
  await controller.init();
  await controller.applyLocation({deviceId: phone.id, latitude: 37.774912345, longitude: -122.4194, label: 'First pin'});
  const originalId = controller.state.session.id;

  // Seven real adapter/controller poll cycles span the reported five-second
  // failure point. Virtual time makes this deterministic and touches no phone.
  for (let time = 2000; time <= 14000; time += 2000) {
    await scanAt(time);
    assert.equal(controller.state.session.status, 'active', `healthy at ${time}ms`);
    assert.equal(controller.state.session.id, originalId);
    assert.equal(controller.state.session.lastRefreshAt, new Date(epoch + time).toISOString());
  }
  assert.equal(starts().length, 1, 'polling must not restart the helper');

  connected = false;
  await scanAt(16000); assert.equal(controller.state.session.status, 'active');
  await scanAt(18000); assert.equal(controller.state.session.status, 'waiting');
  assert.equal(adapter.active.size, 1, 'unplugging must retain cleanup responsibility');
  assert.equal(starts().length, 1);
  connected = true;
  await scanAt(20000);
  assert.equal(controller.state.session.status, 'active');
  assert.notEqual(controller.state.session.id, originalId);
  assert.equal(starts().length, 2, 'replug should resume once');

  elapsed = 22000;
  await controller.applyLocation({deviceId: phone.id, latitude: -33.8688, longitude: 151.2093, label: 'Updated pin'});
  const updatedId = controller.state.session.id;
  for (let time = 24000; time <= 40000; time += 2000) {
    await scanAt(time);
    assert.equal(controller.state.session.status, 'active', `updated target at ${time}ms`);
    assert.equal(controller.state.session.id, updatedId);
    assert.equal(controller.state.session.latitude, -33.8688);
    assert.equal(controller.state.session.longitude, 151.2093);
  }
  assert.equal(starts().length, 3, 'only initial, reconnect, and explicit update should set coordinates');
  assert.ok(starts().every(call => call.args[0] === '-s' && call.args[1] === phone.serial));
  assert.ok(!calls.some(call => call.args.includes('stopservice') || call.args.includes('install') || call.args.includes('grant')));
  assert.equal(controller.state.busy, false);
  await controller.stopLocation();
  await scanAt(42000);
  assert.equal(controller.state.session, null);
  assert.equal(adapter.active.size, 0);
  assert.equal(starts().length, 3, 'Restore must prevent later automatic resume');
});

test('dispose without restore performs no additional phone commands', async () => {
  const {adapter, calls} = rig();
  await adapter.set(phone, {latitude: 1, longitude: 2});
  const before = calls.length;
  await adapter.dispose({restore: false});
  assert.equal(calls.length, before);
  assert.equal(adapter.active.size, 1);
});

test('a stopped phone service reports an ended session even when USB remains connected', async () => {
  let stopped = false;
  const {adapter} = rig({override: args => stopped && args.includes('services') && args.at(-1).endsWith('/.LocationService') ? {stdout: '(nothing)\n'} : null});
  const ended = [];
  adapter.onSessionEnd = event => ended.push(event);
  await adapter.set(phone, {latitude: 1, longitude: 2});
  stopped = true;
  await adapter.list();
  await adapter.list();
  assert.equal(ended.length, 1);
  assert.equal(ended[0].deviceId, phone.id);
  assert.equal(adapter.active.size, 1);
});

test('rejects injected or mismatched device identities and non-numeric coordinates', async () => {
  const {adapter, calls} = rig();
  await assert.rejects(adapter.set({...phone, serial: 'USB123;reboot'}, {latitude: 1, longitude: 2}), /valid USB Android/);
  await assert.rejects(adapter.set({...phone, id: 'android:DIFFERENT'}, {latitude: 1, longitude: 2}), /identity/);
  await assert.rejects(adapter.set(phone, {latitude: '1;reboot', longitude: 2}), /valid numbers/);
  await assert.rejects(adapter.set(phone, {latitude: 91, longitude: 2}), /valid numbers/);
  assert.equal(calls.length, 0);
});

test('set never installs or grants permissions without explicit prepare', async () => {
  const {adapter, calls} = rig({installed: false});
  await assert.rejects(adapter.set(phone, {latitude: 0, longitude: 0}), /Install and configure/);
  assert.ok(!calls.some(call => call.args.includes('install') || call.args.includes('grant') || call.args.includes('start-foreground-service')));
});

test('ADB failure text is rejected even when its exit status is zero', async () => {
  const {adapter} = rig({override: args => args.includes('start-foreground-service') ? {stdout: 'Error: Permission Denial: foreground service not allowed'} : null});
  await assert.rejects(adapter.set(phone, {latitude: 0, longitude: 0}), /Permission Denial/);
});

test('disconnect before clear does not report restoration or remove tracked session', async () => {
  let connected = true;
  const {adapter} = rig({override: args => args[0] === 'devices' && !connected ? {stdout: 'List of devices attached\n'} : null});
  await adapter.set(phone, {latitude: 0, longitude: 0});
  connected = false;
  await assert.rejects(adapter.clear(phone), /not connected over USB/);
  assert.equal(adapter.active.size, 1);
});

test('an unverified service start remains tracked for cleanup and is not reported as success', async () => {
  const {adapter} = rig({override: args => args.includes('services') ? {stdout: '(nothing)\n'} : null});
  await assert.rejects(adapter.set(phone, {latitude: 0, longitude: 0}), /did not confirm/);
  assert.equal(adapter.active.size, 1);
  await adapter.dispose();
  assert.equal(adapter.active.size, 0);
});

test('prepare installs only the selected helper and grants only location permissions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ghost-android-test-'));
  try {
    await mkdir(path.join(root, 'resources', 'android'), {recursive: true});
    await writeFile(path.join(root, 'resources', 'android', 'settings.apk'), 'test-only');
    const {adapter, calls} = rig();
    adapter.rootPath = root;
    await adapter.prepare(phone);
    const install = calls.find(call => call.args.includes('install'));
    assert.deepEqual(install.args.slice(0, 4), ['-s', 'USB123', 'install', '-r']);
    assert.ok(!install.args.includes('-g'));
    const permissions = calls.filter(call => call.args.includes('grant')).map(call => call.args.at(-1));
    assert.deepEqual(permissions, ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_BACKGROUND_LOCATION']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('Android below API 26 is blocked before installation', async () => {
  const {adapter, calls} = rig({override: args => args.at(-1) === 'ro.build.version.sdk' ? {stdout: '25\n'} : null});
  await assert.rejects(adapter.prepare(phone), /Android 8.0/);
  assert.ok(!calls.some(call => call.args.includes('install')));
});

test('Wi-Fi discovery is opt-in and location updates target only the chosen network phone', async () => {
  const serial = '192.168.1.20:40567';
  const {adapter, calls} = rig({devices: `USB123 device usb:1-2\n${serial} device model:Pixel_8\nadb-other._adb-tls-connect._tcp device model:Other\nemulator-5554 device`});
  assert.deepEqual((await adapter.list()).map(d => d.serial), ['USB123']);
  adapter.connection = 'wifi';
  const devices = await adapter.list();
  assert.equal(devices.length, 2);
  assert.ok(devices.every(d => d.connection === 'wifi'));
  const device = devices.find(d => d.serial === serial);
  await adapter.set(device, {latitude: 1, longitude: 2, sessionId: 'wifi-session'});
  for (let second = 1; second <= 6; second++) await adapter.update(device, {latitude: 1 + second / 1000, longitude: 2, sessionId: 'wifi-session'});
  await adapter.clear(device);
  assert.equal(adapter.active.size, 0);
  const writes = calls.filter(call => call.args.some(arg => ['start-foreground-service', 'stopservice'].includes(arg)));
  assert.equal(writes.filter(call => call.args.includes('start-foreground-service')).length, 7);
  assert.ok(writes.every(call => call.args[0] === '-s' && call.args[1] === serial));
});

test('Android wireless pairing validates input and keeps the code out of argv and errors', async () => {
  const calls = [];
  let output = 'Successfully paired to 192.168.1.20:37123';
  const adapter = new AndroidAdapter({runner: async (_file, args, options) => {
    calls.push({args, options}); return {code: 0, stdout: output, stderr: ''};
  }});
  adapter.connection = 'wifi';
  for (const endpoint of ['--help', '192.168.1.20:0', '192.168.1.20:65536', '999.1.1.1:42', 'localhost;shutdown:42']) {
    await assert.rejects(adapter.connectWifi({endpoint, code: '123456'}));
  }
  await assert.rejects(adapter.connectWifi({endpoint: '192.168.1.20:37123', code: '12345x'}));
  assert.equal(calls.length, 0);
  await adapter.connectWifi({endpoint: '192.168.1.20:37123', code: '123456'});
  assert.deepEqual(calls[0].args, ['pair', '192.168.1.20:37123']);
  assert.equal(calls[0].options.input, '123456\n');
  output = 'failed to connect, secret 123456';
  await assert.rejects(adapter.connectWifi({endpoint: '192.168.1.20:40567'}), error => /Connection failed/.test(error.message) && !error.message.includes('123456'));
  output = 'connected to 192.168.1.20:40567';
  await adapter.connectWifi({endpoint: '192.168.1.20:40567'});
  assert.deepEqual(calls.at(-1).args, ['connect', '192.168.1.20:40567']);
});

test('Android keeps the same phone identity across Wi-Fi port changes and rejects a reused address', async () => {
  let endpoint = '192.168.1.20:40000', identity = 'USB123';
  const {adapter, calls} = rig({override: args => {
    if (args.join(' ') === 'devices -l') return {stdout: `${endpoint !== '192.168.1.20:40000' ? '192.168.1.20:40000 offline\n' : ''}${endpoint} device model:Pixel_8\n`};
    if (args.at(-1) === 'ro.serialno') return {stdout: identity};
  }});
  adapter.connection = 'wifi';
  const before = (await adapter.list())[0];
  await adapter.set(before, {latitude: 1, longitude: 2, sessionId: 'wifi-port'});
  endpoint = '192.168.1.20:40001';
  const after = (await adapter.list())[0];
  assert.equal(after.id, before.id);
  assert.notEqual(after.serial, before.serial);
  await adapter.update(after, {latitude: 1.001, longitude: 2, sessionId: 'wifi-port'});
  assert.equal(calls.at(-1).args[1], endpoint);
  identity = 'OTHERPHONE';
  const writesBefore = calls.filter(call => call.args.includes('stopservice')).length;
  await assert.rejects(adapter.clear(after), /phone at this address has changed/);
  assert.equal(calls.filter(call => call.args.includes('stopservice')).length, writesBefore);
  identity = 'USB123';
  await adapter.clear(after);
  assert.equal(adapter.active.size, 0);
});
