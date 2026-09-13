import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

/** Run a native executable without interpreting any argument as shell syntax. */
export function run(file, args = [], options = {}) {
  const {timeoutMs = 15_000, env = {}, cwd, signal, maxOutputBytes = 2 * 1024 * 1024, input} = options;
  if (typeof file !== 'string' || !file || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return Promise.reject(new TypeError('Executable and arguments must be strings.'));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('Invalid process timeout.'));
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Process cancelled.'), {code: 'ABORT_ERR'}));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {cwd, env: {...process.env, ...env}, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    } catch (error) { reject(error); return; }
    let stdout = '', stderr = '', bytes = 0, settled = false, failure;
    const decoders = {stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8')};
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      if (error) reject(Object.assign(error, {stdout, stderr}));
      else resolve({...result, stdout, stderr});
    };
    let killTimer;
    const stop = error => {
      if (failure || settled) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); finish(failure); }, 500);
      killTimer.unref?.();
    };
    const abort = () => stop(Object.assign(new Error('Process cancelled.'), {code: 'ABORT_ERR'}));
    const timer = setTimeout(() => stop(Object.assign(new Error(`Command timed out after ${timeoutMs} ms.`), {code: 'ETIMEDOUT'})), timeoutMs);
    const append = key => data => {
      bytes += data.length;
      if (bytes > maxOutputBytes) {
        stop(Object.assign(new Error('Command output exceeded the allowed size.'), {code: 'EOUTPUTLIMIT'}));
        return;
      }
      if (key === 'stdout') stdout += decoders.stdout.write(data);
      else stderr += decoders.stderr.write(data);
    };
    child.stdout.on('data', append('stdout'));
    child.stderr.on('data', append('stderr'));
    child.on('error', error => finish(error));
    child.on('close', (code, termSignal) => {
      if (failure) finish(failure);
      else if (termSignal) finish(Object.assign(new Error(`Command stopped by ${termSignal}.`), {code: 'ESIGNAL'}));
      else finish(null, {stdout, stderr, code: code ?? 1});
    });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    // A process that exits before consuming input can close stdin normally.
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdin.end(input);
  });
}
