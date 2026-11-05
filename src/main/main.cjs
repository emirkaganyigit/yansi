const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, powerMonitor, session, shell } = require('electron');
const { createSystemAudioCapture } = require('./system-audio.cjs');

const rootDirectory = path.resolve(__dirname, '../..');
const rendererFile = path.join(rootDirectory, 'src/renderer/index.html');
const rendererUrl = pathToFileURL(rendererFile).href;
const developmentData = process.env.YANSI_DATA_DIR;
if (developmentData) {
  app.setPath('userData', path.resolve(developmentData, 'profile'));
  app.setPath('sessionData', path.resolve(developmentData, 'session'));
  app.setPath('logs', path.resolve(developmentData, 'logs'));
}
app.setName('Yansı');

let mainWindow = null;
let server = null;
let serverStarting = null;
let shuttingDown = false;
let downloadDirectory;
let lastError = null;
const filePaths = new Map();
const systemAudio = createSystemAudioCapture();
let pendingAudioPackets = 0;

function stopSystemAudio() {
  systemAudio.stop();
  pendingAudioPackets = 0;
}

function emit(event) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('yansi:event', event);
}

function getState() {
  if (server) return { ...server.getState(), running: true, lastError };
  return { running: false, port: null, addresses: [], viewers: [], files: [], sharing: false, downloadDirectory, lastError };
}

function onServerEvent(event) {
  if (event.type === 'file-received' && event.file?.id && event.path) filePaths.set(event.file.id, event.path);
  if (event.type === 'state-changed') emit({ type: 'state', state: getState() });
  else if (event.type === 'viewer-signal') emit({ ...event, type: 'signal' });
  else if (event.type === 'server-error') emit({ ...event, type: 'error' });
  else emit(event);
}

async function startServer() {
  if (server) return getState();
  if (serverStarting) return serverStarting;
  serverStarting = (async () => {
    try {
      const { createLanServer } = await import('../server/index.js');
      await fs.mkdir(downloadDirectory, { recursive: true });
      const requestedPort = Number(process.env.YANSI_PORT || 47831);
      if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Geçersiz bağlantı portu.');
      try {
        server = await createLanServer({ port: requestedPort, downloadDirectory, onEvent: onServerEvent });
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || !requestedPort) throw error;
        server = await createLanServer({ port: 0, downloadDirectory, onEvent: onServerEvent });
      }
      lastError = null;
      emit({ type: 'state', state: getState() });
      console.log(`Yansı hazır: ${server.addresses.map((entry) => entry.url).join(', ')}`);
      return getState();
    } catch (error) {
      lastError = error.message;
      emit({ type: 'error', message: `Yerel bağlantı başlatılamadı: ${error.message}` });
      emit({ type: 'state', state: getState() });
      throw error;
    } finally { serverStarting = null; }
  })();
  return serverStarting;
}

async function stopServer() {
  stopSystemAudio();
  if (serverStarting) await serverStarting.catch(() => {});
  const closingServer = server;
  server = null;
  if (closingServer) await closingServer.close();
  filePaths.clear();
  emit({ type: 'state', state: getState() });
  return getState();
}

function requireServer() {
  if (!server) throw new Error('Önce yerel bağlantıyı başlatın.');
  return server;
}

function assertHost(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame?.url !== rendererUrl) {
    throw new Error('Bu işlem yalnız masaüstü uygulamasından yapılabilir.');
  }
}

function handle(command, handler) {
  ipcMain.handle(`yansi:${command}`, async (event, ...args) => {
    assertHost(event);
    return handler(...args);
  });
}

async function addFiles(paths) {
  const active = requireServer();
  if (!Array.isArray(paths) || paths.length > 100 || paths.some((item) => typeof item !== 'string' || !path.isAbsolute(item))) {
    throw new Error('Geçerli dosyalar seçin.');
  }
  const files = [];
  for (const filePath of paths) {
    const file = await active.registerSharedFile(filePath);
    filePaths.set(file.id, filePath);
    files.push(file);
  }
  return files;
}

