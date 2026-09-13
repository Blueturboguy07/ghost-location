import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../backend/process.mjs';

test('native arguments preserve shell syntax literally', async () => {
  const literal = '$(echo SHOULD_NOT_EXECUTE); `echo nope` " a b';
  const result = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.stdout, literal);
  assert.equal(result.code, 0);
});

test('runner captures both streams and returns nonzero status without hiding output', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(4)']);
  assert.deepEqual(result, {stdout: 'out', stderr: 'err', code: 4});
});

test('run enforces a bounded timeout and rejects with a classified error', async () => {
  const start = Date.now();
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {timeoutMs: 50}), error => error.code === 'ETIMEDOUT');
  assert.ok(Date.now() - start < 3000);
});

test('runner handles missing executables and bounded output', async () => {
  await assert.rejects(run('ghost-definitely-missing-executable', []), error => error.code === 'ENOENT');
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {maxOutputBytes: 100}), error => error.code === 'EOUTPUTLIMIT');
});

test('runner cancels a live command using an AbortSignal', async () => {
  const controller = new AbortController();
  const result = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {signal: controller.signal});
  controller.abort();
  await assert.rejects(result, error => error.code === 'ABORT_ERR');
});
