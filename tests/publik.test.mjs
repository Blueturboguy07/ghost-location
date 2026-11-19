import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The publik module (electron/publik.mjs) runs in a child process against a fake publik that
// answers POST /api/v1/installs, GET /api/v1/wallet and POST /api/v1/telemetry, with a scripted
// gate UI (tests/fixtures/publik-gate-driver.mjs). Nothing here talks to publikhq.com.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = path.join(root, 'tests', 'fixtures', 'publik-gate-driver.mjs');
const moduleFile = path.join(root, 'electron', 'publik.mjs');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const KEY = 'pk_live_ghosttest0000_00000000000000000000000000000000';
const FAKE_APP_TOKEN = `pat_${'ghost-test-not-a-real-token'}`;

/** claimFrom: the number of the GET /wallet answer (from 1) that first says "claimed". */
function fakePublik({ claimFrom = 1 } = {}) {
  const requests = [];
  let wallets = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null, body });
      const json = (status, data) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (request.method === 'POST' && request.url === '/api/v1/installs') {
        return json(201, { key: KEY, install_id: JSON.parse(body).install_id, claim_url: `${origin}/claim/test`, claim_state: 'anonymous' });
      }
      if (request.method === 'GET' && request.url === '/api/v1/wallet') {
        wallets += 1;
        const claimed = wallets >= claimFrom;
        return json(200, { claim_state: claimed ? 'claimed' : 'anonymous', claim_url: claimed ? null : `${origin}/claim/test`, account: claimed ? { handle: 'tester' } : null,
          plan: { kind: 'none', label: null }, balance_micros: 0, top_up_url: `${origin}/wallet`, linked_at: null });
      }
      if (request.method === 'POST' && request.url === '/api/v1/telemetry') return response.writeHead(204).end();
      json(404, {});
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` })));
}

function runDriver(origin, extraEnv = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'ghost-publik-test-'));
  const env = { ...process.env, PUBLIK_ORIGIN: origin, PUBLIK_APP_TOKEN: FAKE_APP_TOKEN, PUBLIK_TELEMETRY_DEBUG: '1', HOME: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'), ...extraEnv };
  for (const name of ['DO_NOT_TRACK', 'PUBLIK_TELEMETRY', 'PUBLIK_TELEMETRY_URL', 'PUBLIK_API_KEY', 'PUBLIK_SELF_TEST', 'ELECTRON_RUN_AS_NODE']) {
    if (!(name in extraEnv)) delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      const events = stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      resolve({ code, stdout, stderr, events, screens: events.filter(e => e.screen).map(e => e.screen), result: events.find(e => e.result)?.result ?? null });
    });
  });
}

const of = (requests, method, url) => requests.filter(r => r.method === method && r.url === url);

test('the module holds what the publik scan looks for, and is the only publik client', () => {
  const code = readFileSync(moduleFile, 'utf8');
  for (const text of ['/api/v1/installs', '/api/v1/telemetry', '/api/v1/wallet', '"app_opened"', 'export const APP_SLUG = "ghost";', 'export const USES_AI = false;']) {
    assert.ok(code.includes(text), `electron/publik.mjs holds ${text}`);
  }
  assert.equal(existsSync(path.join(root, 'electron', 'publik-telemetry.cjs')), false, 'the old telemetry client is gone');
});

test('the gate runs before every first screen of Ghost', () => {
  const main = readFileSync(path.join(root, 'electron', 'main.mjs'), 'utf8');
  const boot = main.slice(main.indexOf('async function boot()'));
  const gate = boot.indexOf('await ensureSignedIn(gate)');
  assert.ok(gate > 0, 'boot() awaits ensureSignedIn');
  for (const later of ["protocol.handle('ghost'", 'new IosAdapter(', 'new AndroidAdapter(', 'new BrowserWindow(', 'controller.init()', 'controller.scanDevices()']) {
    assert.ok(boot.indexOf(later) > gate, `${later} comes after the gate`);
  }
  assert.ok(boot.indexOf('gate.close()') > gate && boot.indexOf('gate.close()') < boot.indexOf('new BrowserWindow('), 'the gate window closes before Ghost\'s window opens');
});

test('anonymous: the gate shows Sign in with publik and waits until the wallet says claimed', async () => {
  const fake = await fakePublik({ claimFrom: 3 });
  try {
    const run = await runDriver(fake.origin, { GATE_PRESS: 'sign_in' });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.screens.map(s => [s.id, s.title, s.note, s.buttons.map(b => b.label)]), [
      ['sign_in', 'Sign in with publik', null, ['Sign in with publik']],
      ['sign_in', 'Sign in with publik', 'Waiting for you to sign in in your browser.', ['Sign in with publik']]
    ]);
    assert.equal(run.screens[0].body, 'This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in.');
    assert.deepEqual(run.events.filter(e => e.openUrl).map(e => e.openUrl), [`${fake.origin}/claim/test`]);
    assert.deepEqual(run.result, { claim_state: 'claimed', choice: null, key: 'pk_' }, 'no plan screen: Ghost uses no AI');
    const installs = of(fake.requests, 'POST', '/api/v1/installs');
    assert.equal(installs.length, 1);
    const body = JSON.parse(installs[0].body);
    assert.equal(body.app_slug, 'ghost');
    assert.equal(body.app_version, version);
    assert.equal(body.app_token, FAKE_APP_TOKEN);
    assert.ok(of(fake.requests, 'GET', '/api/v1/wallet').every(r => r.authorization === `Bearer ${KEY}`));
    const telemetry = of(fake.requests, 'POST', '/api/v1/telemetry');
    assert.equal(telemetry.length, 1, 'one app_opened after the sign-in');
    assert.equal(telemetry[0].authorization, `Bearer ${KEY}`);
    const event = JSON.parse(telemetry[0].body);
    assert.equal(event.event, 'app_opened');
    assert.equal(event.app, 'ghost');
    assert.equal(event.app_version, version);
    const wallets = of(fake.requests, 'GET', '/api/v1/wallet');
    assert.ok(wallets.length >= 3 && fake.requests.indexOf(telemetry[0]) > fake.requests.indexOf(wallets[2]), 'the usage count comes only after the wallet says claimed');
    assert.ok(!run.stdout.includes(KEY) && !run.stderr.includes(KEY), 'the key is not printed');
  } finally { fake.server.close(); }
});

test('signed in: no screen, and DO_NOT_TRACK=1 sends no usage count', async () => {
  const fake = await fakePublik({ claimFrom: 1 });
  try {
    const run = await runDriver(fake.origin, { DO_NOT_TRACK: '1' });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.screens, []);
    assert.deepEqual(run.result, { claim_state: 'claimed', choice: null, key: 'pk_' });
    assert.equal(of(fake.requests, 'POST', '/api/v1/telemetry').length, 0);
    assert.match(run.stderr, /publik-telemetry: app_opened -> off \(opt-out\)/);
  } finally { fake.server.close(); }
});

test('publik not reachable: the gate says so and offers Retry', async () => {
  const fake = await fakePublik();
  const origin = fake.origin;
  await new Promise(resolve => fake.server.close(resolve));
  const run = await runDriver(origin, { GATE_EXIT_ON: 'unreachable' });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.screens.map(s => [s.id, s.title, s.body, s.buttons.map(b => b.label)]), [
    ['unreachable', 'Sign in with publik', 'publik is not reachable. Check your connection.', ['Retry']]
  ]);
});

test('a build with no app token says so and sends nothing', { skip: existsSync(path.join(root, 'electron', 'publik-app-token.txt')) || existsSync(path.join(root, 'publik-app-token.txt')) ? 'this checkout has a token file' : false }, async () => {
  const fake = await fakePublik();
  try {
    const run = await runDriver(fake.origin, { PUBLIK_APP_TOKEN: '', GATE_EXIT_ON: 'unreachable' });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.screens[0]?.body, 'This build has no publik app token. Ask the developer for a new build.');
    assert.equal(fake.requests.length, 0);
  } finally { fake.server.close(); }
});

test('PUBLIK_SELF_TEST=1 prints the self-test line after a real GET /wallet and exits', async () => {
  const fake = await fakePublik({ claimFrom: 99 });
  try {
    const run = await runDriver(fake.origin, { PUBLIK_SELF_TEST: '1' });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout.trim(), `publik self-test: ok ghost ${version}`);
    assert.deepEqual(fake.requests.map(r => `${r.method} ${r.url}`), ['POST /api/v1/installs', 'GET /api/v1/wallet']);
  } finally { fake.server.close(); }
});
