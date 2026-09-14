import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Persistent, private stdio bridge. No shell, network listener, or implicit device selection. */
export class IosAdapter {
  constructor({ rootPath, resourcesPath, runner, onSessionEnd = () => {}, onLocationRefresh = () => {}, now = () => Date.now() } = {}) {
    this.rootPath = rootPath ?? process.cwd();
    this.resourcesPath = resourcesPath ?? path.join(this.rootPath, 'resources');
    this.runner = runner ?? spawn;
    this.onSessionEnd = onSessionEnd;
    this.onLocationRefresh = onLocationRefresh;
    this.now = now;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.activeDeviceId = null;
    this.target = null;
    this.activeTarget = null;
    this.targetGeneration = 0;
    this.cachedDevice = null;
    this.lastAcknowledgementAt = null;
    this.disposing = false;
    this.closed = false;
    this.queue = Promise.resolve();
    this.stderr = '';
  }

  runtime() {
    const executable = process.platform === 'win32' ? 'ghost-ios.exe' : 'ghost-ios';
    const bundled = path.join(this.resourcesPath, 'ios', `${process.platform}-${process.arch}`, 'ghost-ios', executable);
    if (existsSync(bundled)) return { command: bundled, args: [] };
    const python = path.join(this.rootPath, 'sidecar', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const script = path.join(this.rootPath, 'sidecar', 'ios_bridge.py');
    if (existsSync(python) && existsSync(script)) return { command: python, args: ['-u', script] };
    if (this.runner !== spawn) return { command: 'ghost-ios-test', args: [] };
    throw new Error('iPhone support is not installed. Build the bundled iOS sidecar with npm run runtime:ios.');
  }

  start(allowDuringDispose = false) {
    if (this.closed || (this.disposing && !allowDuringDispose)) throw new Error('iPhone adapter is shutting down.');
    if (this.child) return;
    const { command, args } = this.runtime();
    const child = this.runner(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    this.stderr = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'location-refreshed') {
        const target = this.target;
        if (this.disposing || !target?.acknowledged || !this.matchesTarget(message, target) ||
            message.latitude !== target.latitude || message.longitude !== target.longitude ||
            !Number.isInteger(message.refreshCount) || message.refreshCount <= target.refreshCount ||
            typeof message.refreshedAt !== 'string' || !Number.isFinite(Date.parse(message.refreshedAt))) return;
        target.refreshCount = message.refreshCount;
        this.lastAcknowledgementAt = Math.min(this.now(), Date.parse(message.refreshedAt));
        this.onLocationRefresh({ deviceId: message.deviceId, sessionId: message.sessionId,
          latitude: message.latitude, longitude: message.longitude, refreshedAt: message.refreshedAt,
          refreshCount: message.refreshCount, refreshIntervalMs: message.refreshIntervalMs, source: 'command-ack' });
        return;
      }
      if (message.event === 'session-ended') {
        const target = this.target ?? this.activeTarget;
        if (!target || !this.matchesTarget(message, target, true)) return;
        target.endError = message.error || 'iPhone connection ended; location state is unknown.';
        this.target = null;
        this.activeTarget = null;
        this.invalidateDeviceCache();
        if (this.activeDeviceId === message.deviceId) this.activeDeviceId = null;
        this.onSessionEnd({ deviceId: message.deviceId, ...(target.sessionId ? { sessionId: target.sessionId } : {}), error: target.endError });
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok === true) request.resolve(message.result);
      else request.reject(new Error(message.error || 'The iPhone operation failed.'));
    });
    child.stderr.on('data', (data) => { this.stderr = (this.stderr + data.toString()).slice(-3000); });
    const ended = (reason) => {
      if (this.child !== child) return;
      this.child = null;
      lines.close();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(reason));
      }
      this.pending.clear();
      const deviceId = this.activeDeviceId;
      const target = this.target ?? this.activeTarget;
      if (target) target.endError = reason;
      this.target = null;
      this.activeTarget = null;
      this.invalidateDeviceCache();
      this.activeDeviceId = null;
      if (deviceId) this.onSessionEnd({ deviceId, ...(target?.sessionId ? { sessionId: target.sessionId } : {}),
        error: `${reason} Location state is unknown; reconnect to restore it.` });
    };
    this.endChild = ended;
    child.once('error', (error) => ended(`Cannot start iPhone support: ${error.message}`));
    child.once('exit', (code, signal) => ended(`iPhone support exited (${signal || (code ?? 'unknown')}).${this.stderr ? ` ${this.stderr.trim()}` : ''}`));
  }

  matchesTarget(message, target, allowLegacy = false) {
    return message.deviceId === target.deviceId &&
      (message.sessionId ?? null) === (target.sessionId ?? null) &&
      (message.generation === target.generation || (allowLegacy && message.generation == null && target.sessionId == null));
  }

  invalidateDeviceCache() {
    this.cachedDevice = null;
    this.lastAcknowledgementAt = null;
  }

  terminate(reason) {
    const child = this.child;
    if (!child) return;
    // Detach synchronously: the request queue must never reuse a process that
    // has timed out while waiting for its asynchronous exit event.
    this.endChild(reason);
    child.kill();
    const force = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    force.unref();
    child.once('exit', () => clearTimeout(force));
  }

  request(method, params = {}, timeout = 30000) {
    const operation = this.queue.then(() => this.sendRequest(method, params, timeout));
    this.queue = operation.catch(() => {});
    return operation;
  }

  sendRequest(method, params, timeout) {
    try { this.start(method === 'shutdown'); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const child = this.child;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`iPhone ${method} timed out; no success was confirmed.`));
        // Never leave a timed-out set request free to execute later in the background.
        this.terminate(`iPhone ${method} timed out; location state is unknown.`);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  deviceParams(device) {
    if (!device || device.platform !== 'ios' || device.connection !== (this.connection || 'usb') ||
        typeof device.serial !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(device.serial) ||
        device.id !== `ios:${device.serial}`) throw new Error('Select an iPhone on the current USB or Wi-Fi connection.');
    return { udid: device.serial, ...(device.connection === 'wifi' ? {connection: 'wifi'} : {}) };
  }

  async status() {
    try { return await this.request('status', {}, 15000); }
    catch (error) { return { available: false, message: error.message }; }
  }
  async list() {
    const age = this.now() - this.lastAcknowledgementAt;
    if (this.cachedDevice && this.cachedDevice.connection === (this.connection || 'usb') && this.lastAcknowledgementAt !== null && age >= 0 && age <= 5000) {
      // A fresh reply on the persistent USB DVT stream is stronger evidence of
      // this selected phone's presence than another independent lockdown probe.
      return [{ ...this.cachedDevice, state: 'ready', detail: `${this.cachedDevice.connection === 'wifi' ? 'Wi-Fi' : 'USB'} connection confirmed by location command acknowledgements.` }];
    }
    const devices = await this.request('discover', {connection: this.connection || 'usb'});
    return devices.filter((device) => device.platform === 'ios' && device.connection === (this.connection || 'usb'));
  }
  async prepareWifi(device) {
    await this.enableWifi(device);
    const devices = await this.request('discover', {connection: 'wifi'}, 15000);
    const wireless = devices.find(item => item.id === device.id && item.connection === 'wifi' && item.state === 'ready');
    if (!wireless) throw new Error('Your iPhone is not reachable on Wi-Fi yet. Keep it unlocked on the same network, then try again.');
    return wireless;
  }
  async enableWifi(device) {
    if (device.connection !== 'usb') throw new Error('Connect this iPhone by USB to enable Wi-Fi.');
    return this.request('enable-wifi', this.deviceParams(device), 60_000);
  }
  async prepare(device) { return this.request('prepare', this.deviceParams(device), 180000); }
  async set(device, { latitude, longitude, sessionId = null, reconnecting = false }) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new Error('Latitude or longitude is invalid.');
    }
    const params = this.deviceParams(device);
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 200)) throw new Error('Location session identifier is invalid.');
    const target = { deviceId: device.id, latitude, longitude, sessionId, generation: ++this.targetGeneration,
      acknowledged: false, refreshCount: 0 };
    this.target = target;
    try {
      const result = await this.request('set', { ...params, latitude, longitude, sessionId, generation: target.generation }, reconnecting ? 20000 : 60000);
      if (result?.applied !== true) throw new Error('The iPhone did not acknowledge the location update.');
      if (target.endError) throw new Error(target.endError);
      if (this.target === target && !this.disposing) {
        target.acknowledged = true;
        target.refreshCount = result.refreshCount ?? 1;
        this.activeDeviceId = device.id;
        this.activeTarget = target;
        this.cachedDevice = { ...device };
        const acknowledgedAt = Date.parse(result.refreshedAt);
        this.lastAcknowledgementAt = Number.isFinite(acknowledgedAt) ? Math.min(this.now(), acknowledgedAt) : this.now();
      }
      return result;
    } catch (error) {
      if (this.target === target) {
        this.target = null;
        this.activeTarget = null;
        this.activeDeviceId = null;
        this.invalidateDeviceCache();
      }
      throw error;
    }
  }
  async clear(device) {
    const params = this.deviceParams(device);
    this.target = null;
    this.invalidateDeviceCache();
    const result = await this.request('clear', params, 30000);
    if (result?.cleared !== true) throw new Error('The iPhone did not acknowledge the restore command.');
    if (this.activeDeviceId === device.id) this.activeDeviceId = null;
    this.activeTarget = null;
    return result;
  }
  async update(device, point) {
    if (this.activeDeviceId !== device.id || this.activeTarget?.sessionId !== point.sessionId) throw new Error('The iPhone route session is no longer active. Reconnect this phone.');
    return this.set(device, { ...point, reconnecting: true });
  }
  async reset(device) {
    const params = this.deviceParams(device);
    if (this.activeDeviceId && this.activeDeviceId !== device.id) throw new Error('The selected iPhone does not own the current USB session.');
    this.target = null;
    this.activeTarget = null;
    this.activeDeviceId = null;
    this.invalidateDeviceCache();
    if (!this.child) return { reset: true };
    try {
      const result = await this.request('reset', params, 10000);
      if (result?.reset !== true) throw new Error('The iPhone transport did not acknowledge its reset.');
      return result;
    } catch (error) {
      if (this.disposing || this.closed) throw error;
      // Recreate the sidecar if stale upstream cleanup itself cannot complete.
      // Terminating transport is not a location restore or a promise of persistence.
      this.terminate(`iPhone transport reset: ${error.message}`);
      return { reset: true, restarted: true };
    }
  }
  async dispose({ restore = true } = {}) {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    this.target = null;
    this.invalidateDeviceCache();
    this.disposePromise = (async () => {
      let timer;
      try {
        if (this.child) {
          await Promise.race([
            this.request('shutdown', { restore: restore !== false }, 14000),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('iPhone shutdown timed out; location state is unknown.')), 15000); }),
          ]);
          this.activeDeviceId = null;
          this.activeTarget = null;
        }
      } finally {
        clearTimeout(timer);
        this.closed = true;
        this.terminate('iPhone support closed; location state is unknown unless a restore command completed.');
      }
    })();
    return this.disposePromise;
  }
}
