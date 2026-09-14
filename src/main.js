import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import {
  createIcons, MapPin, Bookmark, Settings2, HelpCircle, ArrowUpRight, ArrowRight,
  Search, Plus, Minus, Crosshair, Smartphone, RefreshCw, ChevronDown, X, Check,
  Circle, Download, Pencil, Trash2, RotateCcw, LoaderCircle, Cable, Laptop, Monitor,
  ChevronLeft,
} from 'lucide';
import { createPreviewBridge } from './preview.js';

const isPreview = !window.ghost;
const detectedHost = /Windows/i.test(navigator.userAgent) ? 'windows' : 'mac';
document.documentElement.classList.toggle('host-windows', detectedHost === 'windows');
document.documentElement.classList.toggle('desktop-app', !isPreview);
const api = window.ghost || createPreviewBridge();
const icons = { MapPin, Bookmark, Settings2, HelpCircle, ArrowUpRight, ArrowRight, Search, Plus, Minus, Crosshair, Smartphone, RefreshCw, ChevronDown, X, Check, Circle, Download, Pencil, Trash2, RotateCcw, LoaderCircle, Cable, Laptop, Monitor, ChevronLeft };
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const paintIcons = () => {
  createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
  document.querySelectorAll('svg[data-lucide]').forEach((element) => element.removeAttribute('data-lucide'));
};
const renderedContent = new WeakMap();
function setContent(selector, html) {
  const element = $(selector);
  if (renderedContent.get(element) === html) return false;
  element.innerHTML = html;
  renderedContent.set(element, html);
  return true;
}
const formatCoordinate = (value, latitude = true) => `${Math.abs(value).toFixed(5)}° ${latitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E')}`;

const setupGuides = {
  'mac:ios': {
    title: 'Mac + iPhone',
    intro: 'One cable, one trust prompt, and Developer Mode.',
    steps: [
      ['Connect and trust', 'Unlock your iPhone, connect it to your Mac with a USB data cable, then tap Trust on the iPhone if prompted.'],
      ['Turn on Developer Mode', 'On iPhone, open Settings → Privacy & Security → Developer Mode. Turn it on, restart, then confirm with your passcode.'],
      ['Prepare the device tools', 'Keep the Mac online for the first setup. In Ghost, select the iPhone and choose Prepare so Ghost can mount the matching developer support image.'],
      ['Keep the cable connected', 'Leave the iPhone connected while a location is active. Use Restore real location before unplugging when possible.'],
    ],
  },
  'windows:ios': {
    title: 'Windows + iPhone',
    intro: 'Install Apple’s USB support, then trust and prepare the iPhone.',
    steps: [
      ['Install Apple Devices', 'Install or update the Apple Devices app from the Microsoft Store. Open it once so Windows can load Apple’s USB services.'],
      ['Connect and trust', 'Unlock your iPhone, connect it with a USB data cable, select it in Apple Devices, then confirm Trust on both the PC and iPhone if prompted.'],
      ['Turn on Developer Mode', 'On iPhone, open Settings → Privacy & Security → Developer Mode. Turn it on, restart, then confirm with your passcode.'],
      ['Prepare in Ghost', 'Return to Ghost, select the iPhone, and choose Prepare. Keep the PC online during the first preparation.'],
    ],
  },
  'mac:android': {
    title: 'Mac + Android',
    intro: 'Enable Android’s developer settings and authorize this Mac.',
    steps: [
      ['Unlock Developer options', 'On Android, open Settings → About phone and tap Build number seven times. Enter your screen lock if asked.'],
      ['Enable USB debugging', 'Open Settings → System → Developer options and turn on USB debugging. Menu names can vary by phone maker.'],
      ['Connect and authorize', 'Use a USB data cable, keep the phone unlocked, and accept the Allow USB debugging prompt for this Mac. No Mac USB driver is normally needed.'],
      ['Prepare the location helper', 'In Ghost, select the phone and choose Prepare. If Android asks for a mock location app, choose Appium Settings.'],
    ],
  },
  'windows:android': {
    title: 'Windows + Android',
    intro: 'Set up the USB driver, then enable and authorize debugging.',
    steps: [
      ['Check the USB driver', 'Connect with a USB data cable. If Windows does not detect the phone, install the ADB USB driver from your phone manufacturer.'],
      ['Unlock Developer options', 'On Android, open Settings → About phone and tap Build number seven times. Enter your screen lock if asked.'],
      ['Enable and authorize debugging', 'Turn on USB debugging in Developer options, reconnect the cable, and accept the computer’s RSA authorization prompt.'],
      ['Prepare the location helper', 'In Ghost, select the phone and choose Prepare. If Android asks for a mock location app, choose Appium Settings.'],
    ],
  },
};

let state = { devices: [], savedPlaces: [], recentPlaces: [], runtime: {}, session: null, preferences: {}, busy: false };
let selectedDeviceId = null;
let selectedPlace = null;
let currentView = 'map';
let locationMode = 'fixed';
let routeStops = [], routePlan = null;
let routeLine = null, routeDot = null;
const routeMarkers = [];
let setupHost = detectedHost;
let setupPlatform = 'ios';
let surveyHost = detectedHost;
let surveyPhone = null;
let onboardingStep = 'survey';
let onboardingShown = false;
const onboardingChecks = new Set();
let pending = false;
let pendingAction = null;
let searchNumber = 0;
let toastTimer;
let lastWarning = null;

