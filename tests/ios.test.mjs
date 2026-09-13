import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { IosAdapter } from '../backend/ios.mjs';

const device = { id: 'ios:00008030-0000000000000001', serial: '00008030-0000000000000001', platform: 'ios', connection: 'usb' };
function harness(onSessionEnd = () => {}, onLocationRefresh = () => {}, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { requests.push(JSON.parse(chunk)); done(); } });
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
  const adapter = new IosAdapter({ runner: () => child, onSessionEnd, onLocationRefresh, ...options });
  const reply = (request, result, error) => child.stdout.write(`${JSON.stringify({ id: request.id, ok: !error, result, error })}\n`);
  return { child, requests, adapter, reply };
}

test('set waits for a matching successful acknowledgement', async () => {
  const h = harness(); let finished = false;
  const action = h.adapter.set(device, { latitude: 0, longitude: -0.1 }).then(() => { finished = true; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  h.reply({ id: 900 }, { applied: true });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.equal(h.requests[0].params.udid, device.serial);
  h.reply(h.requests[0], { applied: true });
  await action;
  assert.equal(h.adapter.activeDeviceId, device.id);
  h.child.kill();
});

test('set propagates upstream error without marking active', async () => {
  const h = harness();
  const action = h.adapter.set(device, { latitude: 10, longitude: 20 });
  await new Promise(setImmediate);
  h.reply(h.requests[0], undefined, 'Developer Mode is off');
  await assert.rejects(action, /Developer Mode/);
  assert.equal(h.adapter.activeDeviceId, null);
  h.child.kill();
});

test('USB filtering and explicit device validation are enforced', async () => {
  const h = harness();
  await assert.rejects(h.adapter.set({ ...device, connection: 'network' }, { latitude: 1, longitude: 2 }), /USB/);
  await assert.rejects(h.adapter.set(device, { latitude: NaN, longitude: 2 }), /invalid/);
  assert.equal(h.requests.length, 0);
  const listing = h.adapter.list();
  await new Promise(setImmediate);
  h.reply(h.requests[0], [device, { ...device, connection: 'network' }, { platform: 'android', connection: 'usb' }]);
  assert.deepEqual(await listing, [device]);
  h.child.kill();
});

test('unexpected sidecar exit rejects requests and reports active location unknown', async () => {
  const events = []; const h = harness((event) => events.push(event));
  const action = h.adapter.set(device, { latitude: 1, longitude: 2 });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await action;
  const listing = h.adapter.request('discover');
  await new Promise(setImmediate);
  h.child.emit('exit', 1, null);
  await assert.rejects(listing, /exited/);
  assert.equal(events[0].deviceId, device.id);
  assert.match(events[0].error, /unknown/);
});

test('normal disposal waits for restore acknowledgement and does not report unexpected loss', async () => {
  const events = []; const h = harness((event) => events.push(event));
  const action = h.adapter.set(device, { latitude: 1, longitude: 2 });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await action;
  let finished = false;
  const disposal = h.adapter.dispose().then(() => { finished = true; });
  await new Promise(setImmediate);
  assert.equal(h.requests[1].method, 'shutdown');
  await new Promise(setImmediate); assert.equal(finished, false);
  h.reply(h.requests[1], { stopped: true });
  await disposal;
  await new Promise(setImmediate);
  assert.equal(events.length, 0);
});

test('USB session-ended event reports state loss without requiring process exit', async () => {
  const events = []; const h = harness((event) => events.push(event));
  const action = h.adapter.set(device, { latitude: 1, longitude: 2 });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await action;
  h.child.stdout.write(`${JSON.stringify({ event: 'session-ended', deviceId: device.id, error: 'USB disconnected' })}\n`);
  await new Promise(setImmediate);
  assert.equal(h.adapter.activeDeviceId, null);
  assert.deepEqual(events, [{ deviceId: device.id, error: 'USB disconnected' }]);
  h.child.kill();
});

test('queued polling waits behind preparation without sending a second request', async () => {
  const h = harness();
  const preparing = h.adapter.prepare(device);
  const listing = h.adapter.list();
  await new Promise(setImmediate);
  assert.deepEqual(h.requests.map((item) => item.method), ['prepare']);
  h.reply(h.requests[0], { ready: true }); await preparing;
  await new Promise(setImmediate);
  assert.deepEqual(h.requests.map((item) => item.method), ['prepare', 'discover']);
  h.reply(h.requests[1], [device]); await listing;
  h.child.kill();
});

test('generic protocol success is insufficient for a location acknowledgement', async () => {
  const h = harness();
  const action = h.adapter.set(device, { latitude: 1, longitude: 2 });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { ready: true });
  await assert.rejects(action, /did not acknowledge/);
  assert.equal(h.adapter.activeDeviceId, null);
  h.child.kill();
});

test('disposal can close transport without requesting a location restore', async () => {
  const h = harness();
  const action = h.adapter.set(device, { latitude: 1, longitude: 2 });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await action;
  const disposal = h.adapter.dispose({ restore: false });
  await new Promise(setImmediate);
  assert.equal(h.requests[1].method, 'shutdown');
  assert.deepEqual(h.requests[1].params, { restore: false });
  h.reply(h.requests[1], { stopped: true });
  await disposal;
});

function refreshEvent(request, extra = {}) {
  return { event: 'location-refreshed', deviceId: device.id, sessionId: request.params.sessionId,
    generation: request.params.generation, latitude: request.params.latitude, longitude: request.params.longitude,
    refreshedAt: new Date().toISOString(), refreshCount: 2, refreshIntervalMs: 1000, ...extra };
}
function event(h, value) { h.child.stdout.write(`${JSON.stringify(value)}\n`); }

test('refresh callback requires matching acknowledged intent and increasing reply count', async () => {
  const events = []; const h = harness(undefined, (value) => events.push(value));
  const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'session-one' });
  await new Promise(setImmediate);
  const message = refreshEvent(h.requests[0]);
  event(h, message);
  assert.equal(events.length, 0);
  h.reply(h.requests[0], { applied: true, refreshCount: 1 }); await setting;
  event(h, { ...message, generation: 900 });
  event(h, { ...message, sessionId: 'older' });
  event(h, { ...message, longitude: 3 });
  event(h, { ...message, refreshedAt: 'invalid' });
  assert.equal(events.length, 0);
  event(h, message);
  event(h, message); // Duplicate acknowledgement cannot increase the displayed count.
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { deviceId: device.id, sessionId: 'session-one', latitude: 1, longitude: 2,
    refreshedAt: message.refreshedAt, refreshCount: 2, refreshIntervalMs: 1000, source: 'command-ack' });
  h.child.kill();
});

