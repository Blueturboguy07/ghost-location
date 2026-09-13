import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { supportsArchitecture, validateResources, beforePack } from '../scripts/check-resources.mjs';

function macho(cpu) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4);
  return bytes;
}
test('native resource architecture inspection distinguishes Mac CPUs, universal ADB and Windows PE', () => {
  assert.equal(supportsArchitecture(macho(0x0100000c), 'darwin', 'arm64'), true);
  assert.equal(supportsArchitecture(macho(0x0100000c), 'darwin', 'x64'), false);
  const universal = Buffer.alloc(64); universal.writeUInt32BE(0xcafebabe); universal.writeUInt32BE(2, 4);
  universal.writeUInt32BE(0x0100000c, 8); universal.writeUInt32BE(0x01000007, 28);
  assert.equal(supportsArchitecture(universal, 'darwin', 'x64'), true);
  assert.equal(supportsArchitecture(universal, 'darwin', 'arm64'), true);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(80, 60); pe.write('PE\0\0', 80); pe.writeUInt16LE(0x8664, 84);
  assert.equal(supportsArchitecture(pe, 'win32', 'x64'), true);
  assert.equal(supportsArchitecture(pe, 'darwin', 'arm64'), false);
  assert.equal(supportsArchitecture(Buffer.from('empty'), 'win32', 'x64'), false);
});

test('official Windows x86 ADB is allowed on x64 without weakening the iOS sidecar check', () => {
  const fixture = Buffer.alloc(128);
  fixture.write('MZ'); fixture.writeUInt32LE(80, 60);
  fixture.write('PE\0\0', 80); fixture.writeUInt16LE(0x014c, 84);
  const adb = process.platform === 'win32'
    ? readFileSync(path.join(process.cwd(), 'resources/adb/win32-x64/adb.exe'))
    : fixture;
  assert.equal(supportsArchitecture(adb, 'win32', 'x64'), false);
  assert.equal(supportsArchitecture(adb, 'win32', 'x64', { allowWindowsX86: true }), true);
});

test('an empty iOS resource directory cannot pass packaging checks; modified APK also fails', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ghost-resources-'));
  const put = (name, value) => {
    const output = path.join(root, name); mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, value, { mode: 0o755 });
  };
  const json = (name, value) => put(name, JSON.stringify(value));
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const adb = macho(0x0100000c); const apk = Buffer.from('PK\u0003\u0004fixture'); const notice = 'notice';
  try {
    put('resources/adb/darwin-arm64/adb', adb); put('resources/adb/darwin-arm64/NOTICE.txt', notice);
    json('resources/adb/darwin-arm64/provenance.json', { platform: 'darwin', arch: 'arm64', files: [
      { file: 'adb', sha256: hash(adb) }, { file: 'NOTICE.txt', sha256: hash(notice) },
    ] });
    put('resources/android/settings.apk', apk); put('resources/android/LICENSE', notice);
    json('resources/android/provenance.json', { name: 'io.appium.settings', version: '8.0.9', apkSha256: hash(apk), notices: ['LICENSE'] });
    json('package.json', { devDependencies: { 'io.appium.settings': '8.0.9' } });
    mkdirSync(path.join(root, 'resources/ios/darwin-arm64'), { recursive: true });
    const options = { root, platform: 'darwin', arch: 'arm64', smoke: false };
    assert.throws(() => validateResources(options), /Missing resource:.*ghost-ios/);
    put('resources/android/settings.apk', Buffer.from('PKtampered'));
    assert.throws(() => validateResources(options), /checksum/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('electron-builder actual target is rejected when it differs from the native host', async () => {
  const platform = process.platform === 'win32' ? 'darwin' : 'win32';
  await assert.rejects(beforePack({ electronPlatformName: platform, arch: 1, packager: { projectDir: process.cwd() } }), /matching native host/);
});