$('#app').innerHTML = `
  <header class="titlebar">
    <div class="window-inset" aria-hidden="true"></div>
    <a class="wordmark" href="#" aria-label="Ghost map"><span class="rail-emblem">${icon('map-pin')}</span><span>Ghost</span></a>
    <div class="titlebar-right">
      <span class="preview-label" ${isPreview ? '' : 'hidden'}>Preview</span>
      <button id="saved-nav-button" class="toolbar-button" data-view="saved">${icon('bookmark')}<span>Saved</span><span class="toolbar-count" id="saved-dot" hidden></span></button>
      <button id="help-button" class="toolbar-button" aria-label="Device setup" title="Device setup">${icon('help-circle')}<span>Setup</span></button>
      <button id="settings-button" class="toolbar-button icon-only" aria-label="Settings" title="Settings">${icon('settings-2')}</button>
    </div>
  </header>

  <div class="workspace">
    <main class="map-workspace" aria-label="Location map">
      <div id="map" aria-label="Interactive map. Click to select a location. You can also use the coordinate fields." tabindex="0"></div>
      <div class="map-topbar">
        <div class="search-wrapper">
          <form id="search-form" role="search" class="search-box">${icon('search')}<input id="search-input" placeholder="Search for a place or coordinates" autocomplete="off" aria-label="Search places or coordinates" /><kbd id="search-key">${detectedHost === 'windows' ? 'Ctrl K' : '⌘K'}</kbd><button id="search-submit" type="submit" aria-label="Search">${icon('arrow-right')}</button></form>
          <div id="search-results" class="search-results" hidden></div>
        </div>
        <button id="connection-badge" class="connection-badge"><span class="status-dot"></span><span id="connection-text">No phone connected</span>${icon('chevron-down')}</button>
      </div>
      <div id="map-error" class="map-error" hidden>${icon('help-circle')}<span>Map tiles could not load. Coordinates still work.</span><button id="retry-map" class="text-button">Retry</button></div>
      <div id="destination-callout" class="destination-callout" hidden></div>
      <div class="map-controls"><button id="recenter-button" class="map-button" aria-label="Center map on selected place" title="Center map">${icon('crosshair')}</button><div class="zoom-buttons"><button id="zoom-in" class="map-button" aria-label="Zoom in" title="Zoom in">${icon('plus')}</button><button id="zoom-out" class="map-button" aria-label="Zoom out" title="Zoom out">${icon('minus')}</button></div></div>
      <div class="map-bottom"><div id="session-status" class="session-status" role="status"></div></div>
      <div class="map-footer"><span id="map-coordinates">41.88270° N · 87.62330° W</span><span><a href="https://photon.komoot.io" target="_blank" rel="noreferrer">Photon</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></span></div>
    </main>

    <aside class="control-panel">
      <div class="panel-scroll">
        <div class="panel-heading"><span class="eyebrow" id="panel-eyebrow">Location</span><h1 id="panel-title">Set a location</h1><p id="panel-subtitle">Choose a phone and a point on the map.</p></div>
        <div class="location-modes" role="group" aria-label="Location mode"><button data-location-mode="fixed" aria-pressed="true">Fixed location</button><button data-location-mode="route" aria-pressed="false">Route</button></div>
        <section class="device-section" aria-labelledby="device-label"><div class="section-heading"><h2 id="device-label">Phone</h2><button id="scan-button" class="icon-button" aria-label="Refresh connected devices" title="Refresh connected devices">${icon('refresh-cw')}</button></div><div id="device-area"></div><button id="connection-options" class="setup-link">Connection: USB · Change</button></section>
        <section class="destination-section" aria-labelledby="destination-label">
          <div class="section-heading"><h2 id="destination-label">Destination</h2><button id="save-button" class="icon-button" aria-label="Save selected place" title="Save selected place" disabled>${icon('bookmark')}</button></div>
          <div id="destination-summary"></div>
          <form id="coordinate-form" class="coordinate-form"><label><span>Latitude</span><input id="latitude" type="number" min="-90" max="90" step="any" placeholder="41.88270" required aria-label="Latitude" /></label><label><span>Longitude</span><input id="longitude" type="number" min="-180" max="180" step="any" placeholder="−87.62330" required aria-label="Longitude" /></label><button type="submit" class="coordinate-submit" aria-label="Select these coordinates" title="Select these coordinates">${icon('arrow-right')}</button></form>
          <p class="coordinate-hint">Search, enter coordinates, or click the map.</p>
          <div id="route-controls" hidden>
            <button id="add-route-stop" class="secondary-button">${icon('plus')} Add selected pin to route</button>
            <ol id="route-stops" class="route-stops"></ol>
            <div class="route-plan-actions"><button id="plan-route" class="secondary-button">Plan road route</button><button id="clear-route" class="text-button">Clear</button></div>
            <p class="route-provider">Stops are sent to OSRM when you plan. Roads by OpenStreetMap. Internet required.</p>
            <div id="route-summary" class="route-summary" hidden></div>
            <button id="route-play" class="primary-button" disabled>Start route · 45 mph</button>
            <p id="route-hint" class="action-hint">Add a start and destination, in order.</p>
          </div>
          <div id="fixed-actions"><button id="apply-button" class="primary-button" disabled><span>Set location</span>${icon('arrow-up-right')}</button><p id="apply-hint" class="action-hint">Connect a phone to get started.</p></div><button id="restore-button" class="restore-button" disabled>${icon('rotate-ccw')} Restore real location</button>
        </section>
        <section class="saved-section" aria-labelledby="saved-label"><div class="section-heading"><h2 id="saved-label">Saved places <span id="saved-count" class="count">0</span></h2><button id="view-saved-button" class="text-button">View all ${icon('arrow-right')}</button></div><div id="saved-list"></div></section>
      </div>
    </aside>
  </div>

  <dialog id="onboarding-dialog" class="onboarding-dialog" aria-labelledby="onboarding-title"><div class="onboarding-chrome"><span class="onboarding-brand">${icon('map-pin')} Ghost</span><span id="onboarding-progress">1 of 2</span></div><div id="onboarding-content"></div></dialog>

  <dialog id="setup-dialog" class="sheet-dialog" aria-labelledby="setup-title">
    <div class="sheet-heading"><div><span class="eyebrow">Device setup</span><h2 id="setup-title">Setup guide</h2></div><button class="icon-button" data-close="setup-dialog" aria-label="Close setup guide">${icon('x')}</button></div><p id="setup-intro" class="sheet-intro"></p><div id="setup-content"></div>
    <div class="setup-note">${icon('cable')}<span>Keep the cable connected while a location is active. Restore real location before unplugging when possible.</span></div><div class="dialog-actions"><button id="change-configuration" class="secondary-button">Change setup</button><button id="setup-scan" class="primary-button"><span>Check for my phone</span>${icon('refresh-cw')}</button></div><div id="setup-detection" class="setup-detection" role="status"></div>
  </dialog>

  <dialog id="wifi-dialog" class="sheet-dialog" aria-labelledby="wifi-title">
    <div class="sheet-heading"><div><span class="eyebrow">Phone connection</span><h2 id="wifi-title">Connect over Wi-Fi</h2></div><button class="icon-button" data-close="wifi-dialog" aria-label="Close connection settings">${icon('x')}</button></div>
    <p class="sheet-intro">Keep your phone and computer on the same Wi-Fi network. Restore the current location before changing connections.</p>
    <div class="location-modes" role="group" aria-label="Connection method"><button data-connection="usb">USB cable</button><button data-connection="wifi">Wi-Fi</button></div>
    <p id="wifi-status" class="settings-note" role="status"></p>
    <label class="field-label" for="wifi-phone">Your phone</label><select id="wifi-phone" class="text-input"><option value="ios">iPhone · iOS 17.4+</option><option value="android">Android · Android 11+</option></select>
    <div id="wifi-ios" class="settings-group">
      <h3>Pair once by cable</h3>
      <ol class="wifi-steps"><li>Choose USB cable above. Connect and unlock your iPhone, trust this computer and enable Developer Mode. On Windows, install Apple Devices first.</li><li>Select your iPhone in the main Phone menu, then return here and enable Wi-Fi.</li><li>Choose Wi-Fi above. Wait for the phone to appear, then unplug the cable. You can now set a location or start a route.</li></ol>
      <button id="enable-iphone-wifi" class="secondary-button">Enable Wi-Fi for selected iPhone</button>
      <p class="settings-note">If discovery fails, enable “Show this iPhone when on Wi-Fi” in Finder on Mac, or “Show this device when on Wi-Fi” in Apple Devices on Windows, and apply. Unlock the phone and refresh.</p>
    </div>
    <div id="wifi-android" class="settings-group" hidden>
      <h3>Pair with Wireless debugging</h3>
      <p class="settings-note">Choose Wi-Fi above. On Android 11 or later, enable Developer options (tap Build number seven times), then open Wireless debugging → Pair device with pairing code. Keep this screen open. No USB cable is needed.</p>
      <form id="wifi-pair-form" class="wifi-form">
        <label class="field-label" for="wifi-pair-address">Pairing IP address and port</label><input id="wifi-pair-address" class="text-input" placeholder="192.168.1.20:37123" autocomplete="off" required />
        <label class="field-label" for="wifi-pair-code">Six-digit pairing code</label><input id="wifi-pair-code" class="text-input" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required />
        <button id="wifi-pair-button" type="submit" class="secondary-button">Pair phone</button>
      </form>
      <form id="wifi-connect-form" class="wifi-form">
        <label class="field-label" for="wifi-connect-address">Connection IP address and port</label><input id="wifi-connect-address" class="text-input" placeholder="192.168.1.20:40567" autocomplete="off" required />
        <p class="settings-note">After pairing, go back to the main Wireless debugging screen and use its IP address and port here. This port is different from the pairing port and may change after reconnecting.</p>
        <button id="wifi-connect-button" type="submit" class="secondary-button">Connect paired phone</button>
      </form>
      <p class="settings-note">Once connected, close this panel and choose Prepare if needed. Keep Location on and select Appium Settings as the mock location app. Android 8–10 uses USB.</p>
    </div>
    <p class="settings-note">Allow Ghost and its device tools through your computer’s local-network/firewall prompts. Guest Wi-Fi, client isolation and some VPNs can prevent devices from finding each other. Keep Ghost open; restore real location before disconnecting.</p>
    <div class="dialog-actions"><button id="wifi-refresh" class="primary-button">Refresh phones</button></div>
  </dialog>

  <dialog id="settings-dialog" class="sheet-dialog" aria-labelledby="settings-title">
    <div class="sheet-heading"><div><span class="eyebrow">Ghost</span><h2 id="settings-title">Settings</h2></div><button class="icon-button" data-close="settings-dialog" aria-label="Close settings">${icon('x')}</button></div>
    <div class="settings-group"><h3>Device setup</h3><div class="configuration-row"><div><strong id="settings-configuration">No setup selected</strong><small>Ghost uses this to show the right connection steps.</small></div><button id="rerun-onboarding" class="secondary-button compact">Change</button></div></div>
    <div class="settings-group"><h3>Location sessions</h3><label class="setting-row"><span><strong>Restore on quit</strong><small>Ghost tries to stop location simulation before it closes. Keep the phone connected.</small></span><input id="restore-preference" type="checkbox" class="switch" /></label></div>
    <div class="settings-group"><h3>Device tools</h3><div id="runtime-status"></div><button id="install-runtime" class="secondary-button">${icon('download')} Prepare device tools</button><p class="settings-note">First-time preparation may need an internet connection.</p></div>
    <form id="provider-form" class="settings-group"><h3>Place search</h3><label class="field-label" for="provider-url">Photon-compatible endpoint</label><input id="provider-url" class="text-input" type="url" required placeholder="https://photon.komoot.io/api/" /><p class="settings-note">Search runs only when you submit. Map tiles come from OpenStreetMap.</p><div class="button-row"><button type="submit" class="secondary-button compact">Save endpoint</button><button id="reset-provider" type="button" class="text-button">Reset</button></div></form><div class="settings-footer">Ghost 0.1.6 · Free and open source</div>
  </dialog>

  <dialog id="save-dialog" class="small-dialog" aria-labelledby="save-title"><div class="sheet-heading"><div><span class="eyebrow">Saved place</span><h2 id="save-title">Save this place</h2></div><button class="icon-button" data-close="save-dialog" aria-label="Close save place">${icon('x')}</button></div><form id="save-form"><label class="field-label" for="place-name">Name</label><input id="place-name" class="text-input" maxlength="120" required placeholder="Place name" /><input id="place-id" type="hidden" /><p id="save-coordinates" class="settings-note"></p><button class="primary-button" type="submit"><span>Save place</span>${icon('bookmark')}</button></form></dialog>
  <div id="toast" class="toast" role="status" hidden><span id="toast-icon"></span><span id="toast-message"></span><button id="toast-close" class="icon-button" aria-label="Dismiss notification">${icon('x')}</button></div>
`;