test('update invalidates old coordinate and loss events immediately, including repeated sessionIds', async () => {
  const refreshes = [], losses = [];
  const h = harness((value) => losses.push(value), (value) => refreshes.push(value));
  const first = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'same-session' });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await first;
  const old = refreshEvent(h.requests[0]);
  const next = h.adapter.set(device, { latitude: 3, longitude: 4, sessionId: 'same-session' });
  event(h, old);
  event(h, { ...old, event: 'session-ended', error: 'late old target failure' });
  assert.equal(refreshes.length, 0);
  assert.equal(losses.length, 0);
  await new Promise(setImmediate);
  h.reply(h.requests[1], { applied: true }); await next;
  event(h, old);
  event(h, refreshEvent(h.requests[1]));
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].latitude, 3);
  assert.equal(h.adapter.activeDeviceId, device.id);
  h.child.kill();
});

test('session loss before set response prevents late acknowledgement from reactivating it', async () => {
  const losses = []; const h = harness((value) => losses.push(value));
  const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'lost-session' });
  await new Promise(setImmediate);
  event(h, { ...refreshEvent(h.requests[0]), event: 'session-ended', error: 'USB lost before response' });
  h.reply(h.requests[0], { applied: true });
  await assert.rejects(setting, /USB lost/);
  assert.equal(h.adapter.activeDeviceId, null);
  assert.equal(losses[0].sessionId, 'lost-session');
  h.child.kill();
});

