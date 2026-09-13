import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../backend/controller.mjs';
import { defaults } from '../backend/store.mjs';

const phone = { id: 'android:USB123', serial: 'USB123', name: 'Test phone', platform: 'android', connection: 'usb', state: 'ready' };
const secondPhone = { ...phone, id: 'android:SECOND', serial: 'SECOND', name: 'Second phone' };
const point = { latitude: 0, longitude: 0, label: 'Equator', deviceId: phone.id };
async function fixture(initial = {}) {
  const calls = []; let devices = [structuredClone(phone)];
  let timestamp = Date.parse('2026-09-13T12:00:00Z');
  const data = { ...defaults(), ...initial };
  const store = { data, load: async () => structuredClone(data), save: async value => { store.data = structuredClone(value); calls.push('persist'); } };
  const adapter = { status: async () => ({ available: true, message: 'Ready' }), list: async () => devices,
    prepare: async () => calls.push('prepare'), set: async () => calls.push('set'), clear: async () => calls.push('clear'),
    reset: async device => calls.push(`reset:${device.id}`), dispose: async () => {} };
  const c = new Controller({ adapters: { android: adapter }, store, now: () => timestamp }); await c.init();
  const initCalls = [...calls]; calls.length = 0;
  return { c, adapter, store, calls, initCalls, advance: ms => { timestamp += ms; }, disconnect: () => { devices = []; },
    reconnect: () => { devices = [structuredClone(phone)]; }, setDevices: value => { devices = structuredClone(value); } };
}

test('stores a valid onboarding configuration and rejects unknown platforms', async () => {
  const { c, store } = await fixture();
  const result = await c.updatePreferences({ onboardingComplete: true, hostPlatform: 'windows', phonePlatform: 'ios' });
  assert.deepEqual(result.preferences, {
    ...defaults().preferences,
    onboardingComplete: true,
    hostPlatform: 'windows',
    phonePlatform: 'ios',
  });
  assert.deepEqual(store.data.preferences, result.preferences);
  await assert.rejects(c.updatePreferences({ hostPlatform: 'linux' }), /computer platform/);
  await assert.rejects(c.updatePreferences({ phonePlatform: 'blackberry' }), /phone platform/);
  await assert.rejects(c.updatePreferences({ onboardingComplete: 'yes' }), /onboarding preference/);
});

