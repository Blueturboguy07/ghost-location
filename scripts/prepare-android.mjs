import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {run} from '../backend/process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Pinned official archive metadata from Google's repository2-1.xml, 2026-09-13.
// Google publishes SHA-1 here; also record SHA-256 for every artifact we package.
const TOOLS = {
  darwin: {file: 'platform-tools_r37.0.1-darwin.zip', sha1: '6ae73f4de6452dc57e62ec02b68eed92a4c21661', size: 16110554},
  win32: {file: 'platform-tools_r37.0.1-win.zip', sha1: 'e03e78b1d80b396f1c3358e31251cb31740e1110', size: 8044989},
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const option = (name, fallback) => {
  const joined = process.argv.find(arg => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};

async function prepareApk() {
  let packageFile;
  try { packageFile = require.resolve('io.appium.settings/package.json'); }
  catch { throw new Error('Install the pinned io.appium.settings npm dependency first.'); }
  const packageRoot = path.dirname(packageFile);
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const requested = project.dependencies?.['io.appium.settings'] ?? project.devDependencies?.['io.appium.settings'];
  if (requested !== metadata.version) throw new Error(`Pin io.appium.settings to exactly ${metadata.version} in package.json before packaging its APK.`);
  const source = path.join(packageRoot, 'apks', 'settings_apk-debug.apk');
  const bytes = await readFile(source);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('The Android helper APK is not a ZIP/APK archive.');
  const destination = path.join(root, 'resources', 'android');
  await mkdir(destination, {recursive: true});
  await copyFile(source, path.join(destination, 'settings.apk'));
  const notices = [];
  for (const name of ['LICENSE', 'LICENSE.txt', 'NOTICE.txt']) {
    try { await copyFile(path.join(packageRoot, name), path.join(destination, name)); notices.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!notices.some(name => name.startsWith('LICENSE'))) throw new Error('The Appium Settings license file is missing from the npm package.');
  await writeFile(path.join(destination, 'provenance.json'), `${JSON.stringify({name: 'io.appium.settings', version: metadata.version, source: 'https://github.com/appium/io.appium.settings', license: 'Apache-2.0', apkSha256: sha256(bytes), notices}, null, 2)}\n`);
  console.log(`Prepared Appium Settings ${metadata.version} (${bytes.length} bytes).`);
}

async function prepareAdb(platform, arch) {
  const archive = TOOLS[platform];
  if (!archive || !['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) {
    throw new Error('Supported ADB package targets: darwin-arm64, darwin-x64 and win32-x64.');
  }
  const url = `https://dl.google.com/android/repository/${archive.file}`;
  const temp = await mkdtemp(path.join(tmpdir(), 'ghost-android-'));
  try {
    console.log(`Downloading pinned Android Platform Tools 37.0.1 for ${platform}-${arch}…`);
    const response = await fetch(url, {signal: AbortSignal.timeout(90_000)});
    if (!response.ok) throw new Error(`Platform Tools download failed (HTTP ${response.status}).`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > archive.size) { await reader.cancel(); throw new Error('Platform Tools archive exceeded its pinned size.'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== archive.size || createHash('sha1').update(bytes).digest('hex') !== archive.sha1) throw new Error('Platform Tools archive failed its pinned checksum or size check.');
    const archivePath = path.join(temp, 'platform-tools.zip');
    await writeFile(archivePath, bytes);
    const extracted = path.join(temp, 'extracted');
    await mkdir(extracted);
    let extract;
    if (process.platform === 'win32') {
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      extract = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(extracted)} -ErrorAction Stop`], {timeoutMs: 60_000});
    } else {
      extract = await run('/usr/bin/unzip', ['-q', archivePath, '-d', extracted], {timeoutMs: 60_000});
    }
    if (extract.code !== 0) throw new Error(`Could not extract ADB: ${extract.stderr || extract.stdout}`);
    const source = path.join(extracted, 'platform-tools');
    const destination = path.join(root, 'resources', 'adb', `${platform}-${arch}`);
    await mkdir(destination, {recursive: true});
    const packaged = [];
    for (const entry of await readdir(source, {withFileTypes: true})) {
      if (!entry.isFile() || !/^(adb(?:\.exe)?|.*\.dll|.*\.dylib|NOTICE\.txt|source\.properties)$/.test(entry.name)) continue;
      const content = await readFile(path.join(source, entry.name));
      await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
      if (entry.name === 'adb') await chmod(path.join(destination, entry.name), 0o755);
      packaged.push({file: entry.name, sha256: sha256(content)});
    }
    const adbName = platform === 'win32' ? 'adb.exe' : 'adb';
    if (!packaged.some(item => item.file === adbName) || !packaged.some(item => item.file === 'NOTICE.txt')) throw new Error('ADB executable or its license notices were absent from the official archive.');
    await writeFile(path.join(destination, 'provenance.json'), `${JSON.stringify({version: '37.0.1', platform, arch, source: url, metadataSource: 'https://dl.google.com/android/repository/repository2-1.xml', archiveSha1: archive.sha1, archiveSha256: sha256(bytes), files: packaged}, null, 2)}\n`);
    if (platform === process.platform) {
      const version = await run(path.join(destination, adbName), ['version']);
      if (version.code !== 0 || !version.stdout.includes('Android Debug Bridge')) throw new Error(`Packaged ADB cannot run: ${version.stderr || version.stdout}`);
      console.log(version.stdout.trim());
    }
    console.log(`Prepared ADB and notices for ${platform}-${arch}.`);
  } finally { await rm(temp, {recursive: true, force: true}); }
}

try {
  if (!process.argv.includes('--skip-apk')) await prepareApk();
  if (!process.argv.includes('--skip-adb')) await prepareAdb(option('--platform', process.platform), option('--arch', process.arch));
} catch (error) {
  console.error(`Android resource preparation failed: ${error.message}`);
  process.exitCode = 1;
}