test('clear immediately stops accepting refreshes while awaiting clear acknowledgement', async () => {
  const refreshes = []; const h = harness(undefined, (value) => refreshes.push(value));
  const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'clearing' });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await setting;
  const clearing = h.adapter.clear(device);
  event(h, refreshEvent(h.requests[0]));
  assert.equal(refreshes.length, 0);
  await new Promise(setImmediate);
  h.reply(h.requests[1], { cleared: true }); await clearing;
  event(h, refreshEvent(h.requests[0], { refreshCount: 3 }));
  assert.equal(refreshes.length, 0);
  h.child.kill();
});

test('reset is USB-targeted transport-only and rejects late events before a new set', async () => {
  const losses = [], refreshes = [];
  const h = harness((value) => losses.push(value), (value) => refreshes.push(value));
  const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'before-replug' });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true }); await setting;
  const resetting = h.adapter.reset(device);
  event(h, refreshEvent(h.requests[0]));
  event(h, { ...refreshEvent(h.requests[0]), event: 'session-ended', error: 'late old connection' });
  await new Promise(setImmediate);
  assert.equal(h.requests[1].method, 'reset');
  assert.deepEqual(h.requests[1].params, { udid: device.serial });
  assert.equal(h.adapter.activeDeviceId, null);
  h.reply(h.requests[1], { reset: true }); await resetting;
  assert.equal(losses.length, 0);
  assert.equal(refreshes.length, 0);
  const settingAgain = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'after-replug', reconnecting: true });
  await new Promise(setImmediate);
  h.reply(h.requests[2], { applied: true }); await settingAgain;
  event(h, refreshEvent(h.requests[0], { refreshCount: 10 }));
  event(h, refreshEvent(h.requests[2]));
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].sessionId, 'after-replug');
  h.child.kill();
});

test('recovery uses a bounded timeout while first-time preparation retains its longer timeout', async () => {
  const h = harness(); const calls = [];
  h.adapter.request = async (method, params, timeout) => { calls.push({ method, params, timeout }); return { applied: true }; };
  await h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'initial' });
  await h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'retry', reconnecting: true });
  assert.deepEqual(calls.map((value) => value.timeout), [60000, 20000]);
  assert.deepEqual(calls.map((value) => value.params.sessionId), ['initial', 'retry']);
});

test('failed upstream reset terminates and detaches sidecar so reconnect uses a fresh process', async () => {
  const h = harness();
  const status = h.adapter.status();
  await new Promise(setImmediate);
  h.reply(h.requests[0], { available: true }); await status;
  const resetting = h.adapter.reset(device);
  await new Promise(setImmediate);
  h.reply(h.requests[1], undefined, 'transport cleanup failed; restart the sidecar');
  assert.deepEqual(await resetting, { reset: true, restarted: true });
  assert.equal(h.adapter.child, null);
});

test('timed-out process is detached before queued operations start and late old output is ignored', async () => {
  const children = [], requests = [], kills = [];
  const runner = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) { requests.push({ child, ...JSON.parse(chunk) }); done(); } });
    child.kill = () => { kills.push(child); return true; }; // Deliberately delay exit notification.
    children.push(child);
    return child;
  };
  const adapter = new IosAdapter({ runner });
  const stalled = adapter.request('status', {}, 10);
  const next = adapter.request('status', {}, 1000);
  await assert.rejects(stalled, /timed out/);
  await new Promise(setImmediate);
  assert.equal(children.length, 2);
  assert.equal(kills[0], children[0]);
  children[0].stdout.write(`${JSON.stringify({ id: requests[1].id, ok: true, result: { stale: true } })}\n`);
  children[1].stdout.write(`${JSON.stringify({ id: requests[1].id, ok: true, result: { available: true } })}\n`);
  assert.deepEqual(await next, { available: true });
  children[0].emit('exit', 0, null);
  children[1].emit('exit', 0, null);
});

