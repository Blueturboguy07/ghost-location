// Starts a packaged Ghost build against a fake publik on this machine and checks the Sign in with
// publik gate and the publik usage count. CI only (.github/workflows/publik-build.yml).
// Usage: node .github/scripts/publik-telemetry-smoke.mjs <path to the Ghost executable>
//
// The fake publik answers POST /api/v1/installs, GET /api/v1/wallet and POST /api/v1/telemetry.
// Ghost reaches it through PUBLIK_ORIGIN (the publik module reads it; tests only). Nothing here
// talks to publikhq.com, and the app must carry its own app token (PUBLIK_APP_TOKEN is removed).
// Run 1, the gate: the wallet says "anonymous". Ghost must wait at the gate: it polls GET /wallet
//   and sends no usage count. Then the wallet says "claimed": the gate lets Ghost through, one
//   app_opened arrives with this computer's publik key, and Ghost keeps running.
// Run 2, signed in, DO_NOT_TRACK=1: the stored key passes the gate at once, and no usage count is sent.
// It uses temporary settings folders, never a phone command.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the path of the packaged Ghost executable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const osName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEY = 'pk_live_ghostsmoke000_00000000000000000000000000000000'; // a fake key of this fake publik

let claimed = false;
const received = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    received.push({ method: request.method, url: request.url, headers: request.headers, body });
    const json = (status, data) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.method === 'POST' && request.url === '/api/v1/installs') {
      let installId = '';
      try { installId = JSON.parse(body).install_id; } catch {}
      return json(201, { key: KEY, install_id: installId, claim_url: `${origin}/claim/smoke`, claim_state: 'anonymous' });
    }
    if (request.method === 'GET' && request.url === '/api/v1/wallet') {
      return json(200, { claim_state: claimed ? 'claimed' : 'anonymous', claim_url: claimed ? null : `${origin}/claim/smoke`, account: claimed ? { handle: 'ci' } : null,
        plan: { kind: 'none', label: null }, balance_micros: 0, top_up_url: `${origin}/wallet`, linked_at: null });
    }
    if (request.method === 'POST' && request.url === '/api/v1/telemetry') return response.writeHead(204).end();
    json(404, {});
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const of = (method, url) => received.filter(r => r.method === method && r.url === url);

// One home folder for both runs: run 2 reuses the publik key that run 1 stored. On Windows the
// profile stays (an Electron app with no AppData folders stops at once); only LOCALAPPDATA,
// where the publik module keeps its files, moves.
const home = mkdtempSync(path.join(tmpdir(), 'ghost-publik-home-'));
const localAppData = path.join(home, 'AppData', 'Local');
const xdgConfig = path.join(home, '.config');
for (const dir of [localAppData, xdgConfig, path.join(home, 'Library', 'Application Support')]) mkdirSync(dir, { recursive: true });

function launch(extraEnv) {
  const env = { ...process.env, PUBLIK_ORIGIN: origin, PUBLIK_TELEMETRY_DEBUG: '1', LOCALAPPDATA: localAppData, XDG_CONFIG_HOME: xdgConfig,
    ...(process.platform === 'win32' ? {} : { HOME: home }), ...extraEnv };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'PUBLIK_TELEMETRY', 'PUBLIK_TELEMETRY_URL', 'PUBLIK_API_KEY', 'PUBLIK_APP_TOKEN', 'PUBLIK_SELF_TEST',
    ...(extraEnv.DO_NOT_TRACK ? [] : ['DO_NOT_TRACK'])]) delete env[name];
  const userData = mkdtempSync(path.join(tmpdir(), 'ghost-telemetry-'));
  const child = spawn(executable, [`--user-data-dir=${userData}`], { env, stdio: ['ignore', 'inherit', 'pipe'] });
  const run = { child, stderr: '', exit: null };
  child.stderr.on('data', chunk => { run.stderr += chunk; process.stderr.write(chunk); });
  child.once('exit', (code, signal) => { run.exit = { code, signal }; });
  child.once('error', error => { run.exit = { error: error.message }; });
  return run;
}
async function waitFor(run, until, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline && !run.exit && !until()) await sleep(200);
  return until();
}
async function stop(run) {
  if (run.exit) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { stdio: 'ignore' });
  else run.child.kill();
  for (let i = 0; i < 50 && !run.exit; i++) await sleep(100);
  if (!run.exit) run.child.kill('SIGKILL');
}

