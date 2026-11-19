#!/usr/bin/env node
// publik-update-feed.cjs — makes the signed update feed of a release (docs/updates.md).
//
//   write    latest.yml (Windows) and/or latest-mac.yml (macOS) for files on disk, with ABSOLUTE
//            download URLs (the GitHub release assets). --mac-zip and --mac-dmg may be given once per
//            Mac architecture (Ghost ships arm64 and x64 builds): electron-updater picks the zip whose
//            URL contains "arm64" on an Apple-chip Mac and the other zip on an Intel Mac.
//              node scripts/publik-update-feed.cjs write --app ghost --version 0.1.9 \
//                --download-base https://github.com/OWNER/REPO/releases/download/v0.1.9/ \
//                --win release/Ghost-0.1.9-win-x64.exe \
//                --mac-zip release/Ghost-0.1.9-mac-arm64.zip --mac-zip release/Ghost-0.1.9-mac-x64.zip \
//                --mac-dmg release/Ghost-0.1.9-mac-arm64.dmg --mac-dmg release/Ghost-0.1.9-mac-x64.dmg --out feed
//   sign     signs each file with the publik update key (writes <file>.sig), then verifies the signature
//            with the public key in publik-update-verify.cjs. The key comes from the environment:
//            PUBLIK_UPDATE_KEY (the private key as `tauri signer generate` wrote it) and
//            PUBLIK_UPDATE_KEY_PASSWORD. It is never printed.
//              node scripts/publik-update-feed.cjs sign feed/latest.yml feed/latest-mac.yml
//   verify   checks <file> against <file>.sig with the publik update public key (or --public-key).
//   release  the CI path (.github/workflows/update-feed.yml): for the GitHub release --tag, makes every
//            feed file that is missing (all of them with --force) from the installer files on the
//            release, signs it, verifies it and uploads it. Uses the gh CLI.
//              node scripts/publik-update-feed.cjs release --tag v0.1.9 --app ghost [--repo OWNER/REPO] [--version 0.1.9] [--force]
//
// A feed file is what electron-updater reads (version, files[] with url + sha512 + size, path, sha512,
// releaseDate), plus `publikApp: <slug>`: the app refuses a feed made for another app.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../electron/publik-update-verify.cjs');

const TAURI_CLI = '@tauri-apps/cli@2.12.4';

