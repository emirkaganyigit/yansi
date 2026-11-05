import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-results');
await mkdir(artifacts, { recursive: true });
const audioBin = path.join(root, '.local/smoke/audio-bin');
const audioMarker = path.join(root, '.local/smoke/audio-events.jsonl');
await mkdir(audioBin, { recursive: true });
const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
await writeFile(path.join(audioBin, 'pactl'), '#!/bin/sh\n[ "$1" = "get-default-sink" ] || exit 2\nprintf "%s\\n" "yansi_smoke"\n', { mode: 0o755 });
await writeFile(path.join(audioBin, 'parec'), '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(path.join(root, 'scripts/test-audio-source.cjs')) + ' "$@"\n', { mode: 0o755 });
await writeFile(audioMarker, '');
const environment = { ...process.env, YANSI_DATA_DIR: path.join(root, '.local/smoke'), YANSI_PORT: '0', PATH: audioBin + path.delimiter + process.env.PATH, YANSI_AUDIO_TEST_MARKER: audioMarker };
const packaged = process.env.YANSI_TEST_PACKAGED === '1';
delete environment.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
try {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'dist/yansi-linux-x64/yansi') : electronPath, args: packaged ? [] : [root], cwd: root, env: environment, timeout: 30000 });
  application.process().stderr.on('data', (chunk) => { if (process.env.YANSI_TEST_DEBUG) process.stderr.write(chunk); });
  const host = await application.firstWindow();
  host.setDefaultTimeout(20000);
  host.on('pageerror', (error) => errors.push(`desktop: ${error.message}`));
  await host.waitForFunction(async () => Boolean(window.yansi && (await window.yansi.getState()).running));
  await host.getByRole('heading', { name: 'Ekranını büyüt.' }).waitFor();
  const initial = await host.evaluate(() => window.yansi.getState());
  assert.equal(initial.sharing, false);
  assert.equal(initial.viewers.length, 0);
  assert.equal(await host.locator('#share-button').evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight), true, 'Ekranı paylaş düğmesi ilk görünümde erişilebilir olmalı.');
  await host.screenshot({ path: path.join(artifacts, 'desktop.png') });
  console.log('Masaüstü açıldı; yerel sunucu hazır.');

  const newWindow = application.waitForEvent('window');
  await application.evaluate(async ({ BrowserWindow }, url) => {
    const receiver = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    globalThis.__yansiSmokeReceiver = receiver;
    await receiver.loadURL(url);
  }, `http://127.0.0.1:${initial.port}`);
  const receiver = await newWindow;
  receiver.setDefaultTimeout(20000);
  receiver.on('pageerror', (error) => errors.push(`receiver: ${error.message}`));
  await receiver.locator('#connect-button').click();
  await host.getByRole('button', { name: 'Onayla', exact: true }).first().click();
  await host.waitForFunction(async () => (await window.yansi.getState()).viewers.some((viewer) => viewer.status === 'approved'));
  console.log('İzleyici bağlantısı masaüstünden onaylandı.');
  await receiver.evaluate(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__testPeers = [];
    window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.__testPeers.push(this); } };
    document.querySelector('video').volume = 0;
  });

  // A canvas exercises real WebRTC without selecting or recording the user's desktop.
  await host.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        context.fillStyle = '#0b766e'; context.fillRect(0, 0, 1280, 720);
        context.fillStyle = '#f4faf4'; context.font = '54px sans-serif'; context.fillText('Yansı · Bağlantı testi', 70, 160);
        context.font = '30px sans-serif'; context.fillText(`Kare ${frame++}`, 70, 225);
        context.fillRect(70 + (frame * 7) % 1000, 340, 100, 100);
      };
      draw(); const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      window.__yansiSmokeTimer = timer;
      return stream;
    };
  });
  await host.getByRole('button', { name: 'Ekranı paylaş', exact: true }).click();
  await receiver.waitForFunction(() => {
    const video = document.querySelector('video');
    return video && video.readyState >= 2 && video.videoWidth >= 640 && video.currentTime > 2;
  }, null, { timeout: 25000 });
  const video = await receiver.locator('video').evaluate((element) => ({ width: element.videoWidth, height: element.videoHeight, time: element.currentTime }));
  assert(video.width > 0 && video.height > 0);
  console.log(`WebRTC görüntüsü oynatıldı: ${video.width}×${video.height}.`);
  await receiver.waitForFunction(async () => {
    const peer = window.__testPeers.at(-1);
    if (!peer) return false;
    const stats = await peer.getStats();
    return [...stats.values()].some((item) => item.type === 'inbound-rtp' && item.kind === 'audio' && item.packetsReceived > 0 && item.totalAudioEnergy > 0.0001);
  }, null, { timeout: 20000 });
  await receiver.locator('#audio-button').click();
  assert.equal(await receiver.locator('video').evaluate((element) => element.muted), false);
  await receiver.locator('#audio-button').filter({ hasText: 'Sesi kapat' }).waitFor();
  console.log('Test sesi Opus/WebRTC üzerinden alındı; TV ses düğmesi çalışıyor.');
  await host.waitForFunction(() => /^\d/.test(document.getElementById('stats-send-fps').textContent) && /^\d/.test(document.getElementById('stats-receive-fps').textContent), null, { timeout: 15000 });
  const measuredPerformance = await host.evaluate(() => ({ sent: document.getElementById('stats-send-fps').textContent, received: document.getElementById('stats-receive-fps').textContent, codec: document.getElementById('stats-encode').textContent, mode: document.getElementById('stream-mode').value }));
  assert.equal(measuredPerformance.mode, 'motion');
  console.log('Ölçülen yayın:', JSON.stringify(measuredPerformance));
  await host.locator('#stream-diagnostics').evaluate((element) => { element.open = true; });
  await host.locator('#stream-diagnostics').scrollIntoViewIfNeeded();
  await host.screenshot({ path: path.join(artifacts, 'desktop-live.png') });
  await receiver.screenshot({ path: path.join(artifacts, 'receiver.png') });

  await receiver.evaluate(() => { window.__initialVideoStream = document.querySelector('video').srcObject; });
  const timeBeforeQuality = await receiver.locator('video').evaluate((element) => element.currentTime);
  await host.locator('[data-quality="1080"]').click();
  await receiver.waitForFunction((before) => {
    const element = document.querySelector('video');
    return element.srcObject && element.srcObject === window.__initialVideoStream && element.readyState >= 2 && element.currentTime > before + 0.5;
  }, timeBeforeQuality, { timeout: 20000 });
  await host.locator('[data-quality="1080"][aria-pressed="true"]').waitFor();
  assert.equal(await receiver.locator('video').evaluate((element) => element.muted), false);
  await receiver.waitForFunction(async () => {
    const stats = await window.__testPeers.at(-1).getStats();
    return [...stats.values()].some((item) => item.type === 'inbound-rtp' && item.kind === 'audio' && item.totalAudioEnergy > 0.0001);
  }, null, { timeout: 20000 });
  await receiver.locator('#audio-button').click();
  assert.equal(await receiver.locator('video').evaluate((element) => element.muted), true);
  await receiver.locator('#audio-button').click();
  assert.equal(await receiver.locator('video').evaluate((element) => element.muted), false);
  console.log('Kalite değişimi görüntü ve sesi yeniden bağlamadan uygulandı.');
  await host.locator('#stream-mode').selectOption('detail');
  await receiver.waitForFunction(() => document.querySelector('video').srcObject === window.__initialVideoStream);
  await host.locator('#stream-mode').selectOption('motion');

  assert.equal(await host.locator('#screen-preview').evaluate((element) => element.srcObject), null);
  await host.locator('#preview-toggle').check();
  await host.waitForFunction(() => document.getElementById('screen-preview').srcObject !== null);
  await host.locator('#preview-toggle').uncheck();
  await host.waitForFunction(() => document.getElementById('screen-preview').srcObject === null);
  assert.equal(await receiver.locator('video').evaluate((element) => element.srcObject === window.__initialVideoStream), true);

  let h264Check = 'not-offered';
  if (!(await host.locator('#codec-preference option[value="h264"]').isDisabled())) {
    await host.locator('#codec-preference').selectOption('h264');
    await receiver.waitForFunction(async () => {
      const video = document.querySelector('video');
      const peer = window.__testPeers.at(-1);
      if (!peer || video.srcObject === window.__initialVideoStream || video.readyState < 2 || video.currentTime < 1) return false;
      const stats = await peer.getStats();
      return [...stats.values()].some((item) => item.type === 'inbound-rtp' && item.kind === 'video' && item.framesDecoded > 10 && stats.get(item.codecId)?.mimeType === 'video/H264');
    }, null, { timeout: 25000 });
    assert.equal(await receiver.locator('video').evaluate((element) => element.muted), false);
    h264Check = 'negotiated-and-playing';
  }
  console.log(`PC önizlemesi yayın kesilmeden değiştirildi; H.264: ${h264Check}.`);

  const fixture = path.join(root, '.local/smoke/paylasilan.txt');
  const sharedContent = 'Yansı masaüstünden izleyiciye dosya aktarım testi.\n';
  await writeFile(fixture, sharedContent);
  await application.evaluate(({ dialog }, filename) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [filename] }; };
  }, fixture);
  await host.locator('[data-view="files"]').click();
  await host.locator('#choose-files').click();
  await receiver.locator('#files-toggle').click();
  const sharedLink = receiver.getByRole('link', { name: 'paylasilan.txt dosyasını indir', exact: true });
  await sharedLink.waitFor();
  const sharedUrl = new URL(await sharedLink.getAttribute('href'), receiver.url()).href;
  const downloaded = await receiver.request.get(sharedUrl);
  assert.equal(downloaded.status(), 200);
  assert.equal(await downloaded.text(), sharedContent);

  const uploadContent = Buffer.from('İzleyiciden Fedora masaüstüne dosya aktarım testi.\n');
  await receiver.locator('#upload-input').setInputFiles({ name: 'izleyiciden.txt', mimeType: 'text/plain', buffer: uploadContent });
  await receiver.locator('#upload-result').filter({ hasText: '1 dosya bilgisayarına gönderildi.' }).waitFor();
  await host.waitForFunction(async () => (await window.yansi.getState()).files.some((file) => file.name === 'izleyiciden.txt' && file.source === 'received'));
  const uploadedLink = receiver.getByRole('link', { name: 'izleyiciden.txt dosyasını indir', exact: true });
  const uploadedUrl = new URL(await uploadedLink.getAttribute('href'), receiver.url()).href;
  const uploadedResponse = await receiver.request.get(uploadedUrl);
  assert.deepEqual(await uploadedResponse.body(), uploadContent);
  console.log('Arayüzden dosya indirme ve gönderme doğrulandı.');
  await host.locator('[data-view="screen"]').click();

  // Lock/suspend uses this same stop event. The capture must actually stop.
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('file:')).webContents.send('yansi:event', { type: 'stop-sharing', reason: 'Otomatik test' });
  });
  await host.waitForFunction(async () => (await window.yansi.getState()).sharing === false);
  await host.getByRole('button', { name: 'Ekranı paylaş', exact: true }).waitFor();
  const deadline = Date.now() + 5000;
  while (!(await readFile(audioMarker, 'utf8')).includes('"event":"stopped"')) {
    if (Date.now() > deadline) throw new Error('Yayın durduğunda ses yakalama süreci kapanmadı.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await receiver.waitForFunction(() => document.querySelector('video').srcObject === null && document.getElementById('audio-button').disabled);
  const state = await host.evaluate(() => window.yansi.getState());
  await host.evaluate((id) => window.yansi.disconnectViewer(id), state.viewers.find((viewer) => viewer.status === 'approved').id);
  await host.waitForFunction(async () => (await window.yansi.getState()).viewers.length === 0);
  assert.deepEqual(errors, []);
  const result = { packaged, desktop: 'passed', approval: 'passed', webRtc: video, measuredPerformance, audio: 'received-nonzero-energy', audioControls: 'passed', audioCleanup: 'passed', qualityChange: 'without-reconnect', previewChange: 'without-reconnect', h264: h264Check, download: 'passed', upload: 'passed', lockStop: 'passed', disconnect: 'passed', pageErrors: errors };
  await writeFile(path.join(artifacts, 'smoke.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (application) {
    for (const [index, page] of application.windows().entries()) await page.screenshot({ path: path.join(artifacts, `failure-${index}.png`), timeout: 5000 }).catch(() => {});
  }
  throw error;
} finally {
  if (application) await application.close();
}