test('journals the exact device before sending coordinates, including zero', async () => {
  const { c, calls, store } = await fixture(); const result = await c.applyLocation(point);
  assert.equal(result.busy, false);
  assert.deepEqual(calls, ['persist', 'set', 'persist']);
  assert.equal(c.state.session.status, 'active'); assert.equal(store.data.session.latitude, 0);
});
test('invalid or non-finite coordinates never reach a phone', async () => {
  const { c, calls } = await fixture();
  for (const latitude of [NaN, Infinity, 91, -91, '40', null]) await assert.rejects(c.applyLocation({ ...point, latitude }));
  assert.deepEqual(calls, []);
});
test('unknown, unauthorized and network devices cannot be targeted', async () => {
  const { c, calls } = await fixture();
  await assert.rejects(c.applyLocation({ ...point, deviceId: 'android:other' }));
  c.state.devices[0].connection = 'wifi'; await assert.rejects(c.applyLocation(point));
  c.state.devices[0].connection = 'usb'; c.state.devices[0].state = 'unauthorized'; await assert.rejects(c.applyLocation(point));
  assert.deepEqual(calls, []);
});
test('failed set is unresolved but can retry on the same phone without Restore', async () => {
  const { c, adapter, store } = await fixture(); adapter.set = async () => { throw new Error('USB lost'); };
  await assert.rejects(c.applyLocation(point), /USB lost/);
  assert.equal(c.state.session.status, 'unknown'); assert.equal(store.data.session.status, 'unknown');
  adapter.set = async () => ({ ok: true });
  await c.applyLocation({ ...point, latitude: 25 });
  assert.equal(c.state.session.status, 'active'); assert.equal(c.state.session.latitude, 25);
});
test('a different ready USB phone removes a stale prior-phone journal during startup', async () => {
  const stale = { id: 'stale-session', deviceId: 'android:OLD', serial: 'OLD', deviceName: 'Old phone',
    platform: 'android', latitude: 1, longitude: 2, label: 'Old target', status: 'active', autoReconnect: true };
  const { c, store, initCalls } = await fixture({ session: stale });
  assert.equal(c.state.session, null);
  assert.equal(store.data.session, null);
  assert.ok(initCalls.includes('reset:android:OLD'), 'the stale adapter transport should be discarded with the journal');
  assert.ok(!initCalls.includes('clear'), 'the newly connected phone must never receive a restore command for the old phone');
});
test('a different USB phone that needs setup also removes a stale prior-phone journal', async () => {
  const { c, store, setDevices } = await fixture();
  await c.applyLocation(point);
  c.state.session.status = 'unknown';
  await c.persist();
  setDevices([{ ...secondPhone, state: 'setup-required' }]);
  await c.scanDevices();
  assert.equal(c.state.session, null);
  assert.equal(store.data.session, null);
  await c.prepareDevice(secondPhone.id);
});
test('failed persistence keeps the old recovery record and retry state', async () => {
  const { c, calls, store, setDevices } = await fixture();
  await c.applyLocation(point);
  const sessionId = c.state.session.id;
  c.state.session.status = 'waiting';
  c.resumeSessionId = sessionId;
  c.retryAt = 1234;
  c.retryAttempts = 3;
  await c.persist();
  calls.length = 0;
  store.save = async value => {
    if (value.session === null) throw new Error('Disk full');
    store.data = structuredClone(value);
  };
  setDevices([secondPhone]);
  await c.scanDevices();
  assert.equal(c.state.session.id, sessionId);
  assert.equal(c.resumeSessionId, sessionId);
  assert.equal(c.retryAt, 1234);
  assert.equal(c.retryAttempts, 3);
  assert.match(c.state.warning, /Could not clear the previous phone record: Disk full/);
  assert.ok(!calls.some(call => call.startsWith('reset:')));
});
test('a malformed stale identity can be discarded without aborting discovery', async () => {
  const stale = { id: 'malformed', platform: 'android', latitude: 1, longitude: 2,
    label: 'Old target', status: 'active', autoReconnect: true };
  const { c, store, initCalls } = await fixture({ session: stale });
  assert.equal(c.state.session, null);
  assert.equal(store.data.session, null);
  assert.ok(!initCalls.some(call => call.startsWith('reset:')));
});
test('a different ready USB phone retires every unresolved status and cancels recovery', async t => {
  for (const status of ['unknown', 'waiting', 'error']) {
    await t.test(status, async () => {
      const { c, calls, store, setDevices, advance } = await fixture();
      await c.applyLocation(point);
      const staleId = c.state.session.id;
      c.state.session.status = status;
      c.state.session.autoReconnect = true;
      c.resumeSessionId = staleId;
      c.retryAt = 1;
      c.retryAttempts = 3;
      await c.persist(); calls.length = 0;

      setDevices([secondPhone]);
      await c.scanDevices();

      assert.equal(c.state.session, null);
      assert.equal(store.data.session, null);
      assert.equal(c.canResume(), false);
      assert.equal(c.retryAt, 0);
      assert.equal(c.retryAttempts, 0);
      assert.deepEqual(calls.filter(call => call.startsWith('reset:')), [`reset:${phone.id}`]);
      assert.ok(!calls.includes('clear'), 'discarding an absent phone record must not clear the replacement phone');

      calls.length = 0;
      setDevices([phone]);
      advance(30_000);
      await c.scanDevices();
      assert.ok(!calls.includes('set'), 'the retired session must not resume when its old phone later returns');
    });
  }
});
test('a same-phone discovery retains an unresolved recovery journal', async () => {
  const stale = { ...point, id: 'same-phone-session', serial: phone.serial, deviceName: phone.name,
    platform: phone.platform, status: 'waiting', autoReconnect: true };
  const { c, store, initCalls } = await fixture({ session: stale });
  assert.equal(c.state.session.id, stale.id);
  assert.equal(c.state.session.deviceId, phone.id);
  assert.equal(c.state.session.status, 'unknown');
  assert.equal(store.data.session.id, stale.id);
  assert.ok(!initCalls.some(call => call.startsWith('reset:')));
});
test('a different phone cannot erase a live or in-flight session', async t => {
  for (const status of ['active', 'applying', 'reconnecting', 'stopping']) {
    await t.test(status, async () => {
      const { c, calls, store, setDevices } = await fixture();
      await c.applyLocation(point);
      const sessionId = c.state.session.id;
      c.state.session.status = status;
      await c.persist(); calls.length = 0;

      setDevices([secondPhone]);
      await c.scanDevices();

      assert.equal(c.state.session.id, sessionId);
      assert.equal(c.state.session.status, status);
      assert.equal(store.data.session.id, sessionId);
      assert.ok(!calls.some(call => call.startsWith('reset:')));
      assert.ok(!calls.includes('clear'));
    });
  }
});
test('USB disappearance persists uncertainty and blocks starting a different phone', async () => {
  const { c, disconnect, store, advance } = await fixture(); await c.applyLocation(point); disconnect();
  await c.scanDevices(); assert.equal(c.state.session.status, 'active');
  advance(7000); await c.scanDevices();
  assert.equal(store.data.session.status, 'waiting');
  c.state.devices = [{ ...phone, id: 'android:SECOND', serial: 'SECOND' }];
  await assert.rejects(c.applyLocation({ ...point, deviceId: 'android:SECOND' }), /Restore the previous/);
});
test('disconnected restore cannot falsely clear the journal; reconnect then clears', async () => {
  const { c, disconnect, reconnect, calls, store } = await fixture();
  await c.applyLocation(point); disconnect(); await c.scanDevices(); await c.scanDevices();
  await assert.rejects(c.stopLocation(), /no longer connected/); assert.ok(store.data.session);
  reconnect(); await c.scanDevices(); await c.stopLocation();
  assert.equal(store.data.session, null); assert.ok(calls.includes('clear'));
});
test('clear failure retains recovery state', async () => {
  const { c, adapter, store } = await fixture(); await c.applyLocation(point);
  adapter.clear = async () => { throw new Error('transport failed'); };
  await assert.rejects(c.stopLocation(), /transport failed/); assert.equal(store.data.session.status, 'unknown');
});
test('failed journal removal after restore retains a recoverable session in memory', async () => {
  const { c, store, calls } = await fixture(); await c.applyLocation(point);
  const save = store.save;
  store.save = async value => { if (value.session === null) throw new Error('Disk full'); return save(value); };
  await assert.rejects(c.stopLocation(), /Disk full/);
  assert.ok(calls.includes('clear'));
  assert.equal(c.state.session.status, 'unknown');
  assert.equal(store.data.session.status, 'unknown');
  store.save = save;
  await c.stopLocation();
  assert.equal(c.state.session, null);
});
test('relaunch never assumes the prior active session is still active', async () => {
  const { c, store } = await fixture({ session: { ...point, platform: 'android', status: 'active' } });
  assert.equal(c.state.session.status, 'unknown'); assert.equal(store.data.session.status, 'unknown');
});
test('concurrent apply and stop do not race transport commands', async () => {
  const { c, adapter, calls } = await fixture(); let finish;
  adapter.set = () => new Promise(resolve => { finish = resolve; });
  const applying = c.applyLocation(point);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(c.stopLocation(), /current device operation/);
  await assert.rejects(c.prepareDevice(phone.id), /current device operation/);
  finish(); await applying; assert.ok(!calls.includes('clear'));
});
test('unexpected backend exit wins over a late set acknowledgement', async () => {
  const { c, adapter } = await fixture();
  adapter.set = async () => { await c.sessionEnded({ deviceId: phone.id, error: 'Sidecar crashed' }); };
  await assert.rejects(c.applyLocation(point), /Sidecar crashed/); assert.equal(c.state.session.status, 'unknown');
});
test('disk failure before command prevents phone mutation', async () => {
  const { c, store, calls } = await fixture(); store.save = async () => { throw new Error('Disk full'); };
  await assert.rejects(c.applyLocation(point), /Disk full/); assert.ok(!calls.includes('set'));
  assert.equal(c.state.session, null);
});
test('USB replug automatically resumes the exact same live phone and selected point', async () => {
  const { c, adapter, calls, disconnect, reconnect } = await fixture();
  const sets = []; adapter.set = async (device, target) => { sets.push({ device, target }); };
  adapter.reset = async () => calls.push('reset');
  await c.applyLocation({ ...point, latitude: 25.6, longitude: 85.9 });
  const oldId = c.state.session.id;
  disconnect(); await c.scanDevices(); await c.scanDevices(); assert.equal(c.state.session.status, 'waiting');
  reconnect(); await c.scanDevices();
  assert.equal(c.state.session.status, 'active'); assert.equal(c.state.busy, false);
  assert.equal(sets.length, 2); assert.equal(sets[1].device.id, phone.id);
  assert.equal(sets[1].target.latitude, 25.6); assert.equal(sets[1].target.longitude, 85.9);
  assert.equal(sets[1].target.reconnecting, true); assert.notEqual(c.state.session.id, oldId);
  assert.deepEqual(calls.filter(x => x === 'reset'), ['reset']);
});
test('relaunch never automatically reapplies even a persisted autoReconnect flag', async () => {
  const { c, calls } = await fixture({ session: { ...point, id: 'old-process', platform: 'android', status: 'active', autoReconnect: true } });
  await c.scanDevices();
  assert.equal(c.state.session.status, 'unknown'); assert.equal(c.state.session.autoReconnect, false);
  assert.ok(!calls.includes('set'));
  await c.applyLocation(point); assert.equal(c.state.session.status, 'active');
});
test('offline Restore cancels automatic reconnect without claiming the phone was restored', async () => {
  const { c, calls, disconnect, reconnect } = await fixture(); await c.applyLocation(point);
  disconnect(); await c.scanDevices(); await c.scanDevices();
  await assert.rejects(c.stopLocation(), /no longer connected/);
  assert.equal(c.state.session.autoReconnect, false); assert.equal(c.state.session.status, 'unknown');
  calls.length = 0; reconnect(); await c.scanDevices();
  assert.ok(!calls.includes('set')); assert.ok(c.state.session);
  await c.stopLocation(); assert.equal(c.state.session, null);
});
test('failed recovery backs off instead of sending another set on every poll', async () => {
  const { c, adapter, advance, disconnect, reconnect } = await fixture(); await c.applyLocation(point);
  disconnect(); await c.scanDevices(); advance(7000); await c.scanDevices(); reconnect();
  let attempts = 0; adapter.set = async () => { attempts++; throw new Error('Tunnel not ready'); };
  await c.scanDevices(); assert.equal(attempts, 1); assert.equal(c.state.session.status, 'waiting');
  await c.scanDevices(); assert.equal(attempts, 1);
  advance(2000); await c.scanDevices(); assert.equal(attempts, 2);
  advance(2000); await c.scanDevices(); assert.equal(attempts, 2);
  adapter.set = async () => { attempts++; return { ok: true }; };
  advance(2000); await c.scanDevices(); assert.equal(attempts, 3); assert.equal(c.state.session.status, 'active');
});
test('a failed live location change recovers the new target rather than the old one', async () => {
  const { c, adapter, advance } = await fixture(); await c.applyLocation(point);
  adapter.set = async () => { throw new Error('Temporary USB loss'); };
  await assert.rejects(c.applyLocation({ ...point, latitude: 43 }), /Temporary USB loss/);
  let target; adapter.set = async (_device, value) => { target = value; };
  advance(2000); await c.scanDevices();
  assert.equal(target.latitude, 43); assert.equal(c.state.session.status, 'active');
});
test('late confirmations and loss events from old location intents cannot change the current one', async () => {
  const { c } = await fixture(); await c.applyLocation(point);
  const oldId = c.state.session.id;
  await c.applyLocation({ ...point, latitude: 1 });
  const currentId = c.state.session.id;
  c.locationRefreshed({ deviceId: phone.id, sessionId: oldId, ...point, refreshedAt: '2026-09-13T12:00:10Z', refreshCount: 90 });
  await c.sessionEnded({ deviceId: phone.id, sessionId: oldId, error: 'old transport closed' });
  assert.equal(c.state.session.status, 'active'); assert.equal(c.state.session.id, currentId);
  assert.equal(c.state.session.latitude, 1); assert.equal(c.state.session.refreshCount, 1);
});
test('Android rounded readback updates the live confirmation without writing every heartbeat to disk', async () => {
  const { c, calls } = await fixture(); await c.applyLocation({ ...point, latitude: 37.774912345 });
  calls.length = 0;
  c.locationRefreshed({ deviceId: phone.id, sessionId: c.state.session.id, latitude: 37.7749123, longitude: 0, source: 'helper-readback', refreshedAt: '2026-09-13T12:00:10Z' });
  assert.equal(c.state.session.lastRefreshAt, '2026-09-13T12:00:10Z'); assert.equal(c.state.session.refreshCount, 2);
  assert.deepEqual(calls, []);
});
test('one flaky discovery result cannot gray a healthy active session', async () => {
  const { c, disconnect, reconnect } = await fixture(); await c.applyLocation(point);
  disconnect(); await c.scanDevices();
  assert.equal(c.state.session.status, 'active'); assert.equal(c.state.session.autoReconnect, true);
  assert.equal(c.state.devices[0].id, phone.id);
  reconnect(); await c.scanDevices(); assert.equal(c.state.session.status, 'active');
});
test('recent iPhone refresh acknowledgements outweigh temporary discovery misses', async () => {
  const iosPhone = { ...phone, id: 'ios:PHONE123456', serial: 'PHONE123456', platform: 'ios' };
  let devices = [iosPhone], timestamp = Date.parse('2026-09-13T12:00:00Z');
  const data = defaults();
  const store = { load: async () => structuredClone(data), save: async value => Object.assign(data, structuredClone(value)) };
  const adapter = { status: async () => ({ available: true }), list: async () => devices, set: async () => ({}), clear: async () => {}, dispose: async () => {} };
  const c = new Controller({ adapters: { ios: adapter }, store, now: () => timestamp }); await c.init();
  await c.applyLocation({ ...point, deviceId: iosPhone.id });
  const id = c.state.session.id;
  devices = [];
  timestamp += 1900;
  c.locationRefreshed({ deviceId: iosPhone.id, sessionId: id, latitude: 0, longitude: 0, refreshedAt: new Date(timestamp).toISOString(), refreshCount: 2 });
  await c.scanDevices(); await c.scanDevices(); await c.scanDevices();
  assert.equal(c.state.session.status, 'active');
  assert.equal(c.state.devices[0].id, iosPhone.id);
  timestamp += 7000;
  await c.scanDevices();
  assert.equal(c.state.session.status, 'waiting');
});
test('sleep pauses recovery and wake reconnects the same live phone', async () => {
  const { c, calls } = await fixture(); await c.applyLocation(point); calls.length = 0;
  await c.suspend(); await c.scanDevices(); assert.ok(!calls.includes('set'));
  await c.resume(); assert.ok(calls.includes('set')); assert.equal(c.state.session.status, 'active');
});
test('Restore during a pending reconnect queues cleanup and cannot be undone by its late acknowledgement', async () => {
  const { c, adapter, calls } = await fixture(); await c.applyLocation(point);
  await c.sessionEnded({ deviceId: phone.id, sessionId: c.state.session.id, error: 'USB dropped' });
  let finish;
  adapter.set = () => new Promise(resolve => { finish = resolve; });
  const reconnecting = c.scanDevices();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state.session.status, 'reconnecting');
  const stopping = c.stopLocation();
  finish({ ok: true });
  await Promise.all([reconnecting, stopping]);
  assert.equal(c.state.session, null); assert.equal(c.state.busy, false);
  assert.ok(calls.includes('clear'));
});
test('closing during a pending reconnect never resurrects an active session', async () => {
  const { c, adapter } = await fixture(); await c.applyLocation(point);
  await c.sessionEnded({ deviceId: phone.id, sessionId: c.state.session.id, error: 'USB dropped' });
  let finish;
  adapter.set = () => new Promise(resolve => { finish = resolve; });
  const reconnecting = c.scanDevices(); await new Promise(resolve => setImmediate(resolve));
  await c.dispose({ restore: false }); finish({ ok: true }); await reconnecting;
  assert.equal(c.state.session.status, 'unknown'); assert.equal(c.state.session.autoReconnect, false);
});
test('saved places round-trip rename, delete and bounds', async () => {
  const { c, store } = await fixture(); await c.savePlace(point); const id = c.state.savedPlaces[0].id;
  await c.savePlace({ ...point, id, label: 'My spot' }); assert.equal(store.data.savedPlaces.length, 1);
  assert.equal(store.data.savedPlaces[0].label, 'My spot');
  await c.deletePlace(id); assert.equal(store.data.savedPlaces.length, 0);
  await assert.rejects(c.savePlace({ ...point, longitude: 181 }));
});
