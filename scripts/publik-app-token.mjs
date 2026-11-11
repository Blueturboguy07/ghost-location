// Writes electron/publik-app-token.txt from the PUBLIK_APP_TOKEN environment variable, for a
// release build. The publik module (electron/publik.mjs) reads this file in the packaged app
// (electron-builder packs electron/** into app.asar), so a new install can set up its sign-in.
// The file is in .gitignore: it is never committed. This script never prints the token.
//
// usage: node scripts/publik-app-token.mjs [--require]
//   --require: stop with exit code 1 when PUBLIK_APP_TOKEN is not an app token (pat_...).
//   Without it, a missing token only removes an old file: the build then has no app token, and
//   the gate says "This build has no publik app token. Ask the developer for a new build."
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'electron', 'publik-app-token.txt');
const required = process.argv.includes('--require');
const token = String(process.env.PUBLIK_APP_TOKEN || '').trim();

if (!token.startsWith('pat_')) {
  rmSync(file, { force: true });
  const message = 'PUBLIK_APP_TOKEN is not set or is not a publik app token (pat_...). This build has no publik app token.';
  if (required) { console.error(message); process.exit(1); }
  console.log(message);
  process.exit(0);
}
writeFileSync(file, `${token}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log('publik app token: written to electron/publik-app-token.txt (not printed).');
