// Unit tests of the update signature check (publik-update-verify.cjs) and of the signed-feed provider
// (publik-updater.cjs), in plain Node, against a fake HTTP executor.
//
// The fixtures in tests/fixtures/update-feed/ were made with the real tools, not with this code:
//   scripts/publik-update-feed.cjs write  -> latest.yml, latest-mac.yml (fake installer files; the mac
//                                            feed lists an arm64 and an x64 zip and dmg, as a Ghost release does)
//   npx @tauri-apps/cli@2.12.4 signer sign (two throwaway test keys, made with `tauri signer generate`):
//     test-key.pub        signs latest.yml.sig, latest-mac.yml.sig, latest.yml.sig-wrong-name
//                         (the bytes of latest.yml, signed under the name latest-mac.yml)
//     other-test-key.pub  signs latest.yml.sig-other-key
// The private test keys were thrown away. The publik update key is never used by these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures', 'update-feed');
const fx = (name) => fs.readFileSync(path.join(FX, name));
const fxText = (name) => fs.readFileSync(path.join(FX, name), 'utf8');

const V = require('../electron/publik-update-verify.cjs');
const { PublikSignedFeedProvider, checkSignedFeed } = require('../electron/publik-updater.cjs');
const { MacUpdater } = require('electron-updater/out/MacUpdater');
const { findFile } = require('electron-updater/out/providers/Provider');

const TEST_KEY = fxText('test-key.pub');
const OTHER_KEY = fxText('other-test-key.pub');
const FEED = fx('latest.yml');
const SIG = fxText('latest.yml.sig');

const rejects = (fn, re) => assert.throws(fn, (e) => e.code === V.ERROR_CODE && re.test(e.message));

test('a tauri signature (base64-wrapped minisign, prehashed "ED") verifies', () => {
  const v = V.verifyMinisign(FEED, SIG, TEST_KEY, { file: 'latest.yml' });
  assert.equal(v.algorithm, 'ED');
  assert.equal(v.keyId, 'ADB72B05561D5373');
  assert.equal(v.file, 'latest.yml');
  assert.match(v.timestamp, /^\d+$/);
});

test('the same signature as plain minisign text (not base64-wrapped) verifies', () => {
  const raw = Buffer.from(SIG, 'base64').toString('utf8');
  assert.ok(raw.startsWith('untrusted comment:'));
  V.verifyMinisign(FEED, raw, TEST_KEY, { file: 'latest.yml' });
  V.verifyMinisign(FEED, raw.replace(/\n/g, '\r\n'), TEST_KEY); // CRLF line ends too
});

test('the public key parses as the bare line, the .pub file and tauri base64', () => {
  const file = Buffer.from(TEST_KEY, 'base64').toString('utf8');
  const line = file.trim().split('\n')[1];
  for (const form of [TEST_KEY, file, line]) {
    assert.equal(V.keyIdHex(V.parsePublicKey(form).keyId), 'ADB72B05561D5373');
    V.verifyMinisign(FEED, SIG, form);
  }
});

test('the committed publik update key parses: key ID F5E0515C77912BD0', () => {
  const k = V.parsePublicKey(V.PUBLIK_UPDATE_PUBLIC_KEY);
  assert.equal(V.keyIdHex(k.keyId), 'F5E0515C77912BD0');
  assert.equal(k.publicKey.length, 32);
});

test('one changed byte anywhere in the feed is refused', () => {
  for (const at of [0, 20, FEED.length >> 1, FEED.length - 1]) {
    const bad = Buffer.from(FEED);
    bad[at] ^= 0x01;
    rejects(() => V.verifyMinisign(bad, SIG, TEST_KEY), /does not match the file/);
  }
  rejects(() => V.verifyMinisign(Buffer.concat([FEED, Buffer.from('\n')]), SIG, TEST_KEY), /does not match the file/);
});

test('with a list of keys (key rotation), the key the signature names is used', () => {
  assert.equal(V.verifyMinisign(FEED, SIG, [OTHER_KEY, TEST_KEY]).keyId, 'ADB72B05561D5373');
  assert.equal(V.verifyMinisign(FEED, fxText('latest.yml.sig-other-key'), [OTHER_KEY, TEST_KEY]).keyId, '5C93B14732EAF5BB');
  rejects(() => V.verifyMinisign(FEED, SIG, [OTHER_KEY]), /not with the update key 5C93B14732EAF5BB/);
  rejects(() => V.verifyMinisign(FEED, SIG, []), /no public key/);
  assert.deepEqual(V.PUBLIK_UPDATE_PUBLIC_KEYS, [V.PUBLIK_UPDATE_PUBLIC_KEY]);
});

