import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rename, unlink, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

const APP_NAME = 'Yansı';
const PUBLIC_DIRECTORY = path.resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const MAX_SIGNAL_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 16;
const MAX_APPROVED_VIEWERS = 1;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

function fileMime(name) {
  return MIME_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function safeFilename(rawName) {
  // Interpret both path separators, including those supplied by a remote platform.
  const leaf = String(rawName || 'dosya').replace(/\\/g, '/').split('/').pop();
  const cleaned = leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  const characters = [...(cleaned || 'dosya')];
  while (Buffer.byteLength(characters.join('')) > 160) characters.pop();
  return characters.join('');
}

function publicFile(file) {
  const { id, name, size, mime, createdAt, source, direction } = file;
  return { id, name, size, mime, createdAt, source, direction };
}

function publicViewer(viewer) {
  const { id, name, address, status, connectedAt } = viewer;
  return { id, name, address, status, connectedAt };
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function error(response, status, code, message) {
  json(response, status, { error: message, code });
}

function tokenEquals(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function getAddresses(port, bindHost) {
  if (bindHost !== '0.0.0.0' && bindHost !== '::') {
    const address = bindHost === 'localhost' ? '127.0.0.1' : bindHost;
    return [{ name: 'Yerel bağlantı', address, url: `http://${address.includes(':') ? `[${address}]` : address}:${port}` }];
  }
  const result = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      result.push({ name, address: entry.address, url: `http://${entry.address}:${port}` });
    }
  }
  if (!result.length) result.push({ name: 'Bu bilgisayar', address: '127.0.0.1', url: `http://127.0.0.1:${port}` });
  return result;
}

/**
 * Start the LAN receiver and file service. Host control stays inside Electron;
 * no HTTP route can approve peers, start capture, or register filesystem paths.
 */
export async function createLanServer({
  port = 47831,
  bindHost = '0.0.0.0',
  downloadDirectory = path.join(os.homedir(), 'Downloads', 'Yansi'),
  onEvent = () => {},
  maxFileBytes = 1024 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error('maxFileBytes pozitif bir tamsayı olmalı.');
  await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
  const resolvedDownloadDirectory = await realpath(downloadDirectory);
  const hostName = os.hostname();
  const viewers = new Map();
  const files = new Map();
  const activeUploads = new Set();
  let sharing = false;
  let running = false;
  let actualPort = port;
  let addresses = [];
  let closing = false;

  const listFiles = () => [...files.values()].map(publicFile);
  const getState = () => ({
    appName: APP_NAME, hostName, running, port: actualPort, addresses,
    sharing, viewers: [...viewers.values()].map(publicViewer), files: listFiles(),
    downloadDirectory: resolvedDownloadDirectory,
  });
  const emit = (event) => {
    try { onEvent(event); } catch (cause) { console.error('Yansı olay işleyicisi:', cause.message); }
  };
  const emitState = () => emit({ type: 'state-changed', state: getState() });
  const send = (viewer, value) => {
    if (viewer.socket.readyState === WebSocket.OPEN) viewer.socket.send(JSON.stringify(value));
  };
  const sendApproved = (value) => {
    for (const viewer of viewers.values()) if (viewer.status === 'approved') send(viewer, value);
  };
  const revokeViewer = (viewer) => {
    viewer.token = undefined;
    for (const abort of viewer.transfers) abort();
    viewer.transfers.clear();
  };
  const filesChanged = () => {
    sendApproved({ type: 'files-changed', files: listFiles() });
    emitState();
  };
  const authorizedViewer = (request, url, allowQuery = false) => {
    const bearer = /^Bearer (.+)$/i.exec(request.headers.authorization || '')?.[1];
    const token = bearer || (allowQuery ? url.searchParams.get('token') : null);
    if (!token || token.length > 256) return undefined;
    return [...viewers.values()].find((viewer) => viewer.status === 'approved' && tokenEquals(viewer.token, token));
  };

  async function serveFile(request, response, file, viewer) {
    let info;
    try { info = await stat(file.path); } catch {
      return error(response, 404, 'FILE_NOT_FOUND', 'Dosya artık bu bilgisayarda bulunamıyor.');
    }
    if (!info.isFile()) return error(response, 404, 'FILE_NOT_FOUND', 'Dosya bulunamadı.');
    if (viewer.status !== 'approved') return error(response, 401, 'UNAUTHORIZED', 'Cihazın bağlantısı kesildi.');
    let start = 0;
    let end = Math.max(0, info.size - 1);
    let status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) {
        response.setHeader('Content-Range', `bytes */${info.size}`);
        return error(response, 416, 'INVALID_RANGE', 'İstenen dosya aralığı geçersiz.');
      }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), end);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        response.setHeader('Content-Range', `bytes */${info.size}`);
        return error(response, 416, 'INVALID_RANGE', 'İstenen dosya aralığı geçersiz.');
      }
      status = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    response.setHeader('Content-Type', file.mime);
    response.setHeader('Content-Length', info.size === 0 ? 0 : end - start + 1);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    response.writeHead(status);
    if (request.method === 'HEAD' || info.size === 0) return response.end();
    const abort = () => response.destroy();
    viewer.transfers.add(abort);
    try { await pipeline(createReadStream(file.path, { start, end }), response); } catch {
      // A viewer closing its download must not bring down the server.
      response.destroy();
    } finally { viewer.transfers.delete(abort); }
  }

  async function receiveUpload(request, response, url, viewer) {
    if (activeUploads.size >= 4) return error(response, 429, 'UPLOAD_BUSY', 'Devam eden aktarım tamamlandıktan sonra tekrar deneyin.');
    const lengthText = request.headers['content-length'];
    const declaredLength = lengthText === undefined ? undefined : Number(lengthText);
    if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      return error(response, 400, 'INVALID_LENGTH', 'Dosya boyutu geçersiz.');
    }
    if (declaredLength > maxFileBytes) return error(response, 413, 'FILE_TOO_LARGE', 'Dosya boyutu izin verilen sınırı aşıyor.');
    const name = safeFilename(url.searchParams.get('name'));
    const id = randomUUID();
    const temporaryPath = path.join(resolvedDownloadDirectory, `.${id}.part`);
    const finalPath = path.join(resolvedDownloadDirectory, `${id}-${name}`);
    const upload = { request, temporaryPath, cancelled: false };
    activeUploads.add(upload);
    const abortTransfer = () => { upload.cancelled = true; request.destroy(); };
    viewer.transfers.add(abortTransfer);
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maxFileBytes) {
          const cause = new Error('FILE_TOO_LARGE');
          cause.code = 'FILE_TOO_LARGE';
          callback(cause);
        } else if (viewer.status !== 'approved' || upload.cancelled) {
          callback(new Error('UNAUTHORIZED'));
        } else callback(null, chunk);
      },
    });
    try {
      // Do not pipeline request directly: a size error must leave the socket alive
      // long enough to return HTTP 413. Only unread excess input is discarded.
      request.pipe(limit);
      const aborted = () => limit.destroy(new Error('UPLOAD_ABORTED'));
      request.once('aborted', aborted);
      request.once('error', aborted);
      try { await pipeline(limit, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })); }
      finally {
        request.removeListener('aborted', aborted);
        request.removeListener('error', aborted);
      }
      if (declaredLength !== undefined && size !== declaredLength) throw new Error('UPLOAD_ABORTED');
      if (viewer.status !== 'approved' || upload.cancelled) throw new Error('UNAUTHORIZED');
      await rename(temporaryPath, finalPath);
      const file = { id, name, size, mime: fileMime(name), path: finalPath, source: 'received', direction: 'upload', createdAt: new Date().toISOString() };
      files.set(id, file);
      emit({ type: 'file-received', file: publicFile(file), viewerId: viewer.id, path: finalPath });
      filesChanged();
      json(response, 201, { file: publicFile(file) });
    } catch (cause) {
      request.unpipe(limit);
      request.resume();
      await unlink(temporaryPath).catch(() => {});
      if (cause.code === 'FILE_TOO_LARGE') error(response, 413, 'FILE_TOO_LARGE', 'Dosya boyutu izin verilen sınırı aşıyor.');
      else if (cause.message === 'UNAUTHORIZED') error(response, 401, 'UNAUTHORIZED', 'Cihazın bağlantısı kesildi.');
      else if (!request.aborted) error(response, 400, 'UPLOAD_FAILED', 'Dosya aktarımı tamamlanamadı.');
    } finally { activeUploads.delete(upload); viewer.transfers.delete(abortTransfer); }
  }

  async function serveStatic(request, response, pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return error(response, 400, 'INVALID_PATH', 'Adres geçersiz.'); }
    if (decoded.includes('\0') || decoded.includes('\\')) return error(response, 400, 'INVALID_PATH', 'Adres geçersiz.');
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const candidate = path.resolve(PUBLIC_DIRECTORY, relative);
    const inside = (target) => target.startsWith(PUBLIC_DIRECTORY + path.sep) || target === PUBLIC_DIRECTORY;
    if (!inside(candidate)) return error(response, 403, 'FORBIDDEN', 'Bu adrese erişilemiyor.');
    let resolved;
    let info;
    try {
      resolved = await realpath(candidate);
      if (!inside(resolved)) return error(response, 403, 'FORBIDDEN', 'Bu adrese erişilemiyor.');
      info = await stat(resolved);
    } catch { return error(response, 404, 'NOT_FOUND', 'Sayfa bulunamadı.'); }
    if (!info.isFile()) return error(response, 404, 'NOT_FOUND', 'Sayfa bulunamadı.');
    response.writeHead(200, { 'Content-Type': fileMime(resolved), 'Content-Length': info.size });
    if (request.method === 'HEAD') return response.end();
    try { await pipeline(createReadStream(resolved), response); } catch { response.destroy(); }
  }

  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const task = async () => {
      let url;
      try { url = new URL(request.url, 'http://lan-mirror.local'); } catch { return error(response, 400, 'INVALID_URL', 'Adres geçersiz.'); }
      const { pathname } = url;
      if (pathname === '/health' && request.method === 'GET') return json(response, 200, { ok: true, appName: APP_NAME });
      if (pathname === '/api/status' && request.method === 'GET') {
        return json(response, 200, { appName: APP_NAME, hostName, pairingRequired: true, sharing, maxFileBytes, viewerLimit: MAX_APPROVED_VIEWERS });
      }
      if (pathname.startsWith('/api/')) {
        const isDownload = /^\/api\/files\/[^/]+$/.test(pathname) && ['GET', 'HEAD'].includes(request.method);
        const viewer = authorizedViewer(request, url, isDownload);
        if (!viewer) return error(response, 401, 'UNAUTHORIZED', 'Önce bilgisayardan bağlantınızı onaylayın.');
        if (pathname === '/api/files' && request.method === 'GET') return json(response, 200, { files: listFiles() });
        if (pathname === '/api/uploads' && request.method === 'POST') return receiveUpload(request, response, url, viewer);
        if (isDownload) {
          const id = pathname.split('/').pop();
          const file = files.get(id);
          if (!file) return error(response, 404, 'FILE_NOT_FOUND', 'Dosya bulunamadı.');
          return serveFile(request, response, file, viewer);
        }
        return error(response, 404, 'NOT_FOUND', 'İşlem bulunamadı.');
      }
      if (!['GET', 'HEAD'].includes(request.method)) return error(response, 405, 'METHOD_NOT_ALLOWED', 'Bu işlem desteklenmiyor.');
      return serveStatic(request, response, pathname);
    };
    task().catch((cause) => {
      emit({ type: 'server-error', message: cause.message });
      if (!response.headersSent) error(response, 500, 'SERVER_ERROR', 'İşlem tamamlanamadı.');
      else response.destroy();
    });
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNAL_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    if (closing || request.url !== '/signal' || viewers.size >= MAX_CONNECTIONS) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    // Block a random website from opening a connection into the local network.
    // Non-browser clients without Origin can still pair through host approval.
    const origin = request.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.headers.host) throw new Error('origin');
      } catch {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
    }
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request));
  });
  wss.on('connection', (socket, request) => {
    const viewer = {
      id: randomUUID(), socket, name: 'Tarayıcı', address: request.socket.remoteAddress?.replace(/^::ffff:/, '') || '',
      status: 'connecting', connectedAt: new Date().toISOString(), alive: true,
      token: undefined, messages: 0, windowStart: Date.now(), requested: false, transfers: new Set(),
    };
    viewers.set(viewer.id, viewer);
    send(viewer, { type: 'hello', appName: APP_NAME, hostName, pairingRequired: true, sharing });
    const helloTimer = setTimeout(() => socket.close(1008, 'Önce cihaz bilgisi gönderin.'), 15_000);
    helloTimer.unref();
    socket.on('pong', () => { viewer.alive = true; });
    socket.on('message', (data, binary) => {
      if (binary) return socket.close(1003, 'Metin mesajı gerekli.');
      const now = Date.now();
      if (now - viewer.windowStart > 10_000) { viewer.windowStart = now; viewer.messages = 0; }
      if (++viewer.messages > 200) return socket.close(1008, 'Çok fazla mesaj.');
      let message;
      try { message = JSON.parse(data.toString()); } catch { return socket.close(1007, 'Geçersiz JSON.'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.close(1007, 'Geçersiz mesaj.');
      if (message.type === 'hello' && !viewer.requested) {
        clearTimeout(helloTimer);
        viewer.name = String(message.name || 'Tarayıcı').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'Tarayıcı';
        viewer.status = 'pending';
        viewer.requested = true;
        send(viewer, { type: 'viewer-pending', viewerId: viewer.id });
        emit({ type: 'viewer-request', viewer: publicViewer(viewer), viewerId: viewer.id });
        emitState();
      } else if (message.type === 'signal') {
        if (viewer.status !== 'approved') return send(viewer, { type: 'error', code: 'NOT_APPROVED', message: 'Bağlantı onayı bekleniyor.' });
        const payload = message.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['offer', 'answer', 'candidate', 'renegotiate', 'ready', 'receiver-stats'].includes(payload.type)) {
          return send(viewer, { type: 'error', code: 'INVALID_SIGNAL', message: 'Sinyal geçersiz.' });
        }
        emit({ type: 'viewer-signal', viewerId: viewer.id, payload });
      } else if (message.type === 'ping') send(viewer, { type: 'pong' });
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(helloTimer);
      viewer.status = 'disconnected';
      revokeViewer(viewer);
      viewers.delete(viewer.id);
      emit({ type: 'viewer-disconnected', viewerId: viewer.id, viewer: publicViewer(viewer) });
      emitState();
    });
  });
  const heartbeat = setInterval(() => {
    for (const viewer of viewers.values()) {
      if (!viewer.alive) viewer.socket.terminate();
      else { viewer.alive = false; viewer.socket.ping(); }
    }
  }, 30_000);
  heartbeat.unref();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (cause) {
    clearInterval(heartbeat);
    wss.close();
    throw cause;
  }
  actualPort = server.address().port;
  addresses = getAddresses(actualPort, bindHost);
  running = true;
  emitState();

  return {
    port: actualPort, addresses, getState, listFiles,
    setSharing(value) {
      sharing = Boolean(value);
      sendApproved({ type: 'sharing-changed', sharing });
      emitState();
      return getState();
    },
    approveViewer(id) {
      const viewer = viewers.get(id);
      if (!viewer || viewer.status !== 'pending') return false;
      if ([...viewers.values()].some((peer) => peer.status === 'approved')) return false;
      viewer.status = 'approved';
      viewer.token = randomBytes(32).toString('base64url');
      send(viewer, { type: 'viewer-approved', viewerId: id, token: viewer.token, sharing });
      send(viewer, { type: 'files-changed', files: listFiles() });
      emit({ type: 'viewer-approved', viewerId: id, viewer: publicViewer(viewer) });
      emitState();
      return true;
    },
    rejectViewer(id) {
      const viewer = viewers.get(id);
      if (!viewer || viewer.status !== 'pending') return false;
      viewer.status = 'rejected';
      send(viewer, { type: 'viewer-rejected', message: 'Bağlantı bilgisayardan reddedildi.' });
      emit({ type: 'viewer-rejected', viewerId: id, viewer: publicViewer(viewer) });
      viewer.socket.close(1000, 'Bağlantı reddedildi.');
      emitState();
      return true;
    },
    disconnectViewer(id) {
      const viewer = viewers.get(id);
      if (!viewer) return false;
      viewer.status = 'disconnected';
      revokeViewer(viewer);
      send(viewer, { type: 'viewer-disconnected', message: 'Bağlantı bilgisayardan sonlandırıldı.' });
      viewer.socket.close(1000, 'Bağlantı sonlandırıldı.');
      emitState();
      return true;
    },
    broadcastHostSignal(viewerId, payload) {
      const viewer = viewers.get(viewerId);
      if (!viewer || viewer.status !== 'approved' || !payload || typeof payload !== 'object') return false;
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_SIGNAL_BYTES) return false;
      send(viewer, { type: 'signal', payload });
      return true;
    },
    async registerSharedFile(filePath) {
      const resolved = await realpath(filePath);
      const info = await stat(resolved);
      if (!info.isFile()) throw new Error('Yalnızca dosyalar paylaşılabilir.');
      const existing = [...files.values()].find((file) => file.source === 'shared' && file.path === resolved);
      if (existing) return publicFile(existing);
      const name = safeFilename(path.basename(resolved));
      const file = { id: randomUUID(), name, size: info.size, mime: fileMime(name), path: resolved, source: 'shared', direction: 'download', createdAt: new Date().toISOString() };
      files.set(file.id, file);
      emit({ type: 'file-added', file: publicFile(file) });
      filesChanged();
      return publicFile(file);
    },
    async removeFile(id) {
      const file = files.get(id);
      if (!file) return false;
      // This removes access from the session, never the user's original file.
      files.delete(id);
      emit({ type: 'file-removed', file: publicFile(file) });
      filesChanged();
      return true;
    },
    async close() {
      if (closing) return;
      closing = true;
      running = false;
      sharing = false;
      clearInterval(heartbeat);
      for (const upload of activeUploads) { upload.cancelled = true; upload.request.destroy(); }
      for (const viewer of viewers.values()) { viewer.status = 'disconnected'; revokeViewer(viewer); viewer.socket.terminate(); }
      await new Promise((resolve) => wss.close(resolve));
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
      await Promise.all([...activeUploads].map((upload) => unlink(upload.temporaryPath).catch(() => {})));
      emitState();
    },
  };
}

export default createLanServer;