const map = L.map('map', { zoomControl: false, attributionControl: true, minZoom: 2, maxZoom: 19, worldCopyJump: true }).setView([41.8827, -87.6233], 13);
map.attributionControl.setPrefix(false);
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors', keepBuffer: 1, updateWhenIdle: true }).addTo(map);
let tileErrors = 0;
tiles.on('tileerror', () => { if (++tileErrors >= 3) $('#map-error').hidden = false; });
tiles.on('tileload', () => { tileErrors = 0; $('#map-error').hidden = true; });
const pinIcon = L.divIcon({ className: 'ghost-map-pin', html: '<div class="pin-halo"></div><div class="pin-head"><span></span></div>', iconSize: [48, 58], iconAnchor: [24, 54] });
let marker = null;

function guideFor(host = setupHost, phone = setupPlatform) { return setupGuides[`${host}:${phone}`]; }
function platformName(platform) { return platform === 'ios' ? 'iPhone' : 'Android'; }

function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast-message').textContent = message;
  $('#toast-icon').innerHTML = icon(error ? 'help-circle' : 'check');
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  paintIcons();
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 12000 : 4500);
}

function acceptState(next) {
  if (!next?.devices) return;
  state = { ...state, ...next };
  if (state.route) locationMode = 'route';
  if (!state.devices.some((device) => device.id === selectedDeviceId)) selectedDeviceId = state.devices.find((device) => device.id === state.session?.deviceId)?.id || state.devices[0]?.id || state.session?.deviceId || null;
  setupHost = state.preferences.hostPlatform || setupHost || detectedHost;
  setupPlatform = state.preferences.phonePlatform || state.devices.find((device) => device.id === selectedDeviceId)?.platform || setupPlatform;
  render();
  if (!selectedPlace && state.session && Number.isFinite(state.session.latitude) && Number.isFinite(state.session.longitude)) selectPlace(state.session);
  if (state.warning && state.warning !== lastWarning) { lastWarning = state.warning; notify(state.warning, true); }
  if (!onboardingShown && state.preferences.onboardingComplete !== true) {
    onboardingShown = true;
    requestAnimationFrame(() => openOnboarding());
  }
}

async function runOperation(action, message, operation = null) {
  if (pending) return null;
  pending = true;
  pendingAction = operation;
  render();
  try {
    const result = await action();
    acceptState(result);
    if (result?.devices) acceptState(await api.getState());
    if (message) notify(message);
    return result;
  } catch (error) {
    notify(error.message || 'Something went wrong. Please try again.', true);
    return null;
  } finally {
    pending = false;
    pendingAction = null;
    render();
  }
}

function selectPlace(place, fly = true) {
  selectedPlace = { latitude: Number(place.latitude), longitude: Number(place.longitude), label: place.label || 'Dropped pin' };
  if (!Number.isFinite(selectedPlace.latitude) || !Number.isFinite(selectedPlace.longitude) || Math.abs(selectedPlace.latitude) > 90 || Math.abs(selectedPlace.longitude) > 180) {
    selectedPlace = null;
    notify('Enter latitude between −90 and 90, and longitude between −180 and 180.', true);
    return;
  }
  const position = [selectedPlace.latitude, selectedPlace.longitude];
  if (!marker) {
    marker = L.marker(position, { icon: pinIcon, draggable: true, title: 'Selected destination. Drag to move.', alt: 'Selected destination pin', keyboard: true }).addTo(map);
    marker.on('dragend', () => { const point = marker.getLatLng().wrap(); selectPlace({ latitude: point.lat, longitude: point.lng, label: 'Dropped pin' }, false); });
  } else marker.setLatLng(position);
  if (fly) map.flyTo(position, Math.max(map.getZoom(), 14), { duration: 0.8 });
  $('#latitude').value = selectedPlace.latitude.toFixed(6);
  $('#longitude').value = selectedPlace.longitude.toFixed(6);
  $('#search-results').hidden = true;
  renderDestination();
  renderActions();
  renderRoute();
  paintIcons();
}