test('fresh location acknowledgements supply the active USB device without discovery probes', async () => {
  let now = Date.parse('2026-09-13T12:00:00.000Z');
  const h = harness(undefined, undefined, { now: () => now });
  const selected = { ...device, name: 'Selected iPhone', osVersion: '26.0' };
  const setting = h.adapter.set(selected, { latitude: 1, longitude: 2, sessionId: 'healthy' });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true, refreshedAt: new Date(now).toISOString() }); await setting;
  now += 5000;
  const devices = await h.adapter.list();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, selected.id);
  assert.equal(devices[0].name, selected.name);
  assert.equal(devices[0].state, 'ready');
  assert.equal(h.requests.length, 1);
  devices[0].name = 'Caller mutation';
  assert.equal((await h.adapter.list())[0].name, selected.name);
  now += 1;
  const staleListing = h.adapter.list();
  await new Promise(setImmediate);
  assert.equal(h.requests[1].method, 'discover');
  h.reply(h.requests[1], []);
  assert.deepEqual(await staleListing, []);
  h.child.kill();
});

test('only matching increasing refresh acknowledgements extend cached USB presence', async () => {
  let now = Date.parse('2026-09-13T12:00:00.000Z');
  const h = harness(undefined, undefined, { now: () => now });
  const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'healthy' });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true, refreshedAt: new Date(now).toISOString() }); await setting;
  now += 4500;
  event(h, refreshEvent(h.requests[0], { refreshedAt: new Date(now).toISOString() }));
  now += 4500;
  assert.equal((await h.adapter.list())[0].id, device.id);
  assert.equal(h.requests.length, 1);
  // Wrong generation and duplicate count cannot keep an otherwise stale phone present.
  event(h, refreshEvent(h.requests[0], { generation: 900, refreshCount: 3, refreshedAt: new Date(now).toISOString() }));
  event(h, refreshEvent(h.requests[0], { refreshedAt: new Date(now).toISOString() }));
  now += 501;
  const staleListing = h.adapter.list();
  await new Promise(setImmediate);
  assert.equal(h.requests[1].method, 'discover');
  h.reply(h.requests[1], []); await staleListing;
  h.child.kill();
});

test('delayed and future-dated refresh messages cannot prolong cached presence beyond five seconds', async () => {
  let now = Date.parse('2026-09-13T12:00:00.000Z');
  const h = harness(undefined, undefined, { now: () => now });
  const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'healthy' });
  await new Promise(setImmediate);
  h.reply(h.requests[0], { applied: true, refreshedAt: new Date(now).toISOString() }); await setting;
  now += 8000;
  event(h, refreshEvent(h.requests[0], { refreshedAt: new Date(now - 7000).toISOString() }));
  const delayedListing = h.adapter.list();
  await new Promise(setImmediate);
  assert.equal(h.requests[1].method, 'discover');
  h.reply(h.requests[1], []); await delayedListing;
  event(h, refreshEvent(h.requests[0], { refreshCount: 3, refreshedAt: new Date(now + 3600000).toISOString() }));
  now += 5001;
  const futureListing = h.adapter.list();
  await new Promise(setImmediate);
  assert.equal(h.requests[2].method, 'discover');
  h.reply(h.requests[2], []); await futureListing;
  h.child.kill();
});

test('clear, reset, session loss and disposal invalidate cached device presence immediately', async () => {
  for (const operation of ['clear', 'reset', 'session-ended', 'dispose']) {
    const h = harness();
    const setting = h.adapter.set(device, { latitude: 1, longitude: 2, sessionId: 'cached' });
    await new Promise(setImmediate);
    h.reply(h.requests[0], { applied: true }); await setting;
    assert.ok(h.adapter.cachedDevice);
    let finishing;
    if (operation === 'session-ended') {
      event(h, { ...refreshEvent(h.requests[0]), event: 'session-ended', error: 'USB disconnected' });
    } else {
      finishing = operation === 'dispose' ? h.adapter.dispose({ restore: false }) : h.adapter[operation](device);
    }
    assert.equal(h.adapter.cachedDevice, null, operation);
    assert.equal(h.adapter.lastAcknowledgementAt, null, operation);
    if (finishing) {
      await new Promise(setImmediate);
      h.reply(h.requests[1], { cleared: true, reset: true, stopped: true });
      await finishing;
    }
    h.child.kill();
  }
});
