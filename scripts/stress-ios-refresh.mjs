/** Hardware-free end-to-end iOS refresh stress test. Uses the real adapter, JSONL
 * loop, Bridge and upstream LocationSimulation; only USB/tunnel/DVT peer are fake.
 * Build the local sidecar venv first: npm run runtime:ios.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { IosAdapter } from '../backend/ios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = path.join(root, 'sidecar');
const python = path.join(sidecar, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) throw new Error('Build the local Python runtime first: npm run runtime:ios');
const reportPath = path.join(root, 'artifacts', 'ios-refresh-stress-report.json');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'ghost-ios-stress-'));
const fakePath = path.join(scratch, 'fake_ios_peer.py');
const fakePeer = String.raw`"""Hardware-free stress seam: real Bridge/main/LocationSimulation, fake USB/DVT peer."""
import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import ios_bridge as module

SERIAL = "00008030-0000000000000001"
started = time.monotonic()
call_count = 0
inflight = 0
probe_count = 0

def trace(event, **values):
    print(json.dumps({"trace": event, "elapsed": round(time.monotonic() - started, 4), **values}), file=sys.stderr, flush=True)

class FakePeer:
    async def simulate_location_with_latitude_longitude_(self, latitude, longitude):
        global call_count, inflight
        inflight += 1
        assert inflight == 1, "overlapping DVT location operations"
        await asyncio.sleep(0.02)
        call_count += 1
        trace("dvt-ack", call=call_count, latitude=latitude, longitude=longitude)
        inflight -= 1
    async def stop_location_simulation(self):
        assert inflight == 0
        trace("dvt-clear")

class FakeDTX:
    def __init__(self):
        self._closed = False
        self.disconnected = asyncio.Event()
        self.peer = FakePeer()
    def register_service(self, service_class):
        assert service_class.IDENTIFIER == "com.apple.instruments.server.services.LocationSimulation"
    async def open_channel(self, service_class):
        self.register_service(service_class)
        return self.peer
    async def wait_disconnected(self):
        trace("watcher-start")
        await self.disconnected.wait()
        trace("watcher-disconnected")

class FakeDvt:
    def __init__(self, rsd):
        assert rsd.udid == SERIAL
        self.dtx = FakeDTX()
    async def connect(self):
        pass
    async def __aenter__(self):
        trace("dvt-open")
        return self
    async def __aexit__(self, *args):
        self.dtx._closed = True
        self.dtx.disconnected.set()
        trace("dvt-close")

class FakeTunnel:
    def __init__(self, *, serial, autopair, remotepairing_fallback):
        assert serial == SERIAL and not autopair and not remotepairing_fallback
        self.rsd = SimpleNamespace(udid=serial)
    async def __aenter__(self):
        return self.rsd
    async def __aexit__(self, *args):
        self.rsd = None
        trace("tunnel-close")

class FakeLockdown:
    all_values = {"DeviceName": "Stress fake iPhone"}
    product_type = "iPhoneFake"
    product_version = "26.0"
    paired = True
    async def __aenter__(self):
        global probe_count
        probe_count += 1
        trace("usb-probe-start", probe=probe_count)
        if probe_count == 1:
            # Slower than the reported five-second failure, while DVT stays healthy.
            await asyncio.sleep(6.25)
        trace("usb-probe-end", probe=probe_count)
        return self
    async def __aexit__(self, *args):
        pass
    async def get_developer_mode_status(self):
        return True

async def fake_lockdown(serial, autopair=False):
    assert serial == SERIAL
    return FakeLockdown()
async def fake_list_devices():
    return [SimpleNamespace(serial=SERIAL, connection_type="USB")]
async def fake_prepare(self, serial):
    assert serial == SERIAL
    return {"ready": True}

module.usb_lockdown = fake_lockdown
module.usbmux.list_devices = fake_list_devices
module.Bridge.prepare = fake_prepare
module.userspace_tunnel.UserspaceRsdTunnel = FakeTunnel
module.DvtProvider = FakeDvt
# Deliberately retain upstream LocationSimulation and the real Bridge/main loop.
asyncio.run(module.main())
`;
await writeFile(fakePath, fakePeer);
const traces = [], wire = [], refreshes = [], ended = [];
const runner = () => {
  const child = spawn(python, ['-u', fakePath, sidecar], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  createInterface({ input: child.stdout }).on('line', (line) => { try { wire.push(JSON.parse(line)); } catch {} });
  createInterface({ input: child.stderr }).on('line', (line) => { try { traces.push(JSON.parse(line)); } catch { console.error(line); } });
  return child;
};
const adapter = new IosAdapter({ runner, onLocationRefresh: (event) => refreshes.push(event), onSessionEnd: (event) => ended.push(event) });
const device = { id: 'ios:00008030-0000000000000001', serial: '00008030-0000000000000001', platform: 'ios', connection: 'usb' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeout, explanation) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, explanation);
    await sleep(25);
  }
}
let initial, update, passed = false, failure;
try {
  initial = await adapter.set(device, { latitude: 37.3317, longitude: -122.0301, sessionId: 'stress-initial' });
  await sleep(100);
  const cached = await adapter.list();
  assert.equal(cached[0].id, device.id);
  assert.equal(traces.filter((event) => event.trace === 'usb-probe-start').length, 0,
    'Healthy-stream device listing opened an unnecessary USB probe.');
  // Exercise low-level discovery separately: normal healthy-stream polls use
  // the cache, but an explicit USB probe must still leave DVT refreshing.
  const poll = adapter.request('discover'); // This probe intentionally takes 6.25 seconds.
  poll.catch(() => {}); // Keep an early poll failure observable at await below, without an unhandled rejection.
  // Observe ten actual acknowledgements, including the initial set, at real 1 s cadence.
  // A bounded deadline tolerates scheduler jitter without shortening the observation.
  await waitUntil(() => refreshes.filter((event) => event.sessionId === 'stress-initial').length >= 9,
    15000, 'Initial target did not receive ten acknowledgements within 15 seconds.');
  assert.equal((await poll)[0].state, 'ready');
  assert.equal(adapter.activeDeviceId, device.id);
  assert.equal(ended.length, 0);
  update = await adapter.set(device, { latitude: 40.7128, longitude: -74.0060, sessionId: 'stress-updated' });
  await waitUntil(() => refreshes.filter((event) => event.sessionId === 'stress-updated').length >= 3,
    5000, 'Updated target did not continue refreshing.');
  assert.equal(ended.length, 0);
  await adapter.clear(device);
  const countAtClear = traces.filter((event) => event.trace === 'dvt-ack').length;
  await sleep(1250);
  assert.equal(traces.filter((event) => event.trace === 'dvt-ack').length, countAtClear, 'Location commands continued after clear.');
  assert.equal(traces.filter((event) => event.trace === 'dvt-clear').length, 1);
  assert.equal(traces.filter((event) => event.trace === 'dvt-open').length, 1);
  assert.equal(traces.filter((event) => event.trace === 'dvt-close').length, 1);
  const acknowledgements = traces.filter((event) => event.trace === 'dvt-ack');
  assert.ok(acknowledgements.filter((event) => event.latitude === 37.3317).length >= 10);
  assert.ok(acknowledgements.filter((event) => event.latitude === 40.7128).length >= 4);
  assert.ok(acknowledgements.some((event) => event.elapsed > 8 && event.latitude === 37.3317), 'No initial-target acknowledgement beyond eight seconds.');
  const pollStart = traces.find((event) => event.trace === 'usb-probe-start').elapsed;
  const pollEnd = traces.find((event) => event.trace === 'usb-probe-end').elapsed;
  assert.ok(pollEnd - pollStart >= 6, 'The discovery overlap was too short.');
  // Four or more completed calls under concurrent test-runner load proves the
  // six-second discovery did not serialize the one-second refresh task.
  assert.ok(acknowledgements.filter((event) => event.elapsed > pollStart && event.elapsed < pollEnd).length >= 4,
    'Discovery blocked periodic DVT acknowledgements.');
  assert.equal(acknowledgements.length, refreshes.length + 2, 'An acknowledged refresh was lost or duplicated.');
  assert.ok(refreshes.every((event) => event.source === 'command-ack'));
  assert.equal(initial.refreshCount, 1);
  assert.equal(update.refreshCount, 1);
  passed = true;
} catch (error) {
  failure = error.stack || error.message;
  throw error;
} finally {
  try {
    await adapter.dispose({ restore: false });
  } catch (error) {
    passed = false;
    failure = failure || error.stack || error.message;
    throw error;
  } finally {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ passed, failure, initial, update, ended,
      acknowledgements: traces.filter((event) => event.trace === 'dvt-ack'), refreshes, traces, wire }, null, 2));
    await rm(scratch, { recursive: true, force: true });
  }
}
console.log(`PASS: ${traces.filter((event) => event.trace === 'dvt-ack').length} acknowledged DVT calls; ${refreshes.length} refresh callbacks; discovery overlapped; clear stopped the loop.`);
console.log(`Report: ${reportPath}`);