function renderDevices() {
  const selectedDevice = state.devices.find((device) => device.id === selectedDeviceId);
  const connected = state.devices.filter((device) => device.state !== 'offline');
  $('#connection-text').textContent = connected.length ? `${connected.length} phone${connected.length === 1 ? '' : 's'} connected` : 'No phone connected';
  $('#connection-badge').classList.toggle('connected', connected.length > 0);
  $('#scan-button').disabled = pending || state.busy;
  $('#scan-button').classList.toggle('spinning', pending);
  if (document.activeElement === $('#device-select')) return;
  if (!state.devices.length) {
    setContent('#device-area', `<button class="device-empty" id="connect-device">${icon('smartphone')}<span><strong>Connect your phone</strong><small>${state.preferences.connection === 'wifi' ? 'Pair on the same Wi-Fi network' : 'Use a USB data cable'}</small></span>${icon('arrow-right')}</button><button id="open-setup" class="setup-link">Open the setup guide</button>`);
    $('#connect-device').onclick = openSetup;
    $('#open-setup').onclick = openSetup;
    return;
  }
  const device = selectedDevice || state.devices[0];
  const deviceStatus = { ready: 'Ready', 'setup-required': 'Setup needed', unauthorized: 'Trust this computer', offline: 'Disconnected' }[device.state] || 'Check connection';
  setContent('#device-area', `<div class="device-card ${device.state === 'ready' ? 'ready' : ''}"><div class="device-card-top">${icon('smartphone')}<div class="device-select-wrap"><label class="sr-only" for="device-select">Connected phone</label><select id="device-select">${state.devices.map((phone) => `<option value="${esc(phone.id)}" ${phone.id === selectedDeviceId ? 'selected' : ''}>${esc(phone.name || platformName(phone.platform))}</option>`).join('')}</select><span>${esc(platformName(device.platform))}${device.osVersion ? ` ${esc(device.osVersion)}` : ''} · ${device.connection === 'wifi' ? 'Wi-Fi' : 'USB'}</span></div>${icon('chevron-down')}</div><div class="device-card-state"><span class="status-dot"></span><span>${deviceStatus}</span>${device.state === 'ready' ? icon('check') : `<button id="prepare-device" class="text-button" ${pending ? 'disabled' : ''}>${device.state === 'setup-required' ? 'Prepare' : 'Help'} ${icon('arrow-right')}</button>`}</div></div>${device.detail ? `<p class="device-detail">${esc(device.detail)}</p>` : ''}`);
  $('#device-select').onchange = (event) => { selectedDeviceId = event.target.value; render(); };
  $('#device-select').onblur = () => { renderDevices(); paintIcons(); };
  if ($('#prepare-device')) $('#prepare-device').onclick = () => {
    if (device.state === 'setup-required') runOperation(() => api.prepareDevice(selectedDeviceId));
    else { setupPlatform = device.platform; openSetup(); }
  };
}

function renderDestination() {
  setContent('#destination-summary', selectedPlace
    ? `<div class="destination-name">${icon('map-pin')}<div><strong>${esc(selectedPlace.label)}</strong><span>${formatCoordinate(selectedPlace.latitude)} · ${formatCoordinate(selectedPlace.longitude, false)}</span></div></div>`
    : `<div class="destination-empty">${icon('map-pin')}<div><strong>No destination selected</strong><span>Drop a pin anywhere on the map.</span></div></div>`);
  $('#save-button').disabled = !selectedPlace || pending;
  $('#destination-callout').hidden = !selectedPlace || locationMode === 'route';
  if (selectedPlace) setContent('#destination-callout', `<strong>${esc(selectedPlace.label)}</strong><span>${formatCoordinate(selectedPlace.latitude)} · ${formatCoordinate(selectedPlace.longitude, false)}</span>`);
}

function renderActions() {
  const device = state.devices.find((item) => item.id === selectedDeviceId);
  const status = state.session?.status;
  const busy = pending || state.busy || ['applying', 'stopping', 'reconnecting'].includes(status);
  const otherSession = state.session && state.session.deviceId !== selectedDeviceId;
  const retry = ['unknown', 'error', 'waiting'].includes(status) && !otherSession;
  const reconnectIOS = Boolean(state.session) && !otherSession && device?.platform === 'ios' && device.state === 'setup-required';
  const canApply = device?.connection === 'usb' && (device.state === 'ready' || reconnectIOS);
  const label = pendingAction === 'restore' ? 'Stopping…' : status === 'reconnecting' ? 'Reconnecting…' : busy ? 'Working…' : reconnectIOS || (retry && status === 'waiting') ? 'Reconnect & set location' : retry ? 'Retry location' : status === 'active' ? 'Update location' : 'Set location';
  $('#apply-button').disabled = busy || !selectedPlace || !canApply || Boolean(otherSession);
  setContent('#apply-button', `<span>${label}</span>${icon(busy ? 'loader-circle' : retry ? 'refresh-cw' : 'arrow-up-right', busy ? 'spin' : '')}`);
  $('#apply-hint').textContent = pendingAction === 'restore' ? 'Stopping automatic retry and requesting real location.' : status === 'reconnecting' ? 'Reconnecting to the same phone. Keep your phone connected.' : busy ? 'Keep your phone connected.' : otherSession ? 'Restore the current session before switching phones.' : !device || device.state === 'offline' ? state.session ? 'Reconnect the same phone to continue.' : 'Connect a phone to get started.' : reconnectIOS ? 'Reconnect and apply this pin to the same iPhone.' : device.state !== 'ready' ? 'Finish device setup to set a location.' : !selectedPlace ? 'Choose a destination on the map.' : retry ? 'Retry this pin on the same phone, or restore real location.' : 'Your phone changes only when you press this button.';
  $('#restore-button').disabled = !state.session || pending || (busy && status !== 'reconnecting');
  setContent('#restore-button', `${icon(pendingAction === 'restore' ? 'loader-circle' : 'rotate-ccw', pendingAction === 'restore' ? 'spin' : '')} ${pendingAction === 'restore' ? 'Stopping simulation…' : 'Restore real location'}`);
}

function placeItem(place) {
  return `<div class="saved-place"><button class="saved-place-main" data-place="${esc(place.id)}">${icon('map-pin')}<span><strong>${esc(place.label)}</strong><small>${Number(place.latitude).toFixed(4)}, ${Number(place.longitude).toFixed(4)}</small></span></button><div class="saved-place-actions"><button class="icon-button" data-edit="${esc(place.id)}" aria-label="Rename ${esc(place.label)}" title="Rename">${icon('pencil')}</button><button class="icon-button" data-delete="${esc(place.id)}" aria-label="Remove ${esc(place.label)}" title="Remove">${icon('trash-2')}</button></div></div>`;
}