test('a signature by another key is refused, even with a valid signature from that key', () => {
  V.verifyMinisign(FEED, fxText('latest.yml.sig-other-key'), OTHER_KEY); // valid for its own key
  rejects(() => V.verifyMinisign(FEED, fxText('latest.yml.sig-other-key'), TEST_KEY), /signed with key 5C93B14732EAF5BB, not with the update key ADB72B05561D5373/);
});

test('a signature from the other key with the key ID swapped in is refused by the math', () => {
  const raw = Buffer.from(fxText('latest.yml.sig-other-key'), 'base64').toString('utf8').trim().split('\n');
  const line = Buffer.from(raw[1], 'base64');
  V.parsePublicKey(TEST_KEY).keyId.copy(line, 2);
  raw[1] = line.toString('base64');
  rejects(() => V.verifyMinisign(FEED, raw.join('\n'), TEST_KEY), /does not match the file/);
});

test('a changed trusted comment is refused (global signature)', () => {
  const raw = Buffer.from(SIG, 'base64').toString('utf8').trim().split('\n');
  raw[2] = raw[2].replace('file:latest.yml', 'file:latest-mac.yml');
  rejects(() => V.verifyMinisign(FEED, raw.join('\n'), TEST_KEY), /trusted comment signature does not match/);
});

test('a valid signature made for another file name is refused when the name is checked', () => {
  const wrong = fxText('latest.yml.sig-wrong-name');
  V.verifyMinisign(FEED, wrong, TEST_KEY); // the bytes match
  rejects(() => V.verifyMinisign(FEED, wrong, TEST_KEY, { file: 'latest.yml' }), /is for "latest-mac.yml", not for "latest.yml"/);
});

test('the mac feed verifies with its own signature only', () => {
  V.verifyMinisign(fx('latest-mac.yml'), fxText('latest-mac.yml.sig'), TEST_KEY, { file: 'latest-mac.yml' });
  rejects(() => V.verifyMinisign(fx('latest-mac.yml'), SIG, TEST_KEY), /does not match the file/);
});

test('malformed signatures and keys fail cleanly with the signature error code', () => {
  const raw = Buffer.from(SIG, 'base64').toString('utf8').trim().split('\n');
  const cases = [
    ['', /empty/],
    ['   ', /empty/],
    ['not base64 at all!', /neither minisign text nor base64/],
    [Buffer.from('hello world').toString('base64'), /not a minisign signature/],
    [raw.slice(0, 3).join('\n'), /3 lines, want 4/],
    [[raw[0], raw[1].slice(0, -8), raw[2], raw[3]].join('\n'), /signature line/],
    [[raw[0], raw[1], 'trusted: x', raw[3]].join('\n'), /no trusted comment line/],
    [[raw[0], raw[1], raw[2], raw[3].slice(4)].join('\n'), /global signature/],
    ['x'.repeat(5000), /too long/],
  ];
  for (const [sig, re] of cases) rejects(() => V.verifyMinisign(FEED, sig, TEST_KEY), re);
  const unknownAlg = Buffer.from(raw[1], 'base64');
  unknownAlg.write('XX', 0, 'latin1');
  rejects(() => V.verifyMinisign(FEED, [raw[0], unknownAlg.toString('base64'), raw[2], raw[3]].join('\n'), TEST_KEY), /unknown signature algorithm/);
  rejects(() => V.verifyMinisign(FEED, SIG, 'RWQ='), /42/);
  rejects(() => V.verifyMinisign(FEED, SIG, ''), /empty/);
  rejects(() => V.verifyMinisign(FEED.toString('utf8'), SIG, TEST_KEY), /must be a Buffer/);
});

