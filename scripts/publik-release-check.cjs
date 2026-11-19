#!/usr/bin/env node
// publik-release-check.cjs — the file checks and helpers of scripts/publik-release.sh (docs/updates.md ›
// Cut a release). It reads files and public URLs only: it starts no program and prints no secret (the
// publik app token appears only as a fingerprint: "pat_ sha256:<first 16 hex> length:<n>").
// Each check prints "PASS ..." or "FAIL ..."; the exit code is 1 when one failed.
//
//   feed <feed dir> <files dir> --version X.Y.Z --app ghost --base https://github.com/OWNER/REPO/releases/download/vX.Y.Z/
//        latest.yml and latest-mac.yml (+ .sig): the signature verifies with the public key in
//        electron/publik-update-verify.cjs, version, publikApp, absolute URLs under --base, `path`/`sha512`
//        name the first file; and each listed file that is in <files dir>: its sha512 and size.
//   sums <SHA256SUMS.txt> <files dir>       each listed file that is in <files dir> has that sha256 (LF or CRLF)
//   exe <installer.exe> --version X.Y.Z     ProductVersion and FileVersion in the installer's VS_VERSIONINFO
//   asar <app.asar> --version X.Y.Z [--token <fingerprint>]
//        the packed package.json is the release build of that version (no "publikUpdaterTest"), the updater
//        with the publik feed and its start call for "ghost" are packed, the publik app token is packed;
//        with --token: its fingerprint equals <fingerprint> (the last release's)
//   token <app.asar>                        prints the fingerprint of the packed publik app token
//   win-token <installed app.asar> <installer.exe> --out <file>
//        publik-build.yml, Windows job, after the silent install of <installer.exe>: writes
//        { installer, sha256, token } (token = the fingerprint) so that the release script can tie the
//        installer it uploads, byte for byte, to the token of the app that this installer installed
//   remote-token <zip url> [<member>]       the same fingerprint, read from a PUBLISHED release zip with HTTP
//        range requests (nothing is written to disk). <member> defaults to Ghost.app/Contents/Resources/app.asar
//   macho <dir>                             every Mach-O file under <dir> (symlinks skipped), deepest first, one
//        line each: "exec<TAB>path" (MH_EXECUTE) or "lib<TAB>path" (dylib, bundle, .so, other)
//   record <file> <records dir>             writes <records dir>/<name>.json: { name, sha256, sha512, size }
//   write-feed --app ghost --version X.Y.Z --base <url> --records <dir> --out <dir>
//        latest.yml (the Windows installer) and latest-mac.yml (the arm64 zip, the x64 zip, then the dmgs, as
//        scripts/publik-update-feed.cjs orders them) from the records, so the installers need not all be on
//        disk at the same time. Signing: scripts/publik-update-feed.cjs sign.
//   sums-file <records dir> <out> <name>...  SHA256SUMS.txt ("<sha256>  <name>", LF) for the named files
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../electron/publik-update-verify.cjs');

