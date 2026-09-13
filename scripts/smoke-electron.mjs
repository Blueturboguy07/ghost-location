import { _electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

// Exercises the real preload/IPC path and local preferences. Never invokes a
// phone's Prepare, Set, or Restore command, even if a phone is connected.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), 'ghost-smoke-'));
const env = { ...process.env, GHOST_TEST_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.GHOST_SMOKE_EXECUTABLE || electronPath;
const args = [...(process.env.GHOST_SMOKE_EXECUTABLE ? [] : [root]), `--user-data-dir=${userData}`];
const application = await _electron.launch({ executablePath, args, cwd: root, env, timeout: 30000 });
const rendererErrors = [];
async function pollState(page, predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await page.evaluate(() => window.ghost.getState());
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('The expected application state did not arrive within 30 seconds.');
}
try {
  const page = await application.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  await page.locator('#search-input').waitFor();
  const actualData = await application.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(await realpath(actualData), await realpath(userData), 'Smoke checks require an isolated settings directory.');
  const initial = await pollState(page, s => s.runtime.ios && s.runtime.android);
  assert.equal(initial.session, null);
  console.log(`Native bridge ready. USB phones found: ${initial.devices.length}.`);
  console.log(`iPhone runtime: ${initial.runtime.ios.available}; Android runtime: ${initial.runtime.android.available}.`);
  if (process.env.GHOST_SMOKE_EXECUTABLE) {
    assert.equal(initial.runtime.ios.available, true, initial.runtime.ios.message);
    assert.equal(initial.runtime.android.available, true, initial.runtime.android.message);
  }

  async function chooseSetup(host, phone, expectedText, finish = true) {
    await page.locator(`[data-survey-host="${host}"]`).click();
    await page.locator(`[data-survey-phone="${phone}"]`).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert.match(await page.locator('#onboarding-content').textContent(), expectedText);
    if (finish) {
      await page.getByRole('button', { name: 'Continue to map', exact: true }).click();
      await page.locator('#onboarding-dialog').waitFor({ state: 'hidden' });
      await pollState(page, s => s.preferences.onboardingComplete === true && s.preferences.hostPlatform === host && s.preferences.phonePlatform === phone);
    }
  }

  await page.locator('#onboarding-dialog[open]').waitFor();
  await page.locator('[data-survey-host="mac"]').click();
  await page.locator('[data-survey-phone="ios"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(output, 'ghost-onboarding.png') });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.match(await page.locator('#onboarding-content').textContent(), /Developer Mode/);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(output, 'ghost-onboarding-guide.png') });
  await page.getByRole('button', { name: 'Continue to map', exact: true }).click();
  await page.locator('#onboarding-dialog').waitFor({ state: 'hidden' });
  await pollState(page, s => s.preferences.onboardingComplete === true && s.preferences.hostPlatform === 'mac' && s.preferences.phonePlatform === 'ios');

  const setupCases = [
    ['windows', 'ios', /Apple Devices/],
    ['mac', 'android', /No Mac USB driver/],
    ['windows', 'android', /ADB USB driver/],
    ['mac', 'ios', /Developer Mode/],
  ];
  for (const [host, phone, expected] of setupCases) {
    await page.locator('#help-button').click();
    await page.locator('#change-configuration').click();
    await chooseSetup(host, phone, expected);
  }
  await page.waitForFunction(() => document.querySelector('.leaflet-tile-loaded'), null, { timeout: 15000 }).catch(() => console.log('Map tiles unavailable; continuing with coordinates.'));
  await page.screenshot({ path: path.join(output, 'ghost-desktop.png') });
  await page.locator('#latitude').fill('41.8827');
  await page.locator('#longitude').fill('-87.6233');
  await page.getByRole('button', { name: 'Select these coordinates', exact: true }).click();
  await page.locator('#save-button').click();
  await page.locator('#place-name').fill('Millennium Park');
  await page.locator('#save-form button[type=submit]').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#saved-count').textContent(), '1');
  await page.getByRole('button', { name: 'Rename Millennium Park', exact: true }).click();
  await page.locator('#place-name').fill('Chicago favorite');
  await page.locator('#save-form button[type=submit]').click();
  await page.locator('#save-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Remove Chicago favorite', exact: true }).click();
  await pollState(page, s => s.savedPlaces.length === 0);
  await page.locator('#search-input').fill('Millennium Park Chicago');
  await page.locator('#search-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.search-result,.search-error'), null, { timeout: 20000 });
  const count = await page.locator('.search-result').count();
  if (count) {
    await page.locator('.search-result').first().click();
    console.log(`Live search returned ${count} selectable results.`);
  } else console.log(`Search error displayed: ${await page.locator('.search-error').textContent()}`);
  await page.waitForTimeout(1100); // Let the map's 800 ms camera animation finish.
  if (await page.locator('#toast').isVisible()) await page.locator('#toast-close').click();
  await page.screenshot({ path: path.join(output, 'ghost-destination.png') });
  await page.locator('#help-button').click();
  assert.match(await page.locator('#setup-content').textContent(), /Developer Mode/);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(output, 'ghost-setup.png') });
  await page.getByRole('button', { name: 'Close setup guide', exact: true }).click();
  await page.locator('#settings-button').click();
  await page.locator('#restore-preference').uncheck();
  await pollState(page, s => s.preferences.restoreOnQuit === false);
  await page.locator('#restore-preference').check();
  await pollState(page, s => s.preferences.restoreOnQuit === true);
  await page.screenshot({ path: path.join(output, 'ghost-settings.png') });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.locator('[data-location-mode="route"]').click();
  for (const [latitude, longitude] of [[41.8827, -87.6233], [41.8917, -87.6078]]) {
    await page.locator('#latitude').fill(String(latitude));
    await page.locator('#longitude').fill(String(longitude));
    await page.getByRole('button', { name: 'Select these coordinates', exact: true }).click();
    await page.locator('#add-route-stop').click();
  }
  await page.locator('#plan-route').click();
  await page.locator('#route-summary').waitFor({timeout: 25000});
  const planned = await page.evaluate(() => window.ghost.getRoute());
  assert.ok(planned.coordinates.length > 2, 'A real road route should contain road geometry.');
  assert.equal(planned.speedMph, 45);
  await page.waitForTimeout(1100);
  await page.screenshot({path: path.join(output, 'ghost-route-preview.png')});
  console.log(`Live OSRM road route: ${planned.coordinates.length} points, ${Math.round(planned.distanceMeters)} metres. No route started.`);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 680));
  await page.screenshot({ path: path.join(output, 'ghost-compact.png') });
  const final = await page.evaluate(() => window.ghost.getState());
  assert.equal(final.session, null);
  assert.deepEqual(rendererErrors, []);
  console.log('PASS: native UI, coordinates, saved-place CRUD, search response, setup, preferences, compact window. No phone location commands.');
} catch (error) {
  await application.windows()[0]?.screenshot({ path: path.join(output, 'ghost-smoke-failure.png') }).catch(() => {});
  throw error;
} finally {
  await application.close();
}
