import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createLanServer } from '../src/server/index.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lan-mirror-test-'));
  const events = [];
  const server = await createLanServer({ port: 0, bindHost: '127.0.0.1', downloadDirectory: path.join(directory, 'received'), onEvent: (event) => events.push(event), ...options });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { server, events, directory, base: `http://127.0.0.1:${server.port}` };
}

function connect(base, origin) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/signal', origin ? { origin } : undefined);
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    const index = waiters.findIndex((entry) => entry.predicate(message));
    if (index < 0) messages.push(message);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    }
  });
  socket.on('error', () => {});
  const next = (type) => {
    const predicate = (value) => value.type === type;
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timeout: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`WS ${type} mesajı gelmedi.`));
      }, 2000) };
      waiters.push(waiter);
    });
  };
  return { socket, next, send: (value) => socket.send(JSON.stringify(value)) };
}

async function pair(base, server) {
  const client = connect(base);
  await client.next('hello');
  client.send({ type: 'hello', name: 'Mi Box tarayıcı' });
  const pending = await client.next('viewer-pending');
  assert.equal(server.approveViewer(pending.viewerId), true);
  const approved = await client.next('viewer-approved');
  return { ...client, ...approved, headers: { Authorization: `Bearer ${approved.token}` } };
}

test('host approval protects files and signaling; peer tokens are revoked immediately', async (t) => {
  const { server, base, events } = await setup(t);
  assert.equal((await fetch(base + '/health')).status, 200);
  const status = await (await fetch(base + '/api/status')).json();
  assert.equal(status.pairingRequired, true);
  assert.equal('viewers' in status, false);
  assert.equal('downloadDirectory' in status, false);
  assert.equal((await fetch(base + '/api/files')).status, 401);
  const client = connect(base);
  await client.next('hello');
  client.send({ type: 'hello', name: 'Mi Box tarayıcı' });
  const { viewerId } = await client.next('viewer-pending');
  assert.ok(events.some((event) => event.type === 'viewer-request' && event.viewerId === viewerId));
  client.send({ type: 'signal', payload: { type: 'answer', sdp: 'not-approved' } });
  assert.equal((await client.next('error')).code, 'NOT_APPROVED');
  assert.equal(events.some((event) => event.type === 'viewer-signal'), false);
  server.setSharing(true);
  assert.equal(server.approveViewer(viewerId), true);
  const approved = await client.next('viewer-approved');
  assert.equal(approved.sharing, true);
  assert.ok(approved.token.length >= 40);
  assert.equal(JSON.stringify(server.getState()).includes(approved.token), false);
  const headers = { Authorization: `Bearer ${approved.token}` };
  assert.equal((await fetch(base + '/api/files', { headers })).status, 200);
  assert.equal((await fetch(base + `/api/files?token=${approved.token}`)).status, 401);
  client.send({ type: 'signal', payload: { type: 'answer', sdp: 'example-answer' } });
  await delay(20);
  assert.ok(events.some((event) => event.type === 'viewer-signal' && event.payload.sdp === 'example-answer'));
  assert.equal(server.broadcastHostSignal(viewerId, { type: 'offer', sdp: 'example-offer' }), true);
  assert.deepEqual((await client.next('signal')).payload, { type: 'offer', sdp: 'example-offer' });
  server.setSharing(false);
  assert.equal((await client.next('sharing-changed')).sharing, false);
  server.disconnectViewer(viewerId);
  assert.equal((await fetch(base + '/api/files', { headers })).status, 401);
  assert.equal(server.broadcastHostSignal(viewerId, { type: 'offer', sdp: 'blocked' }), false);
});