const KEY_ID = 'F5E0515C77912BD0';
const TOKEN_FILE = 'electron/publik-app-token.txt';
let failed = 0;
function ok(pass, msg) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${msg}`);
  if (!pass) failed++;
}
function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}
function hashFile(file, algo, encoding) {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest(encoding);
}
/** The fingerprint of a token: never the token itself. */
function fingerprint(buf) {
  const t = (buf ? buf.toString('utf8') : '').trim();
  const hash = crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
  return `${t.startsWith('pat_') ? 'pat_' : 'NOT-pat_'} sha256:${hash} length:${t.length}`;
}

// ---------------------------------------------------------------- feed, sums, exe

function feedEntries(text) {
  return [...text.matchAll(/- url: '([^']+)'\r?\n\s+sha512: '([^']+)'\r?\n\s+size: (\d+)/g)].map((m) => ({ url: m[1], sha512: m[2], size: Number(m[3]) }));
}
function feed(o) {
  const [feedDir, filesDir] = o._;
  const { version, app, base } = o;
  for (const name of ['latest.yml', 'latest-mac.yml']) {
    const file = path.join(feedDir, name);
    if (!fs.existsSync(file)) { ok(false, `${name} is missing`); continue; }
    const data = fs.readFileSync(file);
    try {
      const v = verifyMinisign(data, fs.readFileSync(`${file}.sig`, 'utf8'), PUBLIK_UPDATE_PUBLIC_KEYS, { file: name });
      ok(v.keyId === KEY_ID, `${name}.sig verifies with the app's public key (key ${v.keyId}; ${v.trustedComment.replace(/\t/g, ' ')})`);
    } catch (e) {
      ok(false, `${name}.sig: ${e.message}`);
    }
    const text = data.toString('utf8');
    const field = (k) => (new RegExp(`^${k}: '([^']*)'`, 'm').exec(text) || [])[1];
    ok(field('version') === version, `${name}: version ${field('version')} (want ${version})`);
    ok(field('publikApp') === app, `${name}: publikApp ${field('publikApp')} (want ${app})`);
    const entries = feedEntries(text);
    ok(entries.length > 0 && field('path') === entries[0].url && field('sha512') === entries[0].sha512, `${name}: path/sha512 name the first of ${entries.length} file(s)`);
    const want = name === 'latest.yml' ? 1 : 4;
    ok(entries.length === want, `${name}: lists ${entries.length} file(s) (want ${want})`);
    for (const e of entries) {
      const fileName = decodeURIComponent(e.url.slice(base.length));
      ok(e.url.startsWith(base) && !fileName.includes('/') && fileName.includes(version), `${name}: absolute URL ${e.url}`);
      const local = path.join(filesDir, fileName);
      if (!fs.existsSync(local)) { console.log(`skip ${fileName} (not in ${filesDir} in this pass)`); continue; }
      const size = fs.statSync(local).size;
      ok(size === e.size && hashFile(local, 'sha512', 'base64') === e.sha512, `${fileName}: sha512 and size (${size}) = ${name}`);
    }
  }
}

function sums(o) {
  const [list, filesDir] = o._;
  for (const line of fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const [hash, name] = line.split(/\s+\*?/);
    const local = path.join(filesDir, name);
    if (!fs.existsSync(local)) { console.log(`skip ${name} (not in ${filesDir} in this pass)`); continue; }
    ok(hashFile(local, 'sha256', 'hex') === hash, `${name}: sha256 = SHA256SUMS.txt`);
  }
}

/** The values of the VS_VERSIONINFO strings (UTF-16, 32-bit aligned). */
function exe(o) {
  const data = fs.readFileSync(o._[0]);
  const found = {};
  for (const key of ['ProductName', 'ProductVersion', 'FileVersion']) {
    const k = Buffer.from(`${key}\0`, 'utf16le');
    const values = new Set();
    for (let i = data.indexOf(k); i >= 0; i = data.indexOf(k, i + 1)) {
      let j = i + k.length;
      while (j % 4) j++;
      let end = j;
      while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2;
      const v = data.subarray(j, end).toString('utf16le');
      if (v) values.add(v);
    }
    found[key] = [...values];
  }
  const same = (v) => v === o.version || v === `${o.version}.0`; // Windows writes x.y.z or x.y.z.0
  ok(found.ProductVersion.some(same), `${path.basename(o._[0])}: ProductVersion ${found.ProductVersion.join(', ') || '(none)'} (want ${o.version})`);
  ok(found.FileVersion.some(same), `${path.basename(o._[0])}: FileVersion ${found.FileVersion.join(', ') || '(none)'} (want ${o.version})`);
}

// ---------------------------------------------------------------- asar

