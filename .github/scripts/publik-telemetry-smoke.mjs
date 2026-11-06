// Starts a packaged Ghost build against a local listener and checks the publik usage count.
// Usage: node .github/scripts/publik-telemetry-smoke.mjs <path to the Ghost executable>
// Run 1: one app_opened request must arrive and match the contract. Run 2 (DO_NOT_TRACK=1): no request.
// It uses temporary settings folders, never a phone command, and never the production endpoint.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the path of the packaged Ghost executable.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const osName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const received = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    received.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(204).end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/telemetry`;

async function launch(extraEnv, until, limitMs) {
  const env = { ...process.env, PUBLIK_TELEMETRY_URL: endpoint, PUBLIK_TELEMETRY_DEBUG: '1', ...extraEnv };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'PUBLIK_TELEMETRY', 'PUBLIK_API_KEY', ...(extraEnv.DO_NOT_TRACK ? [] : ['DO_NOT_TRACK'])]) delete env[name];
  const userData = mkdtempSync(path.join(tmpdir(), 'ghost-telemetry-'));
  const child = spawn(executable, [`--user-data-dir=${userData}`], { env, stdio: ['ignore', 'inherit', 'pipe'] });
  let stderr = '', exit = null;
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  child.once('error', error => { exit = { error: error.message }; });
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline && !exit && !until(stderr)) await sleep(200);
  const early = exit;
  if (!exit) { child.kill(); for (let i = 0; i < 50 && !exit; i++) await sleep(100); if (!exit) child.kill('SIGKILL'); }
  if (early) throw new Error(`Ghost stopped by itself: ${JSON.stringify(early)}`);
  return stderr;
}

const failures = [];
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`); if (!ok) failures.push(message); };

await launch({}, () => received.length > 0, 30000);
check(received.length === 1, `one request arrived (got ${received.length})`);
if (received.length) {
  const { method, url, headers, body } = received[0];
  console.log(`request: ${method} ${url} ${body}`);
  let event = {};
  try { event = JSON.parse(body); } catch {}
  check(method === 'POST' && url === '/api/v1/telemetry', 'POST /api/v1/telemetry');
  check(/^application\/json/.test(headers['content-type'] || ''), 'Content-Type is application/json');
  check(!('origin' in headers), 'no web Origin header (sent from the main process)');
  check(!('authorization' in headers), 'no Authorization header (Ghost has no publik sign-in)');
  check(event.v === 1 && event.event === 'app_opened', 'v 1, event app_opened');
  check(event.app === 'ghost', 'app is ghost');
  check(event.app_version === version, `app_version is ${version} (got ${event.app_version})`);
  check(event.os === osName && event.arch === process.arch, `os ${osName}, arch ${process.arch}`);
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.install_id || ''), 'install_id is a lowercase UUID v4');
  check(Object.keys(event).sort().join() === 'app,app_version,arch,event,install_id,os,v', 'no other field');
}

received.length = 0;
const quiet = await launch({ DO_NOT_TRACK: '1' }, stderr => stderr.includes('off (opt-out)'), 15000);
await sleep(2000);
check(received.length === 0, `DO_NOT_TRACK=1: no request (got ${received.length})`);
console.log(quiet.includes('off (opt-out)') ? 'opt-out line seen' : 'opt-out line not seen on stderr (silence still counts)');

server.close();
if (failures.length) { console.error(`RESULT: FAIL (${failures.length})`); process.exit(1); }
console.log('RESULT: PASS');
process.exit(0);
