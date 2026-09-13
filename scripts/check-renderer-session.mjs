import { _electron } from 'playwright';
import electronPath from 'electron';
import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/renderer-session-main.cjs');
const dist = path.join(root, 'dist');
await access(path.join(dist, 'index.html')).catch(() => {
  throw new Error('Build the renderer first, or run npm run test:renderer-session.');
});

const userData = await mkdtemp(path.join(tmpdir(), 'ghost-renderer-session-'));
const env = { ...process.env, GHOST_RENDERER_TEST_DATA: userData, GHOST_RENDERER_DIST: dist };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const deadline = setTimeout(() => {
  console.error('FAIL: isolated renderer session check exceeded 45 seconds.');
  application?.process().kill('SIGKILL');
  process.exit(1);
}, 45_000);

try {
  application = await _electron.launch({ executablePath: electronPath, args: [fixture], cwd: root, env, timeout: 15_000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(5000);
  const rendererErrors = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#apply-button')?.textContent.includes('Update location'));

  const actualData = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(await realpath(actualData), await realpath(userData), 'The test must use isolated settings.');
  assert.equal(await application.evaluate(() => globalThis.ghostRendererFixture?.mode), 'no-phone-no-network');

  const initial = await page.evaluate(() => window.ghost.getState());
  const phone = initial.devices[0];
  const target = { latitude: 35.6762, longitude: 139.6503 };
  await page.locator('#latitude').fill(String(target.latitude));
  await page.locator('#longitude').fill(String(target.longitude));
  await page.getByRole('button', { name: 'Select these coordinates', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.ghostFixture.getCalls()), [], 'Choosing a pin must not apply it.');

  // Keep the select focused while real-time events pass the original five-second
  // failure boundary. Node identity catches menus being rebuilt on each event.
  await page.locator('#device-select').focus();
  const originalNodes = await page.evaluateHandle(() => ({
    select: document.querySelector('#device-select'),
    icon: document.querySelector('.rail-emblem svg'),
  }));
  const primaryColors = new Set();
  const started = performance.now();
  for (let heartbeat = 1; heartbeat <= 10; heartbeat += 1) {
    await delay(900);
    await page.evaluate(async count => {
      const current = await window.ghost.getState();
      await window.ghostFixture.setState({
        busy: false,
        session: { ...current.session, status: 'active', refreshCount: count, lastRefreshAt: new Date().toISOString() },
      });
    }, heartbeat);

    assert.equal(await page.locator('#apply-button').isEnabled(), true, `Update disabled at heartbeat ${heartbeat}.`);
    assert.match(await page.locator('#apply-button').textContent(), /Update location/);
    assert.equal(await page.locator('#device-select').inputValue(), phone.id, 'The selected phone changed.');
    assert.equal(await page.locator('#latitude').inputValue(), target.latitude.toFixed(6), 'The pending latitude changed.');
    assert.equal(await page.locator('#longitude').inputValue(), target.longitude.toFixed(6), 'The pending longitude changed.');
    assert.equal(await page.evaluate(nodes => (
      nodes.select === document.querySelector('#device-select') &&
      document.activeElement === nodes.select &&
      nodes.icon === document.querySelector('.rail-emblem svg')
    ), originalNodes), true, 'A heartbeat replaced a focused select or existing icon.');
    primaryColors.add(await page.locator('#apply-button').evaluate(button => getComputedStyle(button).backgroundColor));
  }
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(elapsedMs >= 8000, 'The check must span more than eight seconds.');
  assert.equal(primaryColors.size, 1, 'The active Update button changed color across heartbeats.');
  assert.deepEqual(await page.evaluate(() => window.ghostFixture.getCalls()), [], 'A heartbeat applied the preview target.');
  await originalNodes.dispose();

  // Settings drafts must survive the same event stream without losing focus.
  await page.locator('#settings-button').click();
  await page.locator('#provider-url').fill('https://example.invalid/unfinished-draft');
  await page.evaluate(async () => {
    const current = await window.ghost.getState();
    await window.ghostFixture.setState({ session: { ...current.session, refreshCount: 11 } });
  });
  assert.equal(await page.locator('#provider-url').inputValue(), 'https://example.invalid/unfinished-draft');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'provider-url');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();

  await page.evaluate(async () => {
    const current = await window.ghost.getState();
    await window.ghostFixture.setState({ devices: [], session: { ...current.session, status: 'waiting', autoReconnect: true } });
  });
  assert.match(await page.locator('#session-status').textContent(), /Waiting for your phone/);
  assert.equal(await page.locator('#apply-button').isDisabled(), true);
  assert.equal(await page.locator('#restore-button').isEnabled(), true, 'Offline Restore must remain available.');

  await page.evaluate(async device => {
    const current = await window.ghost.getState();
    await window.ghostFixture.setState({ devices: [device], busy: true, session: { ...current.session, status: 'reconnecting' } });
  }, phone);
  assert.match(await page.locator('#session-status').textContent(), /Reconnecting to your phone/);
  assert.equal(await page.locator('#apply-button').isDisabled(), true);
  assert.equal(await page.locator('#restore-button').isEnabled(), true, 'Restore must be available during automatic recovery.');

  await page.evaluate(async () => {
    const current = await window.ghost.getState();
    await window.ghostFixture.setState({ busy: false, session: { ...current.session, status: 'active' } });
  });
  assert.equal(await page.locator('#apply-button').isEnabled(), true, 'Recovery left Update disabled.');
  assert.equal(await page.locator('#device-select').inputValue(), phone.id);
  assert.equal(await page.locator('#latitude').inputValue(), target.latitude.toFixed(6));
  assert.equal(await page.locator('#longitude').inputValue(), target.longitude.toFixed(6));
  assert.deepEqual(await page.evaluate(() => window.ghostFixture.getCalls()), [], 'Recovery applied the uncommitted preview pin.');

  await page.getByRole('button', { name: 'Update location', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#apply-button').disabled);
  assert.deepEqual(await page.evaluate(() => window.ghostFixture.getCalls()), [{
    method: 'applyLocation', deviceId: phone.id, ...target, label: 'Custom coordinates',
  }], 'Explicit Update must send exactly the selected target to the same phone.');
  assert.match(await page.locator('#session-refresh').textContent(), /Last command acknowledged.*Updates acknowledged/);
  assert.match(await page.locator('#session-refresh').textContent(), /phone-app location is not verified/);

  await page.locator('[data-location-mode="route"]').click();
  for (const [latitude, longitude] of [[41.8827, -87.6233], [41.89, -87.63]]) {
    await page.locator('#latitude').fill(String(latitude));
    await page.locator('#longitude').fill(String(longitude));
    await page.getByRole('button', { name: 'Select these coordinates', exact: true }).click();
    await page.locator('#add-route-stop').click();
  }
  assert.equal(await page.locator('#route-stops li').count(), 2);
  await page.locator('#plan-route').click();
  await page.waitForFunction(() => !document.querySelector('#route-play').disabled);
  assert.equal((await page.evaluate(() => window.ghostFixture.getCalls())).filter(c => c.method === 'applyLocation').length, 1, 'Planning a route cannot send a location.');
  assert.equal(await page.locator('.route-stop-marker').count(), 2);
  await page.locator('#route-play').click();
  await page.waitForFunction(() => document.querySelector('#route-play').textContent === 'Pause route');
  assert.equal(await page.locator('.route-location-dot').count(), 1);
  const beforeDot = await page.locator('.route-location-dot').getAttribute('d');
  await page.evaluate(async () => {
    const current = await window.ghost.getState();
    await window.ghostFixture.setState({route: {...current.route, traveledMeters: 600, remainingSeconds: 40, point: {latitude: 41.889, longitude: -87.6233}}});
  });
  assert.notEqual(await page.locator('.route-location-dot').getAttribute('d'), beforeDot, 'The route dot must follow backend positions.');
  await page.locator('#route-play').click();
  await page.waitForFunction(() => document.querySelector('#route-play').textContent.includes('Resume route'));
  await page.locator('#route-play').click();
  await page.waitForFunction(() => document.querySelector('#route-play').textContent === 'Pause route');
  const routeCalls = (await page.evaluate(() => window.ghostFixture.getCalls())).filter(c => c.method !== 'applyLocation');
  assert.deepEqual(routeCalls.map(c => c.method), ['planRoute', 'startRoute', 'pauseRoute', 'resumeRoute']);
  assert.equal(routeCalls[1].deviceId, phone.id);
  assert.equal(routeCalls[1].routeId, 'test-route');
  const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, {recursive: true});
  await page.waitForTimeout(1000);
  await page.screenshot({path: path.join(artifacts, 'ghost-route-playback.png')});
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 680));
  await page.locator('#route-play').scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(artifacts, 'ghost-route-compact.png')});
  console.log('PASS: route stop selection, planning without device mutation, start/pause/resume, moving dot, and compact controls.');
  assert.deepEqual(rendererErrors, [], 'The renderer raised an error.');
  const blockedRequests = await application.evaluate(() => globalThis.ghostRendererFixture.blockedRequests);
  assert.ok(blockedRequests > 0, 'The fixture did not demonstrate that external map requests were blocked.');

  console.log(`PASS: 10 heartbeats over ${elapsedMs} ms; active Update color/control, device, pending pin and focus preserved; waiting → reconnecting → active; only explicit Update applied the new target.`);
  console.log(`Isolation: no device adapters loaded; ${blockedRequests} external requests blocked; temporary settings only.`);
} finally {
  if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
  clearTimeout(deadline);
  await rm(userData, { recursive: true, force: true, maxRetries: 3 });
}
