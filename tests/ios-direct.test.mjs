import test from 'node:test';
import assert from 'node:assert/strict';
import { IosAdapter } from '../backend/ios.mjs';

const udid = '00008030-0000000000000001';
const phone = connection => ({ id: `ios:${udid}`, serial: udid, platform: 'ios', name: 'iPhone', connection, state: 'ready' });

function adapter() {
  const ios = new IosAdapter({ runner: () => { throw new Error('no process in this test'); } });
  ios.requests = [];
  ios.request = async (method, params) => { ios.requests.push([method, params]); return method === 'discover' ? [phone(params.connection)] : {}; };
  return ios;
}

test('a saved address is sent only for Wi-Fi requests to the matching iPhone', async () => {
  const ios = adapter();
  ios.setDirect({ host: '100.64.0.2', udid });
  ios.connection = 'wifi';
  assert.deepEqual(ios.deviceParams(phone('wifi')), { udid, connection: 'wifi', host: '100.64.0.2' });
  await ios.list();
  assert.deepEqual(ios.requests.at(-1), ['discover', { connection: 'wifi', host: '100.64.0.2', hostUdid: udid }]);
  ios.connection = 'usb';
  assert.deepEqual(ios.deviceParams(phone('usb')), { udid });
  await ios.list();
  assert.deepEqual(ios.requests.at(-1), ['discover', { connection: 'usb' }]);
  ios.connection = 'wifi';
  const other = { ...phone('wifi'), id: 'ios:00008030-0000000000000002', serial: '00008030-0000000000000002' };
  assert.deepEqual(ios.deviceParams(other), { udid: other.serial, connection: 'wifi' });
});

test('clearing the address restores plain local discovery', async () => {
  const ios = adapter();
  ios.setDirect({ host: 'iphone.tail1234.ts.net', udid });
  ios.setDirect(null);
  ios.connection = 'wifi';
  await ios.list();
  assert.deepEqual(ios.requests.at(-1), ['discover', { connection: 'wifi' }]);
});

test('rejects malformed addresses and unknown phones', () => {
  const ios = adapter();
  for (const host of ['', 'a b', 'http://x', '100.64.0.2/', '-x', 5]) assert.throws(() => ios.setDirect({ host, udid }), /network address/);
  assert.throws(() => ios.setDirect({ host: '100.64.0.2', udid: 'x' }), /USB once/);
  assert.equal(ios.direct, null);
});

test('the Wi-Fi switch names the saved address when the iPhone does not answer', async () => {
  const ios = adapter();
  ios.setDirect({ host: '100.64.0.2', udid });
  ios.request = async (method) => method === 'discover' ? [] : {};
  await assert.rejects(ios.prepareWifi(phone('usb')), /did not answer at 100\.64\.0\.2/);
});
