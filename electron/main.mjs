import { app, BrowserWindow, ipcMain, protocol, net, session, dialog, Menu, shell, powerMonitor, powerSaveBlocker } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from '../backend/store.mjs';
import { Controller } from '../backend/controller.mjs';
import { Geocoder } from '../backend/geocoder.mjs';
import { IosAdapter } from '../backend/ios.mjs';
import { AndroidAdapter } from '../backend/android.mjs';
import { run } from '../backend/process.mjs';
import { wifiStatus } from '../backend/network.mjs';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devUrl = !app.isPackaged && process.env.GHOST_DEV_URL === 'http://127.0.0.1:5173' ? process.env.GHOST_DEV_URL : null;
if (!app.isPackaged) app.setPath('userData', process.env.GHOST_TEST_DATA || path.join(rootPath, '.ghost-dev'));
app.setName('Ghost');
protocol.registerSchemesAsPrivileged([{ scheme: 'ghost', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let window, controller, poll, wakeLock, quitting = false, quitPending = false;
const geocoder = new Geocoder();
const allowedExternal = new Set(['github.com', 'developer.android.com', 'developer.apple.com', 'support.apple.com', 'www.openstreetmap.org', 'openstreetmap.org', 'photon.komoot.io', 'doronz88.github.io']);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(boot).catch(error => { dialog.showErrorBox('Ghost could not start', error.message); app.exit(1); });
}

async function boot() {
  const dist = path.join(rootPath, 'dist');
  protocol.handle('ghost', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
    const target = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(`${dist}${path.sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
  const csp = `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self'${devUrl ? ' ws://127.0.0.1:5173' : ''}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const options = { rootPath, resourcesPath: app.isPackaged ? process.resourcesPath : path.join(rootPath, 'resources') };
  const callbacks = { onSessionEnd: event => controller?.sessionEnded(event), onLocationRefresh: event => controller?.locationRefreshed(event) };
  const ios = new IosAdapter({ ...options, ...callbacks });
  const android = new AndroidAdapter({ ...options, ...callbacks });
  controller = new Controller({ adapters: { ios, android }, network: wifiStatus, store: new Store(path.join(app.getPath('userData'), 'settings.json')) });
  controller.on('state', state => {
    const active = state.session && ['active', 'applying', 'reconnecting'].includes(state.session.status);
    if (active && wakeLock == null) wakeLock = powerSaveBlocker.start('prevent-app-suspension');
    if (!active && wakeLock != null) { powerSaveBlocker.stop(wakeLock); wakeLock = null; }
    if (window && !window.isDestroyed()) window.webContents.send('ghost:state', state);
  });

  const handlers = {
    getState: () => controller.snapshot(),
    switchToWifi: id => controller.switchToWifi(id),
    setConnection: value => controller.setConnection(value),
    connectWifi: value => controller.connectWifi(value),
    scanDevices: () => controller.scanDevices(),
    prepareDevice: id => controller.prepareDevice(id),
    applyLocation: value => controller.applyLocation(value),
    stopLocation: () => controller.stopLocation(),
    getRoute: () => controller.getRoute(),
    planRoute: value => controller.planRoute(value),
    startRoute: value => controller.startRoute(value),
    pauseRoute: () => controller.pauseRoute(),
    resumeRoute: () => controller.resumeRoute(),
    searchPlaces: query => { geocoder.configure(controller.state.preferences.geocoderUrl || 'https://photon.komoot.io/api/'); return geocoder.search(query); },
    savePlace: value => controller.savePlace(value),
    deletePlace: id => controller.deletePlace(id),
    updatePreferences: value => controller.updatePreferences(value),
    installRuntime: () => controller.exclusive(async () => {
      if (controller.state.session) throw new Error('Restore the current phone session first.');
      if (app.isPackaged) throw new Error('The desktop release includes its device tools. If they are missing, reinstall a complete Ghost build.');
      const result = await run(process.execPath, [path.join(rootPath, 'scripts/prepare-runtime.mjs')], {
        cwd: rootPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 900000, maxOutputBytes: 8_000_000
      });
      if (result.code !== 0) throw new Error(`Could not prepare device tools. Run npm run runtime:prepare in the project terminal. ${result.stderr.slice(-500)}`);
      return controller.scan();
    })
  };
  for (const [method, handler] of Object.entries(handlers)) ipcMain.handle(`ghost:${method}`, async (event, value) => {
    const senderUrl = event.senderFrame?.url || '';
    const trusted = window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
      (devUrl ? new URL(senderUrl).origin === devUrl : senderUrl.startsWith('ghost://app/'));
    if (!trusted) return { ok: false, error: 'Untrusted request.' };
    try { return { ok: true, data: await handler(value) }; }
    catch (error) { return { ok: false, error: error.message || 'Operation failed.' }; }
  });

  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 680, backgroundColor: '#f8f9fb', show: false,
    title: 'Ghost — Your location, on your terms', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 22 },
    ...(process.platform === 'win32' ? { titleBarOverlay: { color: '#f8f9fb', symbolColor: '#1d1d1f', height: 58 } } : {}),
    webPreferences: { preload: path.join(rootPath, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} GhostLocation/${app.getVersion()}`);
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { const parsed = new URL(url); if (parsed.protocol === 'https:' && allowedExternal.has(parsed.hostname)) shell.openExternal(parsed.href); } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('render-process-gone', () => {
    if (controller.state.session) controller.sessionEnded({ deviceId: controller.state.session.deviceId, retry: false, error: 'The interface stopped unexpectedly. Reopen Ghost and retry or restore the phone location.' });
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Ghost', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]));
  // Load the UI immediately; device discovery must not hold the window hostage.
  if (devUrl) await window.loadURL(devUrl);
  else if (existsSync(path.join(dist, 'index.html'))) await window.loadURL('ghost://app/index.html');
  else throw new Error('Build the interface first with npm run build.');
  await controller.init();
  poll = setInterval(() => controller.scanDevices().catch(error => { controller.state.warning = error.message; controller.notify(); }), 2000);
  powerMonitor.on('suspend', () => controller.suspend().catch(() => {}));
  powerMonitor.on('resume', () => controller.resume().catch(() => {}));
}

app.on('before-quit', event => {
  if (quitting || !controller) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  finishQuit().finally(() => { quitPending = false; });
});

async function finishQuit() {
  if (controller.state.busy) {
    await dialog.showMessageBox(window, { type: 'info', message: 'A device operation is still running.', detail: 'Wait for it to finish before closing Ghost.', buttons: ['Keep Ghost open'] });
    return;
  }
  if (controller.state.session && controller.state.preferences.restoreOnQuit) {
    try { await controller.stopLocation(); }
    catch (error) {
      const answer = await dialog.showMessageBox(window, { type: 'warning', message: 'The phone location has not been restored.', detail: `${error.message}\n\nReconnect your phone to restore it. Quitting now will keep this session marked for recovery.`, buttons: ['Keep Ghost open', 'Quit anyway'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
  }
  if (controller.state.session) await controller.sessionEnded({ deviceId: controller.state.session.deviceId, retry: false, error: 'Ghost quit without confirming restoration. Reconnect this phone and choose Retry location or Restore.' });
  clearInterval(poll);
  if (wakeLock != null) { powerSaveBlocker.stop(wakeLock); wakeLock = null; }
  await Promise.race([controller.dispose({ restore: false }), new Promise(resolve => setTimeout(resolve, 6000))]);
  quitting = true; app.quit();
}