test('streamed file transfer only exposes registered IDs and sanitizes upload names', async (t) => {
  const { server, base, directory, events } = await setup(t, { maxFileBytes: 64 });
  const client = await pair(base, server);
  const hostFile = path.join(directory, 'host file.txt');
  await writeFile(hostFile, 'Desktop → television');
  const shared = await server.registerSharedFile(hostFile);
  assert.equal(shared.source, 'shared');
  assert.equal('path' in shared, false);
  const listing = await (await fetch(base + '/api/files', { headers: client.headers })).json();
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].id, shared.id);
  const fileUrl = `${base}/api/files/${shared.id}?token=${client.token}`;
  assert.equal((await fetch(fileUrl)).headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await (await fetch(fileUrl)).text(), 'Desktop → television');
  const partial = await fetch(fileUrl, { headers: { Range: 'bytes=0-6' } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), 'Desktop');
  assert.equal((await fetch(`${base}/api/files/not-a-file?token=${client.token}`)).status, 404);
  assert.equal((await fetch(`${base}/api/files/${shared.id}?token=wrong`)).status, 401);
  const uploaded = await fetch(base + '/api/uploads?name=' + encodeURIComponent('../../gizli.txt'), {
    method: 'POST', headers: client.headers, body: 'Telefon dosyası',
  });
  assert.equal(uploaded.status, 201);
  const { file } = await uploaded.json();
  assert.equal(file.name, 'gizli.txt');
  assert.equal(file.source, 'received');
  const received = events.find((event) => event.type === 'file-received');
  assert.equal(await readFile(received.path, 'utf8'), 'Telefon dosyası');
  assert.equal(path.dirname(received.path), path.join(directory, 'received'));
  assert.equal((await readdir(path.join(directory, 'received'))).some((name) => name.endsWith('.part')), false);
  assert.equal((await fetch(base + '/api/uploads?name=too-big', { method: 'POST', headers: client.headers, body: 'x'.repeat(65) })).status, 413);
  assert.equal((await fetch(base + '/api/uploads?name=blocked', { method: 'POST', body: 'blocked' })).status, 401);
  assert.equal(await server.removeFile(shared.id), true);
  assert.equal(await readFile(hostFile, 'utf8'), 'Desktop → television');
  assert.equal((await fetch(fileUrl)).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2fserver%2findex.js')).status, 403);
});

test('chunked oversized uploads and aborted uploads leave no partial files', async (t) => {
  const { server, base, directory } = await setup(t, { maxFileBytes: 64 });
  const client = await pair(base, server);
  const oversizedStatus = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/uploads?name=chunked.txt', {
      method: 'POST', headers: { ...client.headers, 'Transfer-Encoding': 'chunked' },
    }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject);
    request.write('x'.repeat(30));
    request.end('y'.repeat(40));
  });
  assert.equal(oversizedStatus, 413);
  const request = http.request(base + '/api/uploads?name=aborted.txt', {
    method: 'POST', headers: { ...client.headers, 'Content-Length': 50 },
  });
  request.on('error', () => {});
  request.write('incomplete');
  const receivedDirectory = path.join(directory, 'received');
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await readdir(receivedDirectory)).some((name) => name.endsWith('.part'))) break;
    await delay(10);
  }
  request.destroy();
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await readdir(receivedDirectory)).length === 0) break;
    await delay(10);
  }
  assert.deepEqual(await readdir(receivedDirectory), []);
  assert.deepEqual(server.listFiles(), []);
});

test('one approved receiver at a time and foreign browser origins are rejected', async (t) => {
  const { server, base } = await setup(t);
  await pair(base, server);
  const second = connect(base);
  await second.next('hello');
  second.send({ type: 'hello', name: 'Second TV' });
  const { viewerId } = await second.next('viewer-pending');
  assert.equal(server.approveViewer(viewerId), false);
  assert.equal(server.rejectViewer(viewerId), true);
  assert.equal((await second.next('viewer-rejected')).type, 'viewer-rejected');
  const foreign = connect(base, 'https://unrelated.example');
  const rejection = await new Promise((resolve) => foreign.socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); }));
  foreign.socket.terminate();
  assert.equal(rejection, 403);
});

test('disconnect revokes an active download before the full file can be delivered', async (t) => {
  const { server, base, directory } = await setup(t);
  const client = await pair(base, server);
  const hostFile = path.join(directory, 'large.bin');
  const fileSize = 16 * 1024 * 1024;
  await writeFile(hostFile, Buffer.alloc(fileSize, 7));
  const file = await server.registerSharedFile(hostFile);
  const receivedBytes = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/files/${file.id}?token=${client.token}`, (response) => {
      response.pause();
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('error', () => {});
      response.once('close', () => resolve(bytes));
      server.disconnectViewer(client.viewerId);
      response.resume();
    });
    request.once('error', reject);
  });
  assert.ok(receivedBytes < fileSize, `Expected interrupted stream; received ${receivedBytes} bytes.`);
});