const routeTime = seconds => seconds < 60 ? `${Math.ceil(seconds)} sec` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} hr ${Math.ceil(seconds % 3600 / 60)} min`;
function fitRoute() {
  if (routeLine) map.fitBounds(routeLine.getBounds(), { paddingTopLeft: [390, 95], paddingBottomRight: [85, 160], maxZoom: 16 });
}
function drawRoute() {
  if (routeLine) { routeLine.remove(); routeLine = null; }
  routeMarkers.splice(0).forEach(item => item.remove());
  if (locationMode !== 'route') return;
  if (routePlan) routeLine = L.polyline(routePlan.coordinates.map(([lon, lat]) => [lat, lon]), { color: '#087bff', weight: 5, opacity: 0.85, interactive: false }).addTo(map);
  routeStops.forEach((stop, index) => {
    const latlng = index === 0 && routePlan ? [...routePlan.coordinates[0]].reverse() : index === routeStops.length - 1 && routePlan ? [...routePlan.coordinates.at(-1)].reverse() : [stop.latitude, stop.longitude];
    routeMarkers.push(L.marker(latlng, { interactive: false, icon: L.divIcon({ className: 'route-stop-marker', html: `<span>${index + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map));
  });
}
function renderRoute() {
  const route = state.route, active = Boolean(route && state.session), inRoute = locationMode === 'route';
  const busy = pending || state.busy;
  const panel = $('.control-panel'), wasActive = panel.classList.contains('route-active');
  panel.classList.toggle('route-active', active);
  if (active && !wasActive) $('.panel-scroll').scrollTop = 0;
  if (marker) {
    if (active && map.hasLayer(marker)) marker.remove();
    if (!active && !map.hasLayer(marker)) marker.addTo(map);
  }
  $('#route-controls').hidden = !inRoute;
  $('#fixed-actions').hidden = inRoute;
  document.querySelectorAll('[data-location-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.locationMode === locationMode));
    button.disabled = busy || (active && button.dataset.locationMode === 'fixed');
  });
  $('#add-route-stop').disabled = !selectedPlace || active || busy || routeStops.length >= 12;
  $('#plan-route').disabled = routeStops.length < 2 || active || busy;
  $('#clear-route').disabled = !routeStops.length || active || busy;
  setContent('#route-stops', routeStops.map((stop, i) => `<li><span class="route-stop-number">${i + 1}</span><div><strong>${esc(stop.label)}</strong><small>${i === 0 ? 'Start' : i === routeStops.length - 1 ? 'Destination' : 'Via'}</small></div><button class="icon-button" data-remove-stop="${i}" aria-label="Remove stop ${i + 1}" ${active || busy ? 'disabled' : ''}>${icon('x')}</button></li>`).join(''));
  document.querySelectorAll('[data-remove-stop]').forEach(button => { button.onclick = () => {
    routeStops.splice(Number(button.dataset.removeStop), 1); routePlan = null; drawRoute(); renderRoute(); paintIcons();
  }; });
  $('#route-summary').hidden = !routePlan;
  if (routePlan) setContent('#route-summary', `<div><strong>${(routePlan.distanceMeters / 1609.344).toFixed(2)} miles</strong><span>45 mph · 1 sec updates</span></div><progress aria-label="Route progress" max="${routePlan.distanceMeters}" value="${route?.traveledMeters || 0}"></progress><p>${route?.status === 'completed' ? 'Arrived at destination' : `${routeTime(route?.remainingSeconds ?? routePlan.durationSeconds)} ${active ? 'remaining' : 'at 45 mph'}`}</p>`);
  const device = state.devices.find(d => d.id === selectedDeviceId);
  const otherSession = state.session && state.session.deviceId !== selectedDeviceId;
  const running = route?.status === 'running', paused = route?.status === 'paused';
  $('#route-play').disabled = busy || (active ? !running && (!paused || !device || otherSession || !['ready', 'setup-required'].includes(device.state)) : !routePlan || device?.state !== 'ready' || Boolean(otherSession));
  $('#route-play').textContent = busy ? 'Working…' : running ? 'Pause route' : paused ? 'Resume route · 45 mph' : route?.status === 'completed' ? 'Route completed' : 'Start route · 45 mph';
  $('#route-hint').textContent = active ? route.message : otherSession ? 'Restore the current session before switching phones.' : !routePlan ? 'Add a start and destination, then plan the route.' : !device ? 'Connect a phone to start. The route is ready.' : 'Start moves your phone to the first stop, then follows the road.';
  if (route?.point && inRoute) {
    const point = [route.point.latitude, route.point.longitude];
    if (!routeDot) routeDot = L.circleMarker(point, { radius: 9, color: 'white', weight: 3, fillColor: '#087bff', fillOpacity: 1, className: 'route-location-dot', interactive: false }).addTo(map);
    else routeDot.setLatLng(point);
    routeDot.bringToFront();
  } else if (routeDot) { routeDot.remove(); routeDot = null; }
}

function renderSaved() {
  const places = state.savedPlaces || [];
  $('#saved-count').textContent = places.length;
  $('#saved-dot').hidden = !places.length;
  $('#saved-dot').textContent = places.length;
  setContent('#view-saved-button', `${currentView === 'saved' ? 'Back to location' : 'View all'} ${icon(currentView === 'saved' ? 'chevron-left' : 'arrow-right')}`);
  $('#view-saved-button').hidden = !places.length;
  setContent('#saved-list', places.length ? (currentView === 'saved' ? places : places.slice(0, 3)).map(placeItem).join('') : `<div class="saved-empty">${icon('bookmark')}<p>Saved places will appear here.</p></div>`);
  document.querySelectorAll('[data-place]').forEach((button) => { button.onclick = () => { const place = places.find((item) => item.id === button.dataset.place); if (place) { selectPlace(place); setView('map'); } }; });
  document.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => openSave(places.find((item) => item.id === button.dataset.edit)); });
  document.querySelectorAll('[data-delete]').forEach((button) => { button.onclick = () => runOperation(() => api.deletePlace(button.dataset.delete), 'Place removed.'); });
}

function renderSession() {
  const session = state.session;
  const sessionElement = $('#session-status');
  sessionElement.classList.toggle('is-active', session?.status === 'active');
  sessionElement.classList.toggle('needs-attention', ['unknown', 'error', 'waiting'].includes(session?.status));
  const labels = { active: 'Simulation active', applying: 'Setting location…', reconnecting: 'Reconnecting to your phone…', waiting: 'Waiting for your phone', stopping: 'Stopping simulation…', unknown: 'Location state unverified', error: 'Session needs attention' };
  const refreshDate = session?.lastRefreshAt ? new Date(session.lastRefreshAt) : null;
  const hasRefresh = refreshDate && Number.isFinite(refreshDate.getTime());
  const commandAck = session?.refreshSource === 'command-ack';
  const helperReadback = session?.refreshSource === 'helper-readback';
  const confirmationLabel = commandAck ? 'Last command acknowledged' : helperReadback ? 'Last helper confirmation' : 'Last device confirmation';
  const confirmationScope = commandAck ? 'Command accepted; phone-app location is not verified.' : helperReadback ? 'Helper coordinates confirmed; a fresh GPS fix is not verified.' : 'Device response recorded; phone-app location is not verified.';
  const refreshCount = Number.isFinite(session?.refreshCount) ? Math.max(0, session.refreshCount) : null;
  const refreshText = hasRefresh ? `<small id="session-refresh" class="session-refresh" aria-live="off"><span>${confirmationLabel}: <time datetime="${esc(refreshDate.toISOString())}">${esc(refreshDate.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</time>${refreshCount === null ? '' : ` · ${commandAck ? 'Updates acknowledged' : 'Refreshes'}: ${refreshCount}`}</span><span>${confirmationScope}</span></small>` : '';
  const recovering = ['waiting', 'unknown', 'error'].includes(session?.status);
  const recoveryText = recovering ? `<span class="session-recovery">${session.autoReconnect ? 'Ghost will retry this phone automatically. Restore cancels retry.' : 'Reconnect this phone, then retry or restore.'}</span>` : '';
  const statusIcon = session?.status === 'reconnecting' ? 'refresh-cw' : session ? ['unknown', 'error', 'waiting'].includes(session.status) ? 'help-circle' : 'map-pin' : 'circle';
  setContent('#session-status', `<span class="session-status-icon">${icon(statusIcon, session?.status === 'reconnecting' ? 'spin' : '')}</span><div><strong>${session ? session.status === 'active' && state.route ? ({ running: 'Following route · 45 mph', paused: 'Route paused', completed: 'Arrived', starting: 'Starting route…' }[state.route.status]) : labels[session.status] || 'Session needs attention' : 'Ready'}</strong><span>${esc(state.route?.message || session?.message || (session ? session.label || 'Keep your phone connected.' : state.devices.some((device) => device.state === 'ready') ? 'Choose a place to begin.' : 'Connect a phone and choose a place.'))}</span>${recoveryText}${refreshText}</div>${session?.status === 'active' ? '<span class="live-tag"><span></span>Active</span>' : ''}`);
}