function configureIpc() {
  handle('get-state', getState);
  handle('start-server', startServer);
  handle('stop-server', stopServer);
  handle('choose-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Paylaşılacak dosyaları seçin', properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : addFiles(result.filePaths);
  });
  handle('add-files', addFiles);
  handle('remove-file', async (id) => {
    if (typeof id !== 'string') throw new Error('Geçersiz dosya.');
    await requireServer().removeFile(id);
    filePaths.delete(id);
    return getState();
  });
  handle('open-file', async (id) => {
    const file = requireServer().listFiles().find((item) => item.id === id);
    if (!file) throw new Error('Dosya bulunamadı.');
    const location = filePaths.get(id);
    if (!location) throw new Error('Dosya konumu bulunamadı.');
    const error = await shell.openPath(location);
    if (error) throw new Error(error);
  });
  handle('open-downloads', async () => {
    await fs.mkdir(downloadDirectory, { recursive: true });
    const error = await shell.openPath(downloadDirectory);
    if (error) throw new Error(error);
  });
  handle('copy-text', (text) => {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('Geçersiz metin.');
    clipboard.writeText(text);
  });
  handle('approve-viewer', (id) => requireServer().approveViewer(id));
  handle('reject-viewer', (id) => requireServer().rejectViewer(id));
  handle('disconnect-viewer', (id) => requireServer().disconnectViewer(id));
  handle('send-signal', (id, payload) => requireServer().broadcastHostSignal(id, payload));
  handle('set-sharing', (sharing) => {
    if (typeof sharing !== 'boolean') throw new Error('Geçersiz paylaşım durumu.');
    requireServer().setSharing(sharing);
    if (!sharing) stopSystemAudio();
    return getState();
  });
  handle('start-system-audio', async () => {
    requireServer();
    pendingAudioPackets = 0;
    return systemAudio.start({
      onData: (bytes) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        // Keep at most 160 ms of 48 kHz stereo PCM queued across the IPC bridge.
        const packetSize = 7680;
        for (let offset = 0; offset < bytes.length; offset += packetSize) {
          if (pendingAudioPackets >= 8) break;
          pendingAudioPackets++;
          mainWindow.webContents.send('yansi:audio-data', new Uint8Array(bytes.subarray(offset, offset + packetSize)));
        }
      },
      onError: (error) => { stopSystemAudio(); emit({ type: 'audio-error', message: error.message }); }
    });
  });
  handle('stop-system-audio', () => { stopSystemAudio(); });
  ipcMain.on('yansi:audio-ack', (event) => {
    try { assertHost(event); pendingAudioPackets = Math.max(0, pendingAudioPackets - 1); } catch { /* Untrusted frames cannot control capture. */ }
  });
}

function configureCapture() {
  const hostSession = session.fromPartition('yansi-host');
  const allowedPermissions = new Set(['display-capture', 'local-network', 'local-network-access', 'loopback-network']);
  hostSession.setPermissionCheckHandler((webContents, permission) => webContents === mainWindow?.webContents && allowedPermissions.has(permission));
  hostSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(webContents === mainWindow?.webContents && allowedPermissions.has(permission));
  });
  hostSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (request.frame !== mainWindow?.webContents.mainFrame || request.frame?.url !== rendererUrl || !request.videoRequested) {
        callback(null);
        return;
      }
      // On Wayland the portal presents the system's screen/window picker.
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length) { callback(null); return; }
      callback({ video: sources[0] });
    } catch (error) {
      callback(null);
      emit({ type: 'error', message: `Ekran seçimi tamamlanamadı: ${error.message}` });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'Yansı', width: 1280, height: 850, minWidth: 880, minHeight: 650,
    backgroundColor: '#f5f6f3', autoHideMenuBar: true,
    icon: path.join(rootDirectory, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      partition: 'yansi-host', contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, backgroundThrottling: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => { stopSystemAudio(); stopServer().catch(() => {}); });
  mainWindow.webContents.on('destroyed', stopSystemAudio);
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile(rendererFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    // HTTP User-Agent fields must stay ASCII even though the native product name is Turkish.
    app.userAgentFallback = app.userAgentFallback.replace(/Yansı/g, 'Yansi').replace(/[^\x20-\x7e]/g, '');
    downloadDirectory = developmentData ? path.resolve(developmentData, 'received') : path.join(app.getPath('downloads'), 'Yansi');
    configureIpc();
    configureCapture();
    createWindow();
    await startServer().catch(() => {});
    powerMonitor.on('lock-screen', () => { stopSystemAudio(); server?.setSharing(false); emit({ type: 'stop-sharing', reason: 'Bilgisayar kilitlendi.' }); });
    powerMonitor.on('suspend', () => { stopSystemAudio(); server?.setSharing(false); emit({ type: 'stop-sharing', reason: 'Bilgisayar uykuya geçiyor.' }); });
  }).catch((error) => { console.error(error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (shuttingDown || !server) return;
    event.preventDefault();
    shuttingDown = true;
    stopServer().finally(() => app.quit());
  });
}
