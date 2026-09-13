import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, 'sidecar', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
test('Python iOS bridge USB selection, acknowledgement, failure and cleanup', { skip: !existsSync(python) }, () => {
  const result = spawnSync(python, ['-m', 'unittest', 'test_bridge.py'], {
    cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