/** The asar index and the offset of the file data, from the first bytes of an archive. */
function asarHeader(head) {
  if (head.length < 16) return null;
  const headerSize = head.readUInt32LE(4); // the size of the header pickle
  const jsonLength = head.readUInt32LE(12);
  if (head.length < 16 + jsonLength) return { need: 16 + jsonLength };
  return { index: JSON.parse(head.subarray(16, 16 + jsonLength).toString('utf8')), dataStart: 8 + headerSize };
}
function asarNode(index, inner) {
  let node = index;
  for (const part of inner.split('/')) node = node && node.files && node.files[part];
  return node && node.offset !== undefined && !node.unpacked ? node : null;
}
function asarFile(asar, inner) {
  const fd = fs.openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    const h = asarHeader(Buffer.concat([head, json]));
    const node = asarNode(h.index, inner);
    if (!node) return null;
    const out = Buffer.alloc(node.size);
    fs.readSync(fd, out, 0, node.size, h.dataStart + Number(node.offset));
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
function asar(o) {
  const file = o._[0];
  const pkg = JSON.parse((asarFile(file, 'package.json') || '{}').toString('utf8'));
  ok(pkg.version === o.version && pkg.publikUpdaterTest === undefined, `app.asar package.json: version ${pkg.version} (want ${o.version}), release build (no publikUpdaterTest)`);
  const updater = (asarFile(file, 'electron/publik-updater.cjs') || '').toString('utf8');
  ok(updater.includes("const FEED_BASE = 'https://publikhq.com/api/updates/';"), 'app.asar: electron/publik-updater.cjs with the publik feed');
  ok(asarFile(file, 'electron/publik-update-verify.cjs') !== null, 'app.asar: electron/publik-update-verify.cjs');
  const main = (asarFile(file, 'electron/main.mjs') || '').toString('utf8');
  ok(main.includes("startUpdates({ slug: 'ghost'"), "app.asar: electron/main.mjs starts the updater for slug 'ghost'");
  const fp = fingerprint(asarFile(file, TOKEN_FILE));
  ok(fp.startsWith('pat_ '), `app.asar: the publik app token is packed (${fp})`);
  if (o.token) ok(fp === o.token, `app.asar: the publik app token is the one of the last release (${o.token})`);
}

// ---------------------------------------------------------------- the token of a published zip, by range requests

async function range(url, start, end) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
      if (res.status !== 206) throw new Error(`GET ${url} bytes ${start}-${end}: HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}
async function rangeBuffer(url, start, end) {
  return Buffer.from(await (await range(url, start, end)).arrayBuffer());
}
async function zipMember(url, member) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!head.ok) throw new Error(`HEAD ${url}: HTTP ${head.status}`);
  const size = Number(head.headers.get('content-length'));
  const tailStart = Math.max(0, size - 65_557);
  const tail = await rangeBuffer(url, tailStart, size - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) { // ZIP64
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    if (loc < 0) throw new Error('no ZIP64 locator');
    const rec = await rangeBuffer(url, Number(tail.readBigUInt64LE(loc + 8)), Number(tail.readBigUInt64LE(loc + 8)) + 55);
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  const cd = await rangeBuffer(url, cdOffset, cdOffset + cdSize - 1);
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let local = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === member) {
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let q = 0; q + 4 <= extra.length;) { // ZIP64 extra field: the 64-bit sizes and offset
        const id = extra.readUInt16LE(q);
        const len = extra.readUInt16LE(q + 2);
        if (id === 1) {
          let r = q + 4;
          if (cd.readUInt32LE(p + 24) === 0xffffffff) r += 8;
          if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (local === 0xffffffff) local = Number(extra.readBigUInt64LE(r));
        }
        q += 4 + len;
      }
      const lh = await rangeBuffer(url, local, local + 29);
      const dataStart = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      return { method, compSize, dataStart };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${member} is not in the zip`);
}
/** Streams the member through inflate until the token file of the asar has been read; then stops. */
async function remoteToken(o) {
  const url = o._[0];
  const member = o._[1] || 'Ghost.app/Contents/Resources/app.asar';
  const m = await zipMember(url, member);
  if (m.method !== 8 && m.method !== 0) throw new Error(`compression method ${m.method}`);
  const res = await range(url, m.dataStart, m.dataStart + m.compSize - 1);
  const reader = res.body.getReader();
  const inflate = m.method === 8 ? zlib.createInflateRaw() : null;
  let got = Buffer.alloc(0);
  let want = null; // [start, end) of the token in the asar
  let result = null;
  const take = (chunk) => {
    got = Buffer.concat([got, chunk]);
    if (!want) {
      const h = asarHeader(got);
      if (!h || h.need) return;
      const node = asarNode(h.index, TOKEN_FILE);
      if (!node) { result = fingerprint(null); return; }
      want = [h.dataStart + Number(node.offset), h.dataStart + Number(node.offset) + node.size];
    }
    if (got.length >= want[1]) result = fingerprint(got.subarray(want[0], want[1]));
  };
  const done = new Promise((resolve, reject) => {
    if (!inflate) return resolve();
    inflate.on('data', (c) => { if (!result) take(c); if (result) resolve(); });
    inflate.on('error', (e) => (result ? resolve() : reject(e)));
    inflate.on('end', resolve);
  });
  while (!result) {
    const { value, done: end } = await reader.read();
    if (end) break;
    if (inflate) { if (!inflate.write(Buffer.from(value))) await new Promise((r) => inflate.once('drain', r)); }
    else take(Buffer.from(value));
    if (inflate && result) break;
  }
  if (inflate && !result) { inflate.end(); await done; }
  reader.cancel().catch(() => {});
  if (inflate) inflate.destroy();
  if (!result) throw new Error(`${TOKEN_FILE} was not found in ${member}`);
  console.log(result);
}

