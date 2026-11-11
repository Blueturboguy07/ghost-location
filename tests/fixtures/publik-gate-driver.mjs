// Runs the gate of the publik module (electron/publik.mjs) with a scripted UI, for
// tests/publik.test.mjs. It prints one JSON line per event on stdout.
//   GATE_PRESS: the buttons to press, in order (for example "sign_in"); then it waits.
//   GATE_EXIT_ON: a screen id; the driver exits when that screen shows.
import { writeSync } from 'node:fs';

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

const gate = await ensureSignedIn(ui);
out({ result: { claim_state: gate.wallet.claim_state, choice: gate.choice, key: gate.key.startsWith('pk_') ? 'pk_' : 'other' } });
setTimeout(() => process.exit(0), Number(process.env.STAY_MS || 1500));