function die(msg) {
  console.error(`publik-update-feed: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let value = true;
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
      if (key in opts) opts[key] = [].concat(opts[key], value); // a repeated option (--mac-zip per arch)
      else opts[key] = value;
    } else opts._.push(a);
  }
  return opts;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // a YAML single-quoted string

function fileEntry(file, downloadBase) {
  const data = fs.readFileSync(file);
  const name = path.basename(file);
  return {
    name,
    url: new URL(encodeURIComponent(name), downloadBase).href,
    sha512: crypto.createHash('sha512').update(data).digest('base64'),
    size: data.length,
  };
}

/** The text of one feed file. The first entry is the one `path`/`sha512` name (electron-updater's legacy fields). */
function feedText({ app, version, entries, releaseDate }) {
  const lines = [`version: ${q(version)}`, `publikApp: ${q(app)}`, 'files:'];
  for (const e of entries) lines.push(`  - url: ${q(e.url)}`, `    sha512: ${q(e.sha512)}`, `    size: ${e.size}`);
  lines.push(`path: ${q(entries[0].url)}`, `sha512: ${q(entries[0].sha512)}`, `releaseDate: ${q(releaseDate)}`);
  return lines.join('\n') + '\n';
}

function checkName(file, version) {
  if (!path.basename(file).includes(version)) die(`${path.basename(file)} does not carry the version ${version}: is it the right file?`);
}

const list = (v) => (v === undefined || v === true ? [] : [].concat(v));
const isArm64 = (file) => path.basename(file).includes('arm64'); // electron-updater's own test (MacUpdater.filterFilesForArch)

/**
 * The Mac files of one kind (zip or dmg), at most one per architecture group electron-updater tells
 * apart: one file with "arm64" in its name, one without (x64 or universal). Two files in one group would
 * make the choice depend on their order in the feed.
 */
function macFiles(files, version, what) {
  for (const f of files) checkName(f, version);
  const arm = files.filter(isArm64);
  const other = files.filter((f) => !isArm64(f));
  if (arm.length > 1 || other.length > 1) die(`more than one ${what} for one Mac architecture: ${files.map((f) => path.basename(f)).join(', ')}`);
  return [...arm, ...other];
}

function write(opts) {
  const { app, version, out } = opts;
  const base = opts['download-base'];
  if (!app || !version || !base || !out) die('write needs --app, --version, --download-base and --out');
  if (!/^https:\/\//.test(base)) die('--download-base must be an https URL');
  const downloadBase = base.endsWith('/') ? base : `${base}/`;
  const releaseDate = opts['release-date'] || new Date().toISOString();
  fs.mkdirSync(out, { recursive: true });
  const written = [];
  if (opts.win) {
    checkName(opts.win, version);
    const text = feedText({ app, version, entries: [fileEntry(opts.win, downloadBase)], releaseDate });
    fs.writeFileSync(path.join(out, 'latest.yml'), text);
    written.push(path.join(out, 'latest.yml'));
  }
  const zips = macFiles(list(opts['mac-zip']), version, 'mac zip');
  const dmgs = macFiles(list(opts['mac-dmg']), version, 'mac dmg');
  if (zips.length) {
    // The zips first: Squirrel.Mac installs from a zip. Each architecture of a dmg needs its zip.
    for (const d of dmgs) if (!zips.some((z) => isArm64(z) === isArm64(d))) die(`${path.basename(d)} has no zip for its architecture`);
    const entries = [...zips, ...dmgs].map((f) => fileEntry(f, downloadBase));
    fs.writeFileSync(path.join(out, 'latest-mac.yml'), feedText({ app, version, entries, releaseDate }));
    written.push(path.join(out, 'latest-mac.yml'));
  } else if (dmgs.length) {
    die('--mac-dmg needs --mac-zip: macOS updates install from the zip');
  }
  if (!written.length) die('nothing to write: give --win and/or --mac-zip');
  for (const f of written) console.log(`publik-update-feed: wrote ${f}`);
  return written;
}

function publicKeyFrom(opts) {
  const k = opts['public-key'];
  if (!k || k === true) return PUBLIK_UPDATE_PUBLIC_KEYS;
  return fs.existsSync(k) ? fs.readFileSync(k, 'utf8') : k;
}

function verify(files, opts) {
  const key = publicKeyFrom(opts);
  for (const f of files) {
    const sigFile = `${f}.sig`;
    if (!fs.existsSync(sigFile)) die(`${sigFile} is missing`);
    try {
      const v = verifyMinisign(fs.readFileSync(f), fs.readFileSync(sigFile, 'utf8'), key, { file: path.basename(f) });
      console.log(`publik-update-feed: ${path.basename(sigFile)} OK (key ${v.keyId}, ${v.trustedComment.replace(/\t/g, ' ')})`);
    } catch (e) {
      die(`${path.basename(sigFile)} does not verify: ${e.message}`);
    }
  }
}

function sign(files, opts) {
  const key = process.env.PUBLIK_UPDATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY;
  const password = process.env.PUBLIK_UPDATE_KEY_PASSWORD ?? process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (!key) die('PUBLIK_UPDATE_KEY is not set');
  if (!password) die('PUBLIK_UPDATE_KEY_PASSWORD is not set');
  const env = { ...process.env, CI: 'true', TAURI_SIGNING_PRIVATE_KEY: key.trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  for (const f of files) {
    if (!fs.existsSync(f)) die(`${f} does not exist`);
    fs.rmSync(`${f}.sig`, { force: true });
    const r = spawnSync('npx', ['--yes', TAURI_CLI, 'signer', 'sign', f], { env, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    if (r.status !== 0 || !fs.existsSync(`${f}.sig`)) die(`signing ${f} failed (exit ${r.status})`);
  }
  verify(files, opts);
}

function gh(args, { json = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) die(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.status})`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

function release(opts) {
  const tag = opts.tag;
  const app = opts.app;
  const repo = opts.repo || process.env.GITHUB_REPOSITORY;
  if (!tag || !app || !repo) die('release needs --tag, --app and --repo (or GITHUB_REPOSITORY)');
  const version = opts.version || tag.replace(/^v/, ''); // --version: when the tag is not v<version>
  const rel = gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft'], { json: true });
  const names = rel.assets.map((a) => a.name);
  const one = (re, what) => {
    const hits = names.filter((n) => re.test(n) && n.includes(version));
    if (hits.length > 1) die(`more than one ${what} on ${tag}: ${hits.join(', ')}`);
    return hits[0];
  };
  const exe = one(/\.exe$/i, 'Windows installer');
  // Mac installers: <Name>-<version>-mac-<arch>.zip/.dmg, one per architecture (arm64, x64 or universal).
  const mac = (ext) => names.filter((n) => n.includes(version) && new RegExp(`-mac-(arm64|x64|universal)\\.${ext}$`, 'i').test(n));
  const zips = mac('zip');
  const dmgs = mac('dmg');
  const jobs = [];
  if (exe && (opts.force || !names.includes('latest.yml'))) jobs.push({ feed: 'latest.yml', files: [exe] });
  if (zips.length && (opts.force || !names.includes('latest-mac.yml'))) jobs.push({ feed: 'latest-mac.yml', zips, dmgs });
  if (!exe) console.log(`publik-update-feed: ${tag} has no Windows installer yet: no latest.yml`);
  if (!zips.length) console.log(`publik-update-feed: ${tag} has no mac zip yet: no latest-mac.yml (upload the zips, then run this again)`);
  else if (!names.includes('latest-mac.yml')) console.log(`publik-update-feed: mac zips on ${tag}: ${zips.join(', ')}`);
  if (!jobs.length) { console.log(`publik-update-feed: nothing to do for ${tag}`); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publik-feed-'));
  const bin = path.join(dir, 'assets');
  const out = path.join(dir, 'feed');
  const wanted = [...new Set(jobs.flatMap((j) => j.files || [...j.zips, ...j.dmgs]))];
  gh(['release', 'download', tag, '--repo', repo, '--dir', bin, ...wanted.flatMap((n) => ['--pattern', n])]);
  const w = { app, version, out, 'download-base': `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/` };
  for (const j of jobs) {
    if (j.feed === 'latest.yml') w.win = path.join(bin, j.files[0]);
    else { w['mac-zip'] = j.zips.map((n) => path.join(bin, n)); w['mac-dmg'] = j.dmgs.map((n) => path.join(bin, n)); }
  }
  const feeds = write(w);
  sign(feeds, opts);
  const upload = feeds.flatMap((f) => [f, `${f}.sig`]);
  gh(['release', 'upload', tag, '--repo', repo, '--clobber', ...upload]); // --clobber touches only the feed files
  console.log(`publik-update-feed: uploaded ${upload.map((f) => path.basename(f)).join(', ')} to ${tag}${rel.isDraft ? ' (draft)' : ''}`);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (cmd === 'write') write(opts);
  else if (cmd === 'sign') sign(opts._, opts);
  else if (cmd === 'verify') verify(opts._, opts);
  else if (cmd === 'release') release(opts);
  else die('usage: publik-update-feed.cjs write|sign|verify|release ... (see the top of this file)');
}

module.exports = { feedText, fileEntry, write };
