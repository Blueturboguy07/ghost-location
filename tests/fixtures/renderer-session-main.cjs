// Isolated renderer harness: this entry point never imports the production main
// process, device adapters, or sidecar. It must not discover or control a phone.
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

if (!process.env.GHOST_RENDERER_TEST_DATA || !process.env.GHOST_RENDERER_DIST) {
  throw new Error('Run this fixture through npm run test:renderer-session.');
}
app.setPath('userData', process.env.GHOST_RENDERER_TEST_DATA);
app.commandLine.appendSwitch('disable-background-networking');

app.whenReady().then(async () => {
  const isolation = { mode: 'no-phone-no-network', blockedRequests: 0 };
  globalThis.ghostRendererFixture = isolation;
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_request, callback) => {
      isolation.blockedRequests += 1;
      callback({ cancel: true });
    },
  );

  const window = new BrowserWindow({
    title: 'Ghost renderer fixture — no phone connection',
    width: 1440,
    height: 940,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer-session-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(process.env.GHOST_RENDERER_DIST, 'index.html'));
}).catch(error => {
  console.error(error);
  app.exit(1);
});
