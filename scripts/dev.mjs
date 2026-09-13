import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
const childEnv = { ...process.env, GHOST_DEV_URL: 'http://127.0.0.1:5173' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: childEnv });
child.on('exit', async code => { await server.close(); process.exit(code ?? 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
