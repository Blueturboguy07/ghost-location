// Runs the gate of the publik module (electron/publik.mjs) with a scripted UI, for
// tests/publik.test.mjs. It prints one JSON line per event on stdout.
//   GATE_PRESS: the buttons to press, in order (for example "sign_in"); then it waits.
//   GATE_EXIT_ON: a screen id; the driver exits when that screen shows.
import { writeSync } from 'node:fs';

// Plain Node on Windows can stop with a libuv assertion (exit code 3221226505) when process.exit()
// runs while a fetch socket still closes. Electron, where the module runs in Ghost, does not have
// this fault (CI runs the self-test of the installed Windows app). Here process.exit() keeps the
// exit code and the process ends by itself when nothing is left to run.
if (process.platform === 'win32') process.exit = code => { process.exitCode = code ?? 0; };

const { ensureSignedIn } = await import('../../electron/publik.mjs');
const press = String(process.env.GATE_PRESS || '').split(',').filter(Boolean);
// writeSync: a pipe on macOS and Windows is written later, and process.exit() would drop the line.
const out = value => writeSync(1, `${JSON.stringify(value)}\n`);

const ui = {
  show(screen) {
    out({ screen });
    if (process.env.GATE_EXIT_ON === screen.id) process.exit(0);
    const action = press.shift();
    return action ? Promise.resolve(action) : new Promise(() => {});
  },
  openUrl(url) { out({ openUrl: url }); }
};

// Not a top-level await: a gate that never resolves (a screen that waits) must not end the
// module with exit code 13 ("unsettled top-level await").
ensureSignedIn(ui).then(gate => {
  out({ result: { claim_state: gate.wallet.claim_state, choice: gate.choice, key: gate.key.startsWith('pk_') ? 'pk_' : 'other' } });
  setTimeout(() => process.exit(0), Number(process.env.STAY_MS || 1500));
});
