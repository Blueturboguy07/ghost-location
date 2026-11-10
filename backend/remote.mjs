import { createServer } from 'node:http';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { place } from './validation.mjs';

// Phone remote: a small web page served on the local network so the phone's own
// browser can choose a location. The computer still sends it to the phone.
// The link carries a random access code; requests without it get a bare 404.
export const DEFAULT_PORT = 47800;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const MAX_BODY = 4096;
const MAX_FAILURES = 30;
const LOCKOUT_MS = 10 * 60 * 1000;

export const newToken = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const validToken = value => typeof value === 'string' && /^[a-z0-9]{10}$/.test(value);
const sameToken = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function localAddresses(interfaces = networkInterfaces) {
  const result = [];
  for (const [name, entries] of Object.entries(interfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) result.push({ name, address: entry.address });
    }
  }
  return result;
}

export class RemoteServer {
  constructor({ controller, search, settingsPath, assets, port = DEFAULT_PORT, interfaces = networkInterfaces, now = Date.now }) {
    this.controller = controller; this.search = search; this.settingsPath = settingsPath; this.assets = assets;
    this.preferredPort = port; this.interfaces = interfaces; this.now = now;
    this.server = null; this.port = null; this.enabled = false; this.token = newToken();
    this.failures = 0; this.lockedUntil = 0; this.error = null;
  }

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      if (validToken(saved.token)) this.token = saved.token;
      if (saved.enabled === true) await this.setEnabled(true).catch(error => { this.error = error.message; });
    } catch {}
    return this.status();
  }

  async save() {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify({ enabled: this.enabled, token: this.token }, null, 2), { mode: 0o600 });
  }

  status() {
    const addresses = this.enabled ? localAddresses(this.interfaces) : [];
    return {
      enabled: this.enabled, port: this.port, error: this.error,
      links: addresses.map(({ name, address }) => ({ network: name, url: `http://${address}:${this.port}/${this.token}/` })),
    };
  }

  async setEnabled(value) {
    const enabled = value === true;
    this.error = null;
    if (enabled && !this.server) await this.listen();
    if (!enabled && this.server) await this.close();
    this.enabled = enabled;
    await this.save();
    return this.status();
  }

  async resetLink() {
    this.token = newToken(); this.failures = 0; this.lockedUntil = 0;
    await this.save();
    return this.status();
  }

  listen() {
    const attempt = port => new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch(() => { if (!response.headersSent) this.send(response, 500, { error: 'Request failed.' }); else response.destroy(); });
      });
      server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 32;
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); server.on('error', () => {}); resolve(server); });
    });
    return attempt(this.preferredPort)
      .catch(error => { if (error.code !== 'EADDRINUSE') throw error; return attempt(0); })
      .then(server => { this.server = server; this.port = server.address().port; });
  }

  close() {
    const server = this.server; this.server = null; this.port = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }

  async dispose() { await this.close(); }

  send(response, status, body, type = 'application/json; charset=utf-8') {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(payload);
  }

  async body(request) {
    if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('Send JSON.'), { status: 415 });
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Request is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (parsed && typeof parsed === 'object') return parsed; } catch {}
    throw Object.assign(new Error('Unreadable request.'), { status: 400 });
  }

  // Only what the phone page needs: never serials, saved places or preferences.
  view() {
    const state = this.controller.state;
    const session = state.session;
    const device = this.target(false);
    return {
      busy: Boolean(state.busy),
      device: device ? { name: device.name, platform: device.platform, connection: device.connection, state: device.state, detail: device.detail || '' } : null,
      session: session ? { status: session.status, latitude: session.latitude, longitude: session.longitude, label: session.label, message: session.message || '', deviceName: session.deviceName, lastRefreshAt: session.lastRefreshAt || null } : null,
      routeRunning: state.route?.status === 'running',
    };
  }

  /** The phone this remote controls: the one with a session, otherwise the only ready phone. */
  target(strict = true) {
    const state = this.controller.state;
    const connection = state.preferences?.connection || 'usb';
    const devices = (state.devices || []).filter(device => device.connection === connection);
    if (state.session) {
      const owner = devices.find(device => device.id === state.session.deviceId);
      if (owner || !strict) return owner || null;
      throw new Error('The phone with the active session is not connected to the computer.');
    }
    const ready = devices.filter(device => device.state === 'ready');
    if (ready.length === 1) return ready[0];
    if (!strict) return devices[0] || null;
    if (!ready.length) throw new Error(devices[0]?.detail || 'No ready phone. Connect and prepare it in Ghost on the computer first.');
    throw new Error('More than one phone is connected. Choose one in Ghost on the computer.');
  }

  async handle(request, response) {
    const url = new URL(request.url, 'http://ghost.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    const supplied = parts.shift() || '';
    if (this.now() < this.lockedUntil) return this.send(response, 429, { error: 'Too many wrong links. Try again later.' });
    if (!validToken(supplied) || !sameToken(supplied, this.token)) {
      if (++this.failures >= MAX_FAILURES) { this.failures = 0; this.lockedUntil = this.now() + LOCKOUT_MS; }
      return this.send(response, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    const route = parts.join('/');
    const method = request.method;
    try {
      if (method === 'GET' && route === '') {
        if (!url.pathname.endsWith('/')) { response.writeHead(302, { Location: `/${this.token}/`, 'Cache-Control': 'no-store' }); return response.end(); }
        return this.send(response, 200, PAGE, 'text/html; charset=utf-8');
      }
      if (method === 'GET' && route === 'app.js') return this.send(response, 200, CLIENT, 'text/javascript; charset=utf-8');
      if (method === 'GET' && (route === 'leaflet.js' || route === 'leaflet.css')) {
        return this.send(response, 200, await readFile(path.join(this.assets, route)), route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      }
      if (method === 'GET' && route === 'api/state') return this.send(response, 200, this.view());
      if (method === 'GET' && route === 'api/search') return this.send(response, 200, { results: await this.search(url.searchParams.get('q') || '') });
      if (method === 'POST' && route === 'api/apply') {
        const point = place(await this.body(request));
        const device = this.target();
        await this.controller.applyLocation({ deviceId: device.id, ...point });
        return this.send(response, 200, this.view());
      }
      if (method === 'POST' && route === 'api/stop') {
        await this.body(request);
        await this.controller.stopLocation();
        return this.send(response, 200, this.view());
      }
      return this.send(response, 404, { error: 'Not found.' });
    } catch (error) {
      return this.send(response, error.status || 409, { error: String(error.message || 'Operation failed.').slice(0, 400), ...this.view() });
    }
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#f8f9fb"><meta name="apple-mobile-web-app-capable" content="yes">
<title>Ghost remote</title>
<link rel="stylesheet" href="leaflet.css">
<style>
:root{--ink:#1d1d1f;--muted:#6e6e73;--line:#e3e4e8;--blue:#0a6cff;--bg:#f8f9fb}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);display:flex;flex-direction:column;overflow:hidden}
header{padding:calc(env(safe-area-inset-top) + 10px) 16px 10px;background:#fff;border-bottom:1px solid var(--line)}
form{display:flex;gap:8px}
input{flex:1;min-width:0;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 14px;min-height:44px;background:#e9eaee;color:var(--ink)}
button:disabled{opacity:.45}
button.primary{background:var(--blue);color:#fff}
#results{max-height:38vh;overflow:auto;margin-top:8px}
#results:empty{display:none}
#results button{display:block;width:100%;text-align:left;font-weight:400;background:#fff;border:1px solid var(--line);margin-top:6px}
#results p{margin:8px 2px 0;color:var(--muted);font-size:13px}
#map{flex:1;min-height:0;background:#e9eaee}
footer{padding:12px 16px calc(env(safe-area-inset-bottom) + 12px);background:#fff;border-top:1px solid var(--line)}
#status{font-weight:600;overflow-wrap:anywhere}
#detail{color:var(--muted);font-size:13px;margin:2px 0 10px;min-height:18px;overflow-wrap:anywhere}
#detail.error{color:#c4261d}
.row{display:flex;gap:8px}.row button{flex:1}
</style></head><body>
<header><form id="search"><input id="query" type="search" placeholder="Search for a place" autocomplete="off" enterkeyhint="search" maxlength="200"><button type="submit">Search</button></form><div id="results"></div></header>
<div id="map"></div>
<footer><div id="status">Connecting…</div><div id="detail"></div>
<div class="row"><button id="apply" class="primary" disabled>Set location</button><button id="stop" disabled>Restore real</button></div></footer>
<script src="leaflet.js"></script><script src="app.js"></script>
</body></html>`;

const CLIENT = `(() => {
'use strict';
const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([41.8827, -87.6233], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
let pin = null, active = null, picked = null, state = null, working = false, centred = false, note = null;
const fmt = p => p.latitude.toFixed(5) + ', ' + p.longitude.toFixed(5);
function pick(point, move) {
  picked = { latitude: point.latitude, longitude: point.longitude, label: point.label || fmt(point) };
  if (!pin) pin = L.circleMarker([0, 0], { radius: 10, color: '#0a6cff', weight: 3, fillColor: '#0a6cff', fillOpacity: .35 }).addTo(map);
  pin.setLatLng([picked.latitude, picked.longitude]);
  if (move) map.setView([picked.latitude, picked.longitude], Math.max(map.getZoom(), 15));
  note = null; render();
}
map.on('click', event => { const p = event.latlng.wrap(); pick({ latitude: p.lat, longitude: p.lng }); });
function render() {
  const session = state && state.session, device = state && state.device;
  if (session) {
    if (!active) active = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#34c759', fillOpacity: 1 }).addTo(map);
    active.setLatLng([session.latitude, session.longitude]);
    if (!centred && !picked) { map.setView([session.latitude, session.longitude], 14); centred = true; }
  } else if (active) { active.remove(); active = null; }
  let status = 'Connecting…', detail = '';
  if (state) {
    if (session && session.status === 'active') { status = 'Phone location: ' + (session.label || fmt(session)); detail = 'Sent by the computer' + (device ? ' over ' + (device.connection === 'wifi' ? 'Wi-Fi' : 'USB') : '') + '.'; }
    else if (session) { status = 'Session ' + session.status; detail = session.message; }
    else if (device && device.state === 'ready') { status = (device.name || 'Phone') + ' is ready'; detail = 'Tap the map or search, then set the location.'; }
    else if (device) { status = (device.name || 'Phone') + ' needs attention'; detail = device.detail || 'Finish setup in Ghost on the computer.'; }
    else { status = 'No phone connected to the computer'; detail = 'Connect this phone to Ghost on the computer first.'; }
    if (picked) detail = 'Pin: ' + picked.label;
  }
  if (note) detail = note.text;
  $('status').textContent = status;
  $('detail').textContent = detail; $('detail').className = note && note.error ? 'error' : '';
  const blocked = working || !state || state.busy;
  $('apply').disabled = blocked || !picked || !(session || (device && device.state === 'ready'));
  $('apply').textContent = working ? 'Working…' : session ? 'Update location' : 'Set location';
  $('stop').disabled = blocked || !session;
}
async function call(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { if ('session' in data) state = data; throw new Error(data.error || 'Request failed (' + response.status + ').'); }
  return data;
}
async function refresh() {
  if (working || document.hidden) return;
  try { state = await call('api/state'); if (note && note.offline) note = null; }
  catch (error) { state = null; note = { text: 'Cannot reach Ghost on the computer. Stay on its network and keep Ghost open.', error: true, offline: true }; }
  render();
}
async function act(path, body, done) {
  working = true; note = null; render();
  try { state = await call(path, body); note = { text: done }; }
  catch (error) { note = { text: error.message, error: true }; }
  working = false; render();
}
$('apply').onclick = () => { if (picked) act('api/apply', picked, 'Location sent to the phone.'); };
$('stop').onclick = () => act('api/stop', {}, 'Real location restored. Apps may need a moment to refresh.');
$('search').onsubmit = async event => {
  event.preventDefault();
  const query = $('query').value.trim(), box = $('results');
  if (query.length < 2) return;
  const coords = query.match(/^\\s*(-?\\d+(?:\\.\\d+)?)\\s*[, ]\\s*(-?\\d+(?:\\.\\d+)?)\\s*$/);
  if (coords && Math.abs(+coords[1]) <= 90 && Math.abs(+coords[2]) <= 180) { box.replaceChildren(); $('query').blur(); pick({ latitude: +coords[1], longitude: +coords[2] }, true); return; }
  const message = text => { const p = document.createElement('p'); p.textContent = text; box.replaceChildren(p); };
  message('Searching…');
  try {
    const data = await call('api/search?q=' + encodeURIComponent(query));
    if (!data.results.length) return message('No places found.');
    box.replaceChildren(...data.results.map(result => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = result.label;
      button.onclick = () => { box.replaceChildren(); $('query').blur(); pick(result, true); };
      return button;
    }));
  } catch (error) { message(error.message); }
};
document.addEventListener('visibilitychange', refresh);
setInterval(refresh, 2000); refresh();
})();`;