function renderRuntime() {
  setContent('#runtime-status', ['ios', 'android'].map((platform) => {
    const runtime = state.runtime?.[platform] || {};
    return `<div class="runtime-row"><div>${icon('smartphone')}<span><strong>${platformName(platform)}</strong><small>${esc(runtime.message || 'Tools have not been checked yet.')}</small></span></div><span class="runtime-tag ${runtime.available ? 'available' : ''}">${runtime.available ? 'Ready' : 'Setup needed'}</span></div>`;
  }).join(''));
  $('#install-runtime').disabled = pending || state.busy || isPreview;
  setContent('#install-runtime', `${icon(pending ? 'loader-circle' : 'download', pending ? 'spin' : '')} ${pending ? 'Preparing…' : isPreview ? 'Available in the desktop app' : 'Prepare device tools'}`);
  if (document.activeElement !== $('#restore-preference')) $('#restore-preference').checked = state.preferences.restoreOnQuit !== false;
  const selectedGuide = state.preferences.hostPlatform && state.preferences.phonePlatform ? guideFor(state.preferences.hostPlatform, state.preferences.phonePlatform) : null;
  $('#settings-configuration').textContent = selectedGuide?.title || 'No setup selected';
}

function renderSetup() {
  const guide = guideFor();
  $('#setup-title').textContent = guide.title;
  $('#setup-intro').textContent = guide.intro;
  const runtime = state.runtime?.[setupPlatform];
  const runtimeHelp = runtime?.available === false ? `<div class="setup-runtime"><div><strong>${isPreview ? 'Open the desktop app to connect' : 'Device tools need preparation'}</strong><p>${isPreview ? 'The browser preview cannot discover or control phones.' : 'First-time preparation needs internet access.'}</p></div><button id="setup-install-runtime" class="secondary-button compact" ${(pending || state.busy || isPreview) ? 'disabled' : ''}>${pending ? 'Preparing…' : 'Prepare tools'}</button></div>` : '';
  setContent('#setup-content', `${runtimeHelp}<ol class="setup-steps">${guide.steps.map(([title, body], index) => `<li><span class="step-number">${index + 1}</span><div><h3>${title}</h3><p>${body}</p></div></li>`).join('')}</ol><p class="compatibility-note">${setupPlatform === 'ios' ? 'Ghost currently targets iOS 17.4 and later. Support still depends on the iOS version and bundled device tools.' : 'Ghost targets Android 8 and later. Some apps can detect or reject simulated locations.'}</p>`);
  if ($('#setup-install-runtime')) $('#setup-install-runtime').onclick = () => runOperation(() => api.installRuntime(), 'Device tools checked.');
  $('#setup-scan').disabled = pending || state.busy;
  const matching = state.devices.filter((device) => device.platform === setupPlatform && device.state !== 'offline');
  $('#setup-detection').textContent = matching.length ? `${matching.length} ${platformName(setupPlatform)}${matching.length === 1 ? '' : ' devices'} detected. Close this guide to select it.` : isPreview ? 'Open the desktop app to check the USB connection.' : '';
}

function renderOnboarding() {
  $('#onboarding-progress').textContent = onboardingStep === 'survey' ? '1 of 2' : '2 of 2';
  if (onboardingStep === 'survey') {
    setContent('#onboarding-content', `<div class="onboarding-copy"><span class="eyebrow">Welcome to Ghost</span><h1 id="onboarding-title">Let’s set up your devices.</h1><p>Choose your computer and phone. Ghost will show the USB setup for that combination. For wireless setup, choose Connection → Wi-Fi on the map.</p></div><div class="survey-group"><h2>This computer</h2><div class="choice-grid"><button class="choice-card" data-survey-host="mac" aria-pressed="${surveyHost === 'mac'}">${icon('laptop')}<span><strong>Mac</strong><small>macOS</small></span>${icon('check', 'choice-check')}</button><button class="choice-card" data-survey-host="windows" aria-pressed="${surveyHost === 'windows'}">${icon('monitor')}<span><strong>Windows PC</strong><small>Windows 10 or 11</small></span>${icon('check', 'choice-check')}</button></div></div><div class="survey-group"><h2>Your phone</h2><div class="choice-grid"><button class="choice-card" data-survey-phone="ios" aria-pressed="${surveyPhone === 'ios'}">${icon('smartphone')}<span><strong>iPhone</strong><small>iOS 17.4 or later</small></span>${icon('check', 'choice-check')}</button><button class="choice-card" data-survey-phone="android" aria-pressed="${surveyPhone === 'android'}">${icon('smartphone')}<span><strong>Android</strong><small>Android 8 or later</small></span>${icon('check', 'choice-check')}</button></div></div><div class="onboarding-actions"><span>Your choices stay on this computer.</span><button id="onboarding-next" class="primary-button inline" ${!surveyHost || !surveyPhone ? 'disabled' : ''}><span>Continue</span>${icon('arrow-right')}</button></div>`);
    document.querySelectorAll('[data-survey-host]').forEach((button) => { button.onclick = () => { surveyHost = button.dataset.surveyHost; renderOnboarding(); paintIcons(); }; });
    document.querySelectorAll('[data-survey-phone]').forEach((button) => { button.onclick = () => { surveyPhone = button.dataset.surveyPhone; renderOnboarding(); paintIcons(); }; });
    $('#onboarding-next').onclick = () => { if (surveyHost && surveyPhone) { onboardingStep = 'guide'; onboardingChecks.clear(); renderOnboarding(); paintIcons(); } };
  } else {
    const guide = guideFor(surveyHost, surveyPhone);
    const matching = state.devices.filter((device) => device.platform === surveyPhone && device.state !== 'offline');
    setContent('#onboarding-content', `<button id="onboarding-back" class="back-button">${icon('chevron-left')} Back</button><div class="onboarding-copy guide-copy"><span class="configuration-pill">${guide.title}</span><h1 id="onboarding-title">Prepare your ${platformName(surveyPhone)}.</h1><p>${guide.intro} Check each step as you complete it.</p></div><div class="onboarding-checklist">${guide.steps.map(([title, body], index) => `<label class="checklist-row"><input type="checkbox" data-onboarding-check="${index}" ${onboardingChecks.has(index) ? 'checked' : ''}/><span class="check-control">${icon('check')}</span><span><strong>${title}</strong><small>${body}</small></span></label>`).join('')}</div><div id="onboarding-detection" class="onboarding-detection ${matching.length ? 'connected' : ''}">${matching.length ? `${icon('check')} ${platformName(surveyPhone)} detected over USB.` : `${icon('cable')} ${isPreview ? 'USB detection is available in the desktop app.' : 'Connect your phone when you’re ready.'}`}</div><div class="onboarding-actions"><button id="onboarding-scan" class="secondary-button" ${pending || state.busy ? 'disabled' : ''}>${icon(pending ? 'loader-circle' : 'refresh-cw', pending ? 'spin' : '')} Check connection</button><button id="onboarding-finish" class="primary-button inline" ${pending ? 'disabled' : ''}><span>Continue to map</span>${icon('arrow-right')}</button></div>`);
    $('#onboarding-back').onclick = () => { onboardingStep = 'survey'; renderOnboarding(); paintIcons(); };
    document.querySelectorAll('[data-onboarding-check]').forEach((checkbox) => { checkbox.onchange = () => { const index = Number(checkbox.dataset.onboardingCheck); if (checkbox.checked) onboardingChecks.add(index); else onboardingChecks.delete(index); }; });
    $('#onboarding-scan').onclick = async () => { const result = await runOperation(() => api.scanDevices()); if (result && !result.devices.some((device) => device.platform === surveyPhone && device.state !== 'offline')) $('#onboarding-detection').innerHTML = `${icon('help-circle')} No ${platformName(surveyPhone)} found. Check the cable, unlock the phone, and accept its prompt.`; paintIcons(); };
    $('#onboarding-finish').onclick = async () => {
      const result = await runOperation(() => api.updatePreferences({ onboardingComplete: true, hostPlatform: surveyHost, phonePlatform: surveyPhone }));
      if (result) { setupHost = surveyHost; setupPlatform = surveyPhone; $('#onboarding-dialog').close(); }
    };
  }
}