// ---------------------------------------------------------------- Mach-O files

function machoKind(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(32);
    if (fs.readSync(fd, head, 0, 32, 0) < 16) return null;
    const le = head.readUInt32LE(0);
    const be = head.readUInt32BE(0);
    if (le === 0xfeedfacf || le === 0xfeedface) return head.readUInt32LE(12) === 2 ? 'exec' : 'lib';
    if (be === 0xcafebabe || be === 0xcafebabf) { // fat: the file type of the first slice
      const n = head.readUInt32BE(4);
      if (!(n > 0 && n < 10)) return null; // a Java class file has the same magic
      const off = be === 0xcafebabe ? head.readUInt32BE(16) : Number(head.readBigUInt64BE(16));
      const sub = Buffer.alloc(16);
      fs.readSync(fd, sub, 0, 16, off);
      return sub.readUInt32LE(12) === 2 ? 'exec' : 'lib';
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
function macho(o) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const k = machoKind(p); if (k) out.push([p.split('/').length, k, p]); }
    }
  };
  walk(o._[0]);
  out.sort((a, b) => b[0] - a[0] || (a[2] < b[2] ? -1 : 1));
  for (const [, k, p] of out) console.log(`${k}\t${p}`);
}

// ---------------------------------------------------------------- records, feed, SHA256SUMS

function record(o) {
  const [file, dir] = o._;
  fs.mkdirSync(dir, { recursive: true });
  const r = { name: path.basename(file), sha256: hashFile(file, 'sha256', 'hex'), sha512: hashFile(file, 'sha512', 'base64'), size: fs.statSync(file).size };
  fs.writeFileSync(path.join(dir, `${r.name}.json`), `${JSON.stringify(r)}\n`);
  console.log(`${r.name}: sha256 ${r.sha256}, ${r.size} bytes`);
}
const readRecord = (dir, name) => {
  const f = path.join(dir, `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`no record of ${name} in ${dir}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
function writeFeed(o) {
  const { feedText } = require('./publik-update-feed.cjs');
  const { app, version, base, records, out } = o;
  if (!app || !version || !base || !records || !out) throw new Error('write-feed needs --app --version --base --records --out');
  const entry = (name) => { const r = readRecord(records, name); return { url: new URL(encodeURIComponent(name), base).href, sha512: r.sha512, size: r.size }; };
  const releaseDate = new Date().toISOString();
  const name = (arch, ext) => `Ghost-${version}-mac-${arch}.${ext}`;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'latest.yml'), feedText({ app, version, releaseDate, entries: [entry(`Ghost-${version}-win-x64.exe`)] }));
  fs.writeFileSync(path.join(out, 'latest-mac.yml'), feedText({ app, version, releaseDate,
    entries: [entry(name('arm64', 'zip')), entry(name('x64', 'zip')), entry(name('arm64', 'dmg')), entry(name('x64', 'dmg'))] }));
  console.log(`wrote ${path.join(out, 'latest.yml')} and ${path.join(out, 'latest-mac.yml')}`);
}
function sumsFile(o) {
  const [dir, out, ...names] = o._;
  const lines = [...names].sort().map((n) => `${readRecord(dir, n).sha256}  ${n}`);
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
const o = opts(rest);
const commands = {
  feed, sums, exe, asar, macho, record, 'write-feed': writeFeed, 'sums-file': sumsFile,
  token: () => console.log(fingerprint(asarFile(o._[0], TOKEN_FILE))),
  'win-token': () => {
    const [asarPath, installer] = o._;
    const r = { installer: path.basename(installer), sha256: hashFile(installer, 'sha256', 'hex'), token: fingerprint(asarFile(asarPath, TOKEN_FILE)) };
    fs.writeFileSync(o.out, `${JSON.stringify(r)}\n`);
    console.log(JSON.stringify(r));
    ok(r.token.startsWith('pat_ '), `the app that ${r.installer} installed carries the publik app token (${r.token})`);
  },
  'remote-token': remoteToken,
};
if (!commands[cmd]) {
  console.error('usage: publik-release-check.cjs feed|sums|exe|asar|token|remote-token|macho|record|write-feed|sums-file ... (see the top of this file)');
  process.exit(2);
}
Promise.resolve()
  .then(() => commands[cmd](o))
  .then(() => process.exit(failed ? 1 : 0), (e) => { console.error(`publik-release-check ${cmd}: ${e.message}`); process.exit(1); });
