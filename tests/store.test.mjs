import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, defaults } from '../backend/store.mjs';

test('serializes concurrent writes and reads a complete document', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ghost-store-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'); const store = new Store(file); await store.load();
  await Promise.all([1, 2, 3].map(n => store.save({ ...defaults(), recentPlaces: [{ label: String(n) }] })));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).recentPlaces[0].label, '3');
});
test('preserves corrupt state as a backup and exposes a recovery warning', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ghost-corrupt-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'); await writeFile(file, '{broken');
  const store = new Store(file); await store.load();
  assert.match(store.warning, /backup/); assert.ok((await readdir(dir)).some(file => file.startsWith('settings.json.backup-')));
});