test('a legacy minisign signature ("Ed": Ed25519 over the file itself) verifies', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = crypto.randomBytes(8);
  const keyLine = Buffer.concat([Buffer.from('Ed'), keyId, pub]).toString('base64');
  const message = Buffer.from('legacy signed message\n');
  const sig = crypto.sign(null, message, privateKey);
  const comment = 'timestamp:1\tfile:legacy.txt';
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
  const text = ['untrusted comment: legacy', Buffer.concat([Buffer.from('Ed'), keyId, sig]).toString('base64'), `trusted comment: ${comment}`, global.toString('base64')].join('\n');
  assert.equal(V.verifyMinisign(message, text, keyLine, { file: 'legacy.txt' }).algorithm, 'Ed');
  // The same bytes labelled "ED" must not pass: the algorithm is part of what is checked.
  const relabelled = text.replace(text.split('\n')[1], Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64'));
  rejects(() => V.verifyMinisign(message, relabelled, keyLine), /does not match the file/);
});

test('blakejs (the Electron path) and Node crypto give the same BLAKE2b-512', () => {
  assert.ok(crypto.getHashes().includes('blake2b512'), 'this Node has blake2b512');
  for (const n of [0, 1, 127, 128, 129, 1000, 65537]) {
    const data = crypto.randomBytes(n);
    assert.deepEqual(V.blake2b512(data, { native: false }), V.blake2b512(data, { native: true }));
  }
  // RFC 7693 Appendix A: BLAKE2b-512("abc")
  assert.equal(V.blake2b512(Buffer.from('abc'), { native: false }).toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});

// ---- the provider: electron-updater's generic provider + the signature check ----

function fakeExecutor(files) {
  const seen = [];
  return {
    seen,
    async downloadToBuffer(url) {
      seen.push(url.href);
      const name = decodeURIComponent(url.pathname.split('/').pop());
      if (!(name in files)) throw new Error(`Cannot download "${url.href}", status 404: Not Found`);
      return Buffer.from(files[name]);
    },
  };
}

function provider(files, { platform = 'win32', slug = 'ghost', publicKey = TEST_KEY, url = 'https://publikhq.com/api/updates/ghost/' } = {}) {
  const executor = fakeExecutor(files);
  const updater = { channel: null, isAddNoCacheQuery: true };
  const p = new PublikSignedFeedProvider({ provider: 'custom', url, slug, publicKey }, updater, { platform, executor, isUseMultipleRangeRequest: false });
  return { p, executor };
}

test('provider: a signed feed is read, and its absolute GitHub URLs stay absolute', async () => {
  const { p, executor } = provider({ 'latest.yml': FEED, 'latest.yml.sig': SIG });
  const info = await p.getLatestVersion();
  assert.equal(info.version, '9.9.9-fixture.1');
  const files = p.resolveFiles(info);
  assert.equal(files.length, 1);
  assert.equal(files[0].url.href, 'https://github.com/Blueturboguy07/ghost-location/releases/download/v9.9.9-fixture.1/Ghost-9.9.9-fixture.1-win-x64.exe');
  assert.ok(executor.seen.every((u) => u.startsWith('https://publikhq.com/api/updates/ghost/latest.yml')), executor.seen.join(' '));
  assert.ok(executor.seen.some((u) => /latest\.yml\.sig\?noCache=/.test(u)));
});

test('provider: macOS reads latest-mac.yml; the zips (arm64, x64) are listed before the dmgs', async () => {
  const { p } = provider({ 'latest-mac.yml': fx('latest-mac.yml'), 'latest-mac.yml.sig': fxText('latest-mac.yml.sig') }, { platform: 'darwin' });
  const info = await p.getLatestVersion();
  const names = p.resolveFiles(info).map((f) => f.url.href.split('/').pop());
  assert.deepEqual(names, ['Ghost-9.9.9-fixture.1-mac-arm64.zip', 'Ghost-9.9.9-fixture.1-mac-x64.zip', 'Ghost-9.9.9-fixture.1-mac-arm64.dmg', 'Ghost-9.9.9-fixture.1-mac-x64.dmg']);
});

// electron-updater's own Mac file choice (MacUpdater.filterFilesForArch, then the first zip), on the signed
// feed: an Apple-chip Mac (also an x64 build under Rosetta) gets the arm64 zip, an Intel Mac the x64 zip.
test('provider + MacUpdater: each Mac architecture downloads its own zip from the two-arch feed', async () => {
  const { p } = provider({ 'latest-mac.yml': fx('latest-mac.yml'), 'latest-mac.yml.sig': fxText('latest-mac.yml.sig') }, { platform: 'darwin' });
  const files = p.resolveFiles(await p.getLatestVersion());
  for (const [isArm64Mac, want] of [[true, 'Ghost-9.9.9-fixture.1-mac-arm64.zip'], [false, 'Ghost-9.9.9-fixture.1-mac-x64.zip']]) {
    const zip = findFile(MacUpdater.filterFilesForArch(files, isArm64Mac), 'zip', ['pkg', 'dmg']);
    assert.equal(zip.url.href.split('/').pop(), want, `isArm64Mac=${isArm64Mac}`);
    assert.match(zip.info.sha512, /^[A-Za-z0-9+/]{86}==$/);
  }
});

test('provider: no signature, a wrong signature, another key or another app: refused before any download', async () => {
  const cases = [
    [{ 'latest.yml': FEED }, /latest\.yml\.sig/],
    [{ 'latest.yml': Buffer.from(FEED.toString().replace('size: 28', 'size: 29')), 'latest.yml.sig': SIG }, /not signed by the publik update key: signature does not match/],
    [{ 'latest.yml': FEED, 'latest.yml.sig': fxText('latest.yml.sig-other-key') }, /signed with key 5C93B14732EAF5BB/],
    [{ 'latest.yml': FEED, 'latest.yml.sig': fxText('latest.yml.sig-wrong-name') }, /is for "latest-mac.yml"/],
    [{ 'latest.yml': FEED, 'latest.yml.sig': '' }, /empty/],
  ];
  for (const [files, re] of cases) {
    const { p } = provider(files);
    await assert.rejects(p.getLatestVersion(), (e) => e.code === 'ERR_PUBLIK_FEED_SIGNATURE' && re.test(e.message), `case ${re}`);
  }
  // Signed, but by this test key for app "ghost": an app with another slug refuses it.
  const { p } = provider({ 'latest.yml': FEED, 'latest.yml.sig': SIG }, { slug: 'otherapp' });
  await assert.rejects(p.getLatestVersion(), (e) => e.code === 'ERR_PUBLIK_FEED_SIGNATURE' && /is for "ghost", not for "otherapp"/.test(e.message));
});

test('checkSignedFeed: every file needs a sha512 (sha2 alone is not enough)', () => {
  const sha512 = 'a'.repeat(86) + '==';
  const ok = { version: '1.0.0', publikApp: 'ghost', files: [{ url: 'https://x/a.exe', sha512, size: 1 }] };
  checkSignedFeed(ok, 'latest.yml', 'ghost');
  checkSignedFeed({ ...ok, files: [{ url: 'https://x/a.exe', sha512: 'f'.repeat(128) }] }, 'latest.yml', 'ghost');
  const bad = [
    { ...ok, files: [{ url: 'https://x/a.exe', sha2: 'f'.repeat(64) }] },
    { ...ok, files: [{ url: 'https://x/a.exe', sha512: 'short' }] },
    { ...ok, files: [] },
    { ...ok, files: undefined },
    { ...ok, version: undefined },
    { ...ok, publikApp: undefined },
  ];
  for (const info of bad) assert.throws(() => checkSignedFeed(info, 'latest.yml', 'ghost'));
});

test('provider: the real publik key refuses a feed signed by a test key', async () => {
  // publicKey null: the provider falls back to PUBLIK_UPDATE_PUBLIC_KEY, as in the app.
  const { p } = provider({ 'latest.yml': FEED, 'latest.yml.sig': SIG }, { publicKey: null });
  await assert.rejects(p.getLatestVersion(), /not with the update key F5E0515C77912BD0/);
});

test('provider: a missing feed reports electron-updater\'s "channel file not found" code', async () => {
  const { p } = provider({});
  await assert.rejects(p.getLatestVersion(), (e) => e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
});

test('provider: the staging-ID header electron-updater adds is not sent', () => {
  const { p } = provider({});
  p.setRequestHeaders({ 'x-user-staging-id': 'abc', accept: '*/*' });
  assert.deepEqual(p.requestHeaders, { accept: '*/*' });
  p.setRequestHeaders({ 'x-user-staging-id': 'abc' });
  assert.equal(p.requestHeaders, null);
});
