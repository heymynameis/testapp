const { app, BrowserWindow, dialog  } = require('electron');
const net = require('net');


const PORT = 3000;
process.env.DATA_DIR = app.getPath('userData');
process.env.PORT = String(PORT);


if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

function canConnect() {
  return new Promise(resolve => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canConnect()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Сервер не запустился за ' + timeoutMs / 1000 + ' с');
}

app.whenReady().then(async () => {
  try {
    require('./server.js');
    await waitForServer();
    const win = new BrowserWindow({ width: 600, height: 800, useContentSize: true, autoHideMenuBar: true, webPreferences: {zoomFactor: 0.9} });
    win.loadURL(`http://127.0.0.1:${PORT}`);
  } catch (e) {
    dialog.showErrorBox('Ошибка запуска', String(e && e.stack || e));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());