function renderView() {
  const showingSaved = currentView === 'saved';
  $('.control-panel').classList.toggle('show-saved', showingSaved);
  $('#saved-nav-button').classList.toggle('active', showingSaved);
  $('#saved-nav-button').setAttribute('aria-pressed', String(showingSaved));
  $('#panel-eyebrow').textContent = showingSaved ? 'Library' : 'Location';
  $('#panel-title').textContent = showingSaved ? 'Saved places' : locationMode === 'route' ? 'Follow a route' : 'Set a location';
  $('#panel-subtitle').textContent = showingSaved ? 'Select a place to return to the map.' : locationMode === 'route' ? 'Choose stops. Move along the road at 45 mph.' : 'Choose a phone and a point on the map.';
}

function renderConnections() {
  const mode = state.preferences.connection || 'usb';
  const blocked = pending || state.busy || Boolean(state.session);
  $('#connection-options').textContent = `Connection: ${mode === 'wifi' ? 'Wi-Fi' : 'USB'} · Change`;
  document.querySelectorAll('[data-connection]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.connection === mode));
    button.disabled = blocked;
  });
  $('#wifi-status').textContent = state.session ? 'Restore real location before changing connection methods. A disconnected Android phone can be reconnected below.' : pending || state.busy ? 'Checking the connection…' : `Using ${mode === 'wifi' ? 'Wi-Fi' : 'USB'}. ${state.devices.length} phone${state.devices.length === 1 ? '' : 's'} found.`;
  $('#enable-iphone-wifi').disabled = blocked || mode !== 'usb' || state.devices.find(device => device.id === selectedDeviceId)?.platform !== 'ios';
  const recoveringAndroid = state.session?.platform === 'android' && state.session?.connection === 'wifi' && ['waiting', 'unknown', 'error'].includes(state.session?.status);
  $('#wifi-pair-button').disabled = $('#wifi-connect-button').disabled = pending || state.busy || (Boolean(state.session) && !recoveringAndroid) || mode !== 'wifi';
  $('#wifi-refresh').disabled = pending || state.busy;
  $('#wifi-ios').hidden = $('#wifi-phone').value !== 'ios';
  $('#wifi-android').hidden = $('#wifi-phone').value !== 'android';
}

function render() { renderConnections(); renderView(); renderDevices(); renderDestination(); renderActions(); renderRoute(); renderSaved(); renderSession(); renderRuntime(); renderSetup(); if ($('#onboarding-dialog').open) renderOnboarding(); paintIcons(); }

function openOnboarding() {
  surveyHost = state.preferences.hostPlatform || detectedHost;
  surveyPhone = state.preferences.phonePlatform || state.devices[0]?.platform || null;
  onboardingStep = 'survey';
  onboardingChecks.clear();
  if ($('#setup-dialog').open) $('#setup-dialog').close();
  renderOnboarding();
  paintIcons();
  if (!$('#onboarding-dialog').open) $('#onboarding-dialog').showModal();
}

function openSetup() {
  if (state.preferences.connection === 'wifi') { $('#connection-options').click(); return; }
  if (!state.preferences.hostPlatform || !state.preferences.phonePlatform) { openOnboarding(); return; }
  setupHost = state.preferences.hostPlatform;
  setupPlatform = state.preferences.phonePlatform;
  renderSetup();
  paintIcons();
  if (!$('#setup-dialog').open) $('#setup-dialog').showModal();
}

let placeBeingSaved = null;
function openSave(place = selectedPlace) {
  if (!place) return;
  placeBeingSaved = { ...place };
  $('#save-title').textContent = place.id ? 'Rename place' : 'Save this place';
  $('#place-name').value = place.label;
  $('#place-id').value = place.id || '';
  $('#save-coordinates').textContent = `${formatCoordinate(place.latitude)} · ${formatCoordinate(place.longitude, false)}`;
  $('#save-dialog').showModal();
  $('#place-name').select();
}

map.on('click', (event) => { const point = event.latlng.wrap(); selectPlace({ latitude: point.lat, longitude: point.lng, label: 'Dropped pin' }, false); });
map.on('moveend', () => { const center = map.getCenter().wrap(); $('#map-coordinates').textContent = `${formatCoordinate(center.lat)} · ${formatCoordinate(center.lng, false)}`; });
map.on('dragstart', () => { $('#search-results').hidden = true; });
$('#zoom-in').onclick = () => map.zoomIn();
$('#zoom-out').onclick = () => map.zoomOut();
$('#recenter-button').onclick = () => {
  if (locationMode === 'route' && routeDot) map.flyTo(routeDot.getLatLng(), Math.max(14, map.getZoom()));
  else if (locationMode === 'route' && routeLine) fitRoute();
  else map.flyTo(selectedPlace ? [selectedPlace.latitude, selectedPlace.longitude] : [41.8827, -87.6233], selectedPlace ? Math.max(13, map.getZoom()) : 13, { duration: 0.6 });
};
$('#retry-map').onclick = () => { tileErrors = 0; $('#map-error').hidden = true; tiles.redraw(); };
$('#connection-badge').onclick = openSetup;
$('#help-button').onclick = openSetup;
$('#settings-button').onclick = () => { $('#provider-url').value = state.preferences.geocoderUrl || 'https://photon.komoot.io/api/'; renderRuntime(); paintIcons(); $('#settings-dialog').showModal(); };
$('#scan-button').onclick = () => runOperation(() => api.scanDevices(), 'Device list refreshed.');
$('#setup-scan').onclick = async () => { const result = await runOperation(() => api.scanDevices()); if (result && !result.devices.some((device) => device.platform === setupPlatform && device.state !== 'offline')) $('#setup-detection').textContent = `No ${platformName(setupPlatform)} found. Check the data cable, unlock the phone, and accept its prompt.`; };
$('#change-configuration').onclick = openOnboarding;
$('#rerun-onboarding').onclick = () => { $('#settings-dialog').close(); openOnboarding(); };
$('#save-button').onclick = () => openSave();
$('#apply-button').onclick = () => { if (selectedPlace && selectedDeviceId) runOperation(() => api.applyLocation({ deviceId: selectedDeviceId, ...selectedPlace })); };
document.querySelectorAll('[data-location-mode]').forEach(button => { button.onclick = () => { locationMode = button.dataset.locationMode; drawRoute(); render(); }; });
$('#add-route-stop').onclick = () => {
  if (!selectedPlace || routeStops.length >= 12) return;
  routeStops.push({ ...selectedPlace }); routePlan = null; drawRoute(); renderRoute(); paintIcons();
};
$('#clear-route').onclick = () => { routeStops = []; routePlan = null; drawRoute(); renderRoute(); paintIcons(); };
$('#plan-route').onclick = async () => {
  const planned = await runOperation(() => api.planRoute(routeStops));
  if (planned) { routePlan = planned; drawRoute(); fitRoute(); renderRoute(); paintIcons(); }
};
$('#route-play').onclick = () => runOperation(() => state.route?.status === 'running' ? api.pauseRoute() : state.route?.status === 'paused' ? api.resumeRoute() : api.startRoute({ deviceId: selectedDeviceId, routeId: routePlan?.id }));
$('#restore-button').onclick = () => runOperation(() => api.stopLocation(), 'Restore command accepted. Phone apps may need a moment to refresh.', 'restore');
$('#toast-close').onclick = () => { $('#toast').hidden = true; clearTimeout(toastTimer); };
$('#install-runtime').onclick = () => runOperation(() => api.installRuntime(), 'Device tools checked.');
$('#restore-preference').onchange = () => runOperation(() => api.updatePreferences({ restoreOnQuit: $('#restore-preference').checked }));
$('#provider-form').onsubmit = (event) => { event.preventDefault(); const url = $('#provider-url').value.trim(); try { if (new URL(url).protocol !== 'https:') throw new Error(); } catch { notify('Use a valid HTTPS URL for your search provider.', true); return; } runOperation(() => api.updatePreferences({ geocoderUrl: url }), 'Search endpoint saved.'); };
$('#reset-provider').onclick = () => { $('#provider-url').value = 'https://photon.komoot.io/api/'; runOperation(() => api.updatePreferences({ geocoderUrl: 'https://photon.komoot.io/api/' }), 'Default search endpoint restored.'); };
$('#save-form').onsubmit = async (event) => { event.preventDefault(); const label = $('#place-name').value.trim(); if (!label || !placeBeingSaved) return; const result = await runOperation(() => api.savePlace({ ...placeBeingSaved, label }), 'Place saved.'); if (result) $('#save-dialog').close(); };
$('#coordinate-form').onsubmit = (event) => { event.preventDefault(); selectPlace({ latitude: $('#latitude').value, longitude: $('#longitude').value, label: 'Custom coordinates' }); };

