import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { createSystemAudioCapture } = require('../src/main/system-audio.cjs');

function fixture(options = {}) {
  const calls = [];
  const spawn = (command, args, settings) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (!options.ignoreTermination || signal === 'SIGKILL') child.emit('close', null, signal);
      return true;
    };
    calls.push({ command, args, settings, child });
    options.onSpawn?.(command, child);
    return child;
  };
  const capture = createSystemAudioCapture({ spawn, startupTimeoutMs: 100, discoveryTimeoutMs: 100, killTimeoutMs: 10, ...options });
  return { capture, calls };
}

async function discover(calls, sink = 'alsa_output.test-speakers') {
  calls[0].child.stdout.write(`${sink}\n`);
  calls[0].child.emit('close', 0, null);
  await nextTurn();
  return calls[1]?.child;
}

test('records only the default output monitor, explicitly selecting stereo float32 PCM', async (t) => {
  const { capture, calls } = fixture();
  t.after(() => capture.stop());
  const data = [];
  const started = capture.start({ onData: (chunk) => data.push(chunk) });
  assert.equal(calls[0].command, 'pactl');
  assert.deepEqual(calls[0].args, ['get-default-sink']);
  const child = await discover(calls);
  assert.equal(calls[1].command, 'parec');
  assert.deepEqual(calls[1].args, [
    '--device=alsa_output.test-speakers.monitor', '--format=float32le', '--rate=48000',
    '--channels=2', '--raw', '--latency-msec=20', '--client-name=Yansi',
  ]);
  assert.equal(calls[1].settings.shell, undefined);
  child.stdout.write(Buffer.alloc(8));
  assert.deepEqual(await started, { sampleRate: 48000, channels: 2, format: 'f32le', sourceName: 'alsa_output.test-speakers.monitor' });
  assert.equal(data.length, 1);
  capture.stop();
  capture.stop();
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('fragmented PCM preserves bytes and delivers only complete stereo sample frames', async (t) => {
  const { capture, calls } = fixture();
  t.after(() => capture.stop());
  const received = [];
  const started = capture.start({ onData: (bytes) => received.push(Buffer.from(bytes)) });
  const child = await discover(calls);
  const pcm = Buffer.from(Array.from({ length: 101 }, (_, index) => index));
  let cursor = 0;
  for (const length of [1, 2, 4, 11, 19, 32, 32]) {
    child.stdout.write(pcm.subarray(cursor, cursor + length));
    cursor += length;
  }
  await started;
  await nextTurn();
  assert.ok(received.every((bytes) => bytes.length % 8 === 0));
  assert.deepEqual(Buffer.concat(received), pcm.subarray(0, 96));
  assert.equal(capture.session.remainder.length, 5);
  // Keeping a partial frame must not retain a large incoming PCM allocation.
  child.stdout.write(Buffer.alloc(1024 * 1024 + 2));
  await nextTurn();
  assert.equal(capture.session.remainder.length, 7);
  assert.ok(capture.session.remainder.buffer.byteLength <= Buffer.poolSize);
});

test('missing or failed output discovery never falls back to a microphone', async () => {
  for (const result of ['', '@DEFAULT_SOURCE@', 'bad\nother']) {
    const { capture, calls } = fixture();
    const started = capture.start({ onData() {} });
    const rejected = assert.rejects(started, /Varsayılan ses çıkışı/);
    await discover(calls, result);
    await rejected;
    assert.equal(calls.length, 1);
    capture.stop();
  }
  const { capture, calls } = fixture();
  const started = capture.start({ onData() {} });
  const rejected = assert.rejects(started, /Connection refused/);
  calls[0].child.stderr.write('Connection refused');
  calls[0].child.emit('close', 1, null);
  await rejected;
  assert.equal(calls.length, 1);
});

test('stop while discovering cancels startup and does not spawn a later recorder', async () => {
  const { capture, calls } = fixture();
  const started = capture.start({ onData() {} });
  const rejected = assert.rejects(started, { name: 'AbortError' });
  capture.stop();
  capture.stop();
  calls[0].child.stdout.write('late-speakers\n');
  calls[0].child.emit('close', 0, null);
  await rejected;
  await nextTurn();
  assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
  assert.equal(calls.length, 1);
});

test('stop during recorder startup kills the child and suppresses late audio/errors', async () => {
  const { capture, calls } = fixture();
  const received = [];
  const errors = [];
  const started = capture.start({ onData: (chunk) => received.push(chunk), onError: (error) => errors.push(error) });
  const rejected = assert.rejects(started, { name: 'AbortError' });
  const child = await discover(calls);
  capture.stop();
  child.stdout.write(Buffer.alloc(8));
  child.emit('error', new Error('late failure'));
  await rejected;
  await nextTurn();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.deepEqual(received, []);
  assert.deepEqual(errors, []);
});

test('missing tools and synchronous spawn failures reject startup with useful errors', async () => {
  const { capture, calls } = fixture();
  const started = capture.start({ onData() {} });
  const rejected = assert.rejects(started, /pactl.*bulunamadı/);
  calls[0].child.emit('error', Object.assign(new Error('spawn pactl ENOENT'), { code: 'ENOENT' }));
  await rejected;
  assert.deepEqual(calls[0].child.signals, ['SIGTERM']);
  const syncFailure = createSystemAudioCapture({ spawn() { throw new Error('blocked'); } });
  await assert.rejects(syncFailure.start({ onData() {} }), /pactl.*blocked/);
  const missingRecorder = fixture();
  const recorderStart = missingRecorder.capture.start({ onData() {} });
  const recorderRejected = assert.rejects(recorderStart, /parec.*bulunamadı/);
  const child = await discover(missingRecorder.calls);
  child.emit('error', Object.assign(new Error('spawn parec ENOENT'), { code: 'ENOENT' }));
  await recorderRejected;
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('early recorder exit rejects startup; later exit reports once and permits restart', async () => {
  const { capture, calls } = fixture();
  const started = capture.start({ onData() {} });
  const rejected = assert.rejects(started, /No such entity/);
  const child = await discover(calls);
  child.stderr.write('No such entity');
  child.emit('close', 1, null);
  await rejected;
  const errors = [];
  const restarted = capture.start({ onData() {}, onError: (error) => errors.push(error) });
  calls[2].child.stdout.write('new-speakers\n');
  calls[2].child.emit('close', 0, null);
  await nextTurn();
  calls[3].child.stdout.write(Buffer.alloc(8));
  await restarted;
  calls[3].child.emit('close', 1, null);
  calls[3].child.emit('error', new Error('late failure'));
  assert.equal(errors.length, 1);
  assert.equal(capture.session, null);
});

test('hung processes time out and stubborn children are force-killed', async () => {
  const { capture, calls } = fixture({ discoveryTimeoutMs: 10, ignoreTermination: true });
  await assert.rejects(capture.start({ onData() {} }), /zamanında yanıt vermedi/);
  await delay(25);
  assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  const silent = fixture({ startupTimeoutMs: 10 });
  const started = silent.capture.start({ onData() {} });
  const rejected = assert.rejects(started, /veri alınamadı/);
  const child = await discover(silent.calls);
  await rejected;
  assert.deepEqual(child.signals, ['SIGTERM']);
});
