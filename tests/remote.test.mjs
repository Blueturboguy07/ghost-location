import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { RemoteServer, localAddresses } from '../backend/remote.mjs';

const assets = path.dirname(createRequire(import.meta.url).resolve('leaflet/dist/leaflet.js'));
const phone = { id: 'ios:AAAA1111', serial: 'AAAA1111', platform: 'ios', name: 'Test iPhone', connection: 'usb', state: 'ready', detail: 'USB connected.' };

function fakeController(devices = [phone]) {
  const calls = [];
  const controller = {
    calls,
    state: { busy: false, devices, session: null, route: null, preferences: { connection: 'usb' }, savedPlaces: [{ label: 'secret home' }] },
    async applyLocation(input) {
      calls.push(['apply', input]);
      controller.state.session = { id: 's1', deviceId: input.deviceId, deviceName: 'Test iPhone', status: 'active', latitude: input.latitude, longitude: input.longitude, label: input.label, message: '' };
    },
    async stopLocation() { calls.push(['stop']); controller.state.session = null; },
  };
  return controller;
}

async function start(t, controller = fakeController(), extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ghost-remote-'));
  const remote = new RemoteServer({ controller, search: async q => [{ id: 'x', label: `Result for ${q}`, latitude: 1, longitude: 2 }],
    settingsPath: path.join(dir, 'remote.json'), assets, port: 0, ...extra });
  t.after(async () => { await remote.dispose(); await rm(dir, { recursive: true, force: true }); });
  await remote.setEnabled(true);
  const base = `http://127.0.0.1:${remote.port}/${remote.token}/`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { remote, controller, base, post, dir };
}

test('is off by default and lists no links', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ghost-remote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = new RemoteServer({ controller: fakeController(), search: async () => [], settingsPath: path.join(dir, 'remote.json'), assets, port: 0 });
  const status = await remote.init();
  assert.equal(status.enabled, false);
  assert.deepEqual(status.links, []);
  assert.equal(remote.server, null);
});

test('serves the page, script and map library only with the access code', async t => {
  const { remote, base } = await start(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ghost remote/);
  for (const file of ['app.js', 'leaflet.js', 'leaflet.css']) assert.equal((await fetch(base + file)).status, 200, file);
  const origin = `http://127.0.0.1:${remote.port}`;
  for (const bad of ['/', '/aaaaaaaaaa/', '/aaaaaaaaaa/api/state', '/../package.json']) assert.equal((await fetch(origin + bad)).status, 404, bad);
  assert.equal((await fetch(base + '..%2f..%2fpackage.json')).status, 404);
});

test('sets and restores the location on the only ready phone', async t => {
  const { controller, base, post } = await start(t);
  const before = await (await fetch(base + 'api/state')).json();
  assert.equal(before.device.name, 'Test iPhone');
  assert.equal(before.session, null);
  assert.equal(JSON.stringify(before).includes('AAAA1111'), false, 'serial must not reach the phone page');
  assert.equal(JSON.stringify(before).includes('secret home'), false);
  const applied = await post('api/apply', { latitude: 48.8584, longitude: 2.2945, label: 'Eiffel Tower' });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).session.status, 'active');
  assert.deepEqual(controller.calls[0], ['apply', { deviceId: 'ios:AAAA1111', latitude: 48.8584, longitude: 2.2945, label: 'Eiffel Tower' }]);
  const stopped = await post('api/stop', {});
  assert.equal((await stopped.json()).session, null);
  assert.deepEqual(controller.calls[1], ['stop']);
});

test('rejects bad coordinates, non-JSON posts and oversized bodies', async t => {
  const { controller, base, post } = await start(t);
  assert.equal((await post('api/apply', { latitude: 123, longitude: 0 })).status, 409);
  assert.equal((await post('api/apply', { latitude: '1', longitude: 2 })).status, 409);
  assert.equal((await fetch(base + 'api/apply', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"latitude":1,"longitude":2}' })).status, 415);
  assert.equal((await post('api/apply', { latitude: 1, longitude: 2, label: 'x'.repeat(5000) })).status, 413);
  assert.equal(controller.calls.length, 0);
});

test('explains when no phone or several phones are ready', async t => {
  const none = await start(t, fakeController([]));
  const first = await none.post('api/apply', { latitude: 1, longitude: 2 });
  assert.equal(first.status, 409);
  assert.match((await first.json()).error, /No ready phone/);
  const many = await start(t, fakeController([phone, { ...phone, id: 'ios:BBBB2222', serial: 'BBBB2222' }]));
  assert.match((await (await many.post('api/apply', { latitude: 1, longitude: 2 })).json()).error, /More than one phone/);
});

test('reports controller failures to the phone', async t => {
  const controller = fakeController();
  controller.applyLocation = async () => { throw new Error('Wait for the current device operation to finish.'); };
  const { post } = await start(t, controller);
  const response = await post('api/apply', { latitude: 1, longitude: 2 });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Wait for the current/);
});

test('proxies place search', async t => {
  const { base } = await start(t);
  const data = await (await fetch(base + 'api/search?q=paris')).json();
  assert.equal(data.results[0].label, 'Result for paris');
});

test('a new link invalidates the old one and the choice persists', async t => {
  const { remote, base, dir } = await start(t);
  const old = remote.token;
  await remote.resetLink();
  assert.notEqual(remote.token, old);
  assert.equal((await fetch(base + 'api/state')).status, 404);
  const saved = JSON.parse(await readFile(path.join(dir, 'remote.json'), 'utf8'));
  assert.deepEqual(saved, { enabled: true, token: remote.token });
  await remote.setEnabled(false);
  await assert.rejects(fetch(base));
});

test('locks out after repeated wrong codes', async t => {
  let now = 1000;
  const { remote, base } = await start(t, fakeController(), { now: () => now });
  const origin = `http://127.0.0.1:${remote.port}`;
  for (let i = 0; i < 30; i++) assert.equal((await fetch(`${origin}/wrongwrong/`)).status, 404);
  assert.equal((await fetch(base + 'api/state')).status, 429);
  now += 10 * 60 * 1000 + 1;
  assert.equal((await fetch(base + 'api/state')).status, 200);
});

test('lists only usable IPv4 addresses', () => {
  const found = localAddresses(() => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    wifi: [{ family: 'IPv4', internal: false, address: '192.168.137.1' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    dead: [{ family: 'IPv4', internal: false, address: '169.254.3.4' }],
  }));
  assert.deepEqual(found, [{ name: 'wifi', address: '192.168.137.1' }]);
});