function setView(view) {
  currentView = view;
  renderView();
  renderSaved();
  paintIcons();
  $('.panel-scroll').scrollTo({ top: 0, behavior: 'smooth' });
}
$('#saved-nav-button').onclick = () => setView(currentView === 'saved' ? 'map' : 'saved');
$('#view-saved-button').onclick = () => setView(currentView === 'saved' ? 'map' : 'saved');
$('.wordmark').onclick = (event) => { event.preventDefault(); setView('map'); };
document.querySelectorAll('[data-close]').forEach((button) => { button.onclick = () => document.getElementById(button.dataset.close).close(); });
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (dialog.id === 'onboarding-dialog' && state.preferences.onboardingComplete !== true) return;
  if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); }
}));
$('#onboarding-dialog').addEventListener('cancel', (event) => { if (state.preferences.onboardingComplete !== true) event.preventDefault(); });

$('#connection-options').onclick = () => {
  $('#wifi-phone').value = setupPlatform || 'ios';
  renderConnections();
  $('#wifi-dialog').showModal();
};
$('#wifi-phone').onchange = renderConnections;
$('#wifi-dialog').addEventListener('close', () => { $('#wifi-pair-code').value = ''; });
document.querySelectorAll('[data-connection]').forEach(button => {
  button.onclick = () => runOperation(() => api.setConnection(button.dataset.connection));
});
$('#enable-iphone-wifi').onclick = () => runOperation(() => api.connectWifi({platform: 'ios', deviceId: selectedDeviceId}), 'Wi-Fi enabled. Choose Wi-Fi above to find your iPhone.');
$('#wifi-pair-form').onsubmit = async event => {
  event.preventDefault();
  const code = $('#wifi-pair-code').value;
  $('#wifi-pair-code').value = '';
  await runOperation(() => api.connectWifi({platform: 'android', endpoint: $('#wifi-pair-address').value.trim(), code}), 'Paired. Now connect using the port on the main Wireless debugging screen.');
};
$('#wifi-connect-form').onsubmit = event => {
  event.preventDefault();
  runOperation(() => api.connectWifi({platform: 'android', endpoint: $('#wifi-connect-address').value.trim()}), 'Connected. Close this panel and select your phone.');
};
$('#wifi-refresh').onclick = () => runOperation(() => api.scanDevices());

$('#search-form').onsubmit = async (event) => {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) { $('#search-input').focus(); return; }
  const coordinates = query.match(/^(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)$/);
  if (coordinates) { selectPlace({ latitude: Number(coordinates[1]), longitude: Number(coordinates[2]), label: 'Custom coordinates' }); return; }
  const request = ++searchNumber;
  $('#search-submit').disabled = true;
  $('#search-results').hidden = false;
  $('#search-results').innerHTML = `<div class="search-message">${icon('loader-circle', 'spin')} Searching…</div>`;
  paintIcons();
  try {
    const results = await api.searchPlaces(query);
    if (request !== searchNumber) return;
    $('#search-results').innerHTML = results.length ? results.slice(0, 7).map((place, index) => `<button class="search-result" data-result="${index}">${icon('map-pin')}<span><strong>${esc(place.label)}</strong><small>${Number(place.latitude).toFixed(5)}, ${Number(place.longitude).toFixed(5)}</small></span>${icon('arrow-up-right')}</button>`).join('') + '<div class="search-attribution">Search by Photon · © OpenStreetMap</div>' : '<div class="search-message">No places found. Try a nearby city or coordinates.</div>';
    document.querySelectorAll('[data-result]').forEach((button) => { button.onclick = () => { const place = results[Number(button.dataset.result)]; selectPlace(place); $('#search-input').value = place.label; }; });
  } catch (error) {
    if (request !== searchNumber) return;
    $('#search-results').innerHTML = `<div class="search-message search-error">${icon('help-circle')}<span>${esc(error.message || 'Search is unavailable. Try again, or enter coordinates.')}</span></div>`;
  } finally {
    if (request === searchNumber) { $('#search-submit').disabled = false; paintIcons(); }
  }
};
$('#search-input').onkeydown = (event) => { if (event.key === 'Escape') { $('#search-results').hidden = true; ++searchNumber; $('#search-submit').disabled = false; } else if (event.key === 'ArrowDown') { const first = $('.search-result'); if (first) { event.preventDefault(); first.focus(); } } };
$('#search-results').onkeydown = (event) => { const buttons = [...document.querySelectorAll('.search-result')]; const index = buttons.indexOf(document.activeElement); if (event.key === 'ArrowDown') { event.preventDefault(); buttons[Math.min(index + 1, buttons.length - 1)]?.focus(); } if (event.key === 'ArrowUp') { event.preventDefault(); if (index <= 0) $('#search-input').focus(); else buttons[index - 1]?.focus(); } if (event.key === 'Escape') { $('#search-results').hidden = true; $('#search-input').focus(); } };
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.search-wrapper')) $('#search-results').hidden = true; });
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search-input').focus(); $('#search-input').select(); } });
const resizeObserver = new ResizeObserver(() => map.invalidateSize());
resizeObserver.observe($('.map-workspace'));
api.onState(acceptState);
render();
api.getState().then(async next => {
  acceptState(next);
  if (api.getRoute) {
    const planned = await api.getRoute();
    if (planned) { routePlan = planned; routeStops = planned.waypoints; drawRoute(); renderRoute(); paintIcons(); }
  }
}).catch((error) => notify(`Ghost could not initialize: ${error.message}`, true));