const failures = [];
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`); if (!ok) failures.push(message); };

// ---- Run 1: the gate holds Ghost until the person is signed in.
const first = launch({});
await waitFor(first, () => of('GET', '/api/v1/wallet').length >= 3, 60000);
check(!first.exit, `Ghost waits at the gate and keeps running (exit: ${JSON.stringify(first.exit)})`);
const installs = of('POST', '/api/v1/installs');
check(installs.length === 1, `one POST /api/v1/installs (got ${installs.length})`);
if (installs.length) {
  let b = {};
  try { b = JSON.parse(installs[0].body); } catch {}
  check(b.app_slug === 'ghost', `installs: app_slug is ghost (got ${b.app_slug})`);
  check(b.app_version === version, `installs: app_version is ${version} (got ${b.app_version})`);
  check(b.os === osName, `installs: os is ${osName} (got ${b.os})`);
  check(typeof b.app_token === 'string' && b.app_token.startsWith('pat_'), 'installs: the build carries its own pat_ app token (not printed)');
}
const wallets = of('GET', '/api/v1/wallet');
check(wallets.length >= 3, `the gate polls GET /api/v1/wallet while anonymous (got ${wallets.length})`);
check(wallets.every(r => r.headers.authorization === `Bearer ${KEY}`), 'GET /wallet carries the install key');
check(of('POST', '/api/v1/telemetry').length === 0, 'anonymous: no usage count before the sign-in');

claimed = true;
await waitFor(first, () => of('POST', '/api/v1/telemetry').length > 0, 30000);
await sleep(5000); // Ghost must keep running after the gate window closes (the gap is not a quit)
check(!first.exit, `signed in: Ghost keeps running after the gate (exit: ${JSON.stringify(first.exit)})`);
const events = of('POST', '/api/v1/telemetry');
check(events.length === 1, `signed in: one usage count arrived (got ${events.length})`);
if (events.length) {
  const { headers, body } = events[0];
  console.log(`request: POST /api/v1/telemetry ${body}`);
  let event = {};
  try { event = JSON.parse(body); } catch {}
  check(/^application\/json/.test(headers['content-type'] || ''), 'Content-Type is application/json');
  check(!('origin' in headers), 'no web Origin header (sent from the main process)');
  check(headers.authorization === `Bearer ${KEY}`, 'Authorization: Bearer <this computer\'s publik key>');
  check(event.v === 1 && event.event === 'app_opened', 'v 1, event app_opened');
  check(event.app === 'ghost', 'app is ghost');
  check(event.app_version === version, `app_version is ${version} (got ${event.app_version})`);
  check(event.os === osName && event.arch === process.arch, `os ${osName}, arch ${process.arch}`);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.install_id || ''), 'install_id is a lowercase UUID v4');
  check(Object.keys(event).sort().join() === 'app,app_version,arch,event,install_id,os,v', 'no other field');
}
check(!(first.stderr.includes(KEY)), 'the key was not printed');
await stop(first);

// ---- Run 2: signed in, DO_NOT_TRACK=1.
received.length = 0;
const second = launch({ DO_NOT_TRACK: '1' });
await waitFor(second, () => second.stderr.includes('off (opt-out)'), 30000);
await sleep(2000);
check(!second.exit, `signed in: Ghost starts with the stored key (exit: ${JSON.stringify(second.exit)})`);
check(of('POST', '/api/v1/installs').length === 0, 'signed in: the stored key is used again (no new POST /installs)');
check(of('GET', '/api/v1/wallet').length >= 1, 'signed in: GET /wallet answered "claimed"');
check(of('POST', '/api/v1/telemetry').length === 0, `DO_NOT_TRACK=1: no usage count (got ${of('POST', '/api/v1/telemetry').length})`);
console.log(second.stderr.includes('off (opt-out)') ? 'opt-out line seen' : 'opt-out line not seen on stderr (silence still counts)');
await stop(second);

server.close();
if (failures.length) { console.error(`RESULT: FAIL (${failures.length})`); process.exit(1); }
console.log('RESULT: PASS');
process.exit(0);
