import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workletSource = await readFile(new URL('../src/renderer/audio-worklet.js', import.meta.url), 'utf8');
const helperSource = await readFile(new URL('../src/renderer/system-audio.js', import.meta.url), 'utf8');

function makeProcessor() {
  let Processor;
  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    sampleRate: 48000,
    registerProcessor(name, implementation) {
      assert.equal(name, 'yansi-system-audio');
      Processor = implementation;
    },
  });
  return new Processor({ processorOptions: {} });
}

function enqueue(processor, frames, firstFrame = 1) {
  const samples = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    samples[frame * 2] = firstFrame + frame;
    samples[frame * 2 + 1] = -(firstFrame + frame);
  }
  processor.port.onmessage({ data: { type: 'pcm', samples: samples.buffer } });
}

function render(processor, frames = 128) {
  const output = [new Float32Array(frames), new Float32Array(frames)];
  const running = processor.process([], [output]);
  return { output, running };
}

test('audio worklet waits for warmup, preserves stereo, and fills underflow with silence', () => {
  const processor = makeProcessor();
  enqueue(processor, 1000);
  assert.equal(render(processor).output[0].some(value => value !== 0), false);
  assert.equal(processor.bufferedFrames, 1000);
  enqueue(processor, 500, 1001);
  const first = render(processor);
  assert.equal(first.output[0][0], 1);
  assert.equal(first.output[1][127], -128);
  for (let index = 0; index < 10; index++) render(processor);
  const last = render(processor);
  assert.equal(last.output[0][91], 1500);
  assert.equal(last.output[0][92], 0);
  assert.equal(processor.bufferedFrames, 0);
  enqueue(processor, 100, 2000);
  assert.equal(render(processor).output[0].some(value => value !== 0), false);
});

test('audio worklet keeps only the newest 250 ms after an oversized delayed batch', () => {
  const processor = makeProcessor();
  enqueue(processor, 1000);
  enqueue(processor, 13000, 2000);
  assert.equal(processor.bufferedFrames, 12000);
  const { output } = render(processor);
  assert.equal(output[0][0], 3000);
  assert.equal(output[1][127], -3127);
});

test('audio worklet drops old queued frames, wraps the ring, and stops immediately', () => {
  const processor = makeProcessor();
  enqueue(processor, 12000);
  render(processor);
  enqueue(processor, 256, 12001);
  assert.equal(processor.bufferedFrames, 12000);
  assert.equal(render(processor).output[0][0], 257);
  processor.port.onmessage({ data: { type: 'stop' } });
  enqueue(processor, 5000);
  const last = render(processor);
  assert.equal(last.running, false);
  assert.equal(last.output[0].some(value => value !== 0), false);
  assert.equal(processor.bufferedFrames, 0);
});

function helperHarness(options = {}) {
  const calls = [];
  const posted = [];
  let dataHandler;
  let eventHandler;
  let node;
  const track = { stop() { calls.push('track-stop'); } };
  const destination = { stream: { getTracks: () => [track] }, disconnect() { calls.push('destination-disconnect'); } };
  const api = {
    onAudioData(handler) { dataHandler = handler; calls.push('data-subscribe'); return () => calls.push('data-unsubscribe'); },
    onEvent(handler) { eventHandler = handler; return () => calls.push('event-unsubscribe'); },
    async startSystemAudio() {
      calls.push('backend-start');
      options.onStart?.(dataHandler);
      if (options.startWait) await options.startWait;
      if (options.startError) throw options.startError;
      return { sampleRate: 48000, channels: 2, format: 'f32le', sourceName: 'Test monitor' };
    },
    async stopSystemAudio() { calls.push('backend-stop'); },
  };
  const window = {};
  vm.runInNewContext(helperSource, {
    window,
    URL,
    document: { baseURI: 'file:///test/renderer/index.html' },
    AudioContext: class {
      constructor(settings) {
        assert.equal(settings.sampleRate, 48000);
        this.sampleRate = 48000;
        this.state = 'suspended';
        this.audioWorklet = { addModule: async url => { calls.push(url); if (options.moduleWait) await options.moduleWait; } };
      }
      async resume() { calls.push('context-resume'); this.state = 'running'; }
      createMediaStreamDestination() { return destination; }
      async close() { calls.push('context-close'); this.state = 'closed'; }
    },
    AudioWorkletNode: class {
      constructor() {
        node = this;
        this.port = { postMessage(message, transfer) { posted.push(structuredClone(message, { transfer: transfer || [] })); } };
      }
      connect(target) { assert.equal(target, destination); calls.push('destination-connect'); }
      disconnect() { calls.push('node-disconnect'); }
    },
  });
  return { start: settings => window.YansiSystemAudio.start(api, settings), calls, posted, get node() { return node; }, sendEvent: event => eventHandler(event) };
}

test('system audio helper decodes an unaligned view without detaching bridge data', async () => {
  const bytes = new Uint8Array(18);
  const data = new DataView(bytes.buffer, 1, 16);
  [0.25, -0.5, 0.75, -1].forEach((value, index) => data.setFloat32(index * 4, value, true));
  const harness = helperHarness({ onStart: callback => callback(new Uint8Array(bytes.buffer, 1, 16)) });
  const audio = await harness.start();
  assert.equal(audio.sourceName, 'Test monitor');
  assert.equal(bytes.buffer.byteLength, 18);
  assert.deepEqual(Array.from(new Float32Array(harness.posted[0].samples)), [0.25, -0.5, 0.75, -1]);
  assert.ok(harness.calls.indexOf('data-subscribe') < harness.calls.indexOf('backend-start'));
  assert.ok(harness.calls.includes('file:///test/renderer/audio-worklet.js'));
  await Promise.all([audio.stop(), audio.stop()]);
  assert.equal(harness.calls.filter(call => call === 'backend-stop').length, 1);
  assert.equal(harness.calls.filter(call => call === 'track-stop').length, 1);
  assert.equal(audio.audioContext.state, 'closed');
});

test('system audio helper releases the backend, context and subscriptions if startup fails', async () => {
  const error = new Error('Monitor unavailable');
  const harness = helperHarness({ startError: error });
  await assert.rejects(harness.start(), error);
  for (const cleanup of ['backend-stop', 'context-close', 'data-unsubscribe', 'event-unsubscribe', 'track-stop']) {
    assert.ok(harness.calls.includes(cleanup), cleanup);
  }
});

test('system audio helper closes playback on a backend audio error', async () => {
  const harness = helperHarness();
  const audio = await harness.start();
  harness.sendEvent({ type: 'audio-error', message: 'Capture ended' });
  await audio.stop();
  assert.equal(audio.audioContext.state, 'closed');
  assert.equal(harness.calls.filter(call => call === 'backend-stop').length, 1);
});

test('aborting while worklet setup is pending never starts the backend later', async () => {
  let finishModule;
  const moduleWait = new Promise(resolve => { finishModule = resolve; });
  const harness = helperHarness({ moduleWait });
  const controller = new AbortController();
  const started = harness.start({ signal: controller.signal });
  controller.abort();
  finishModule();
  await assert.rejects(started, { name: 'AbortError' });
  assert.equal(harness.calls.includes('backend-start'), false);
  assert.equal(harness.calls.includes('backend-stop'), false);
  assert.equal(harness.calls.includes('data-subscribe'), false);
  assert.ok(harness.calls.includes('context-close'));
});

test('aborting pending backend startup closes it exactly once', async () => {
  let finishStart;
  let notifyStarted;
  const backendRequested = new Promise(resolve => { notifyStarted = resolve; });
  const startWait = new Promise(resolve => { finishStart = resolve; });
  const harness = helperHarness({ startWait, onStart: notifyStarted });
  const controller = new AbortController();
  const started = harness.start({ signal: controller.signal });
  await backendRequested;
  controller.abort();
  finishStart();
  await assert.rejects(started, { name: 'AbortError' });
  assert.equal(harness.calls.filter(call => call === 'backend-stop').length, 1);
  assert.equal(harness.calls.filter(call => call === 'context-close').length, 1);
});

test('an already aborted startup does not create or stop capture', async () => {
  const harness = helperHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(harness.start({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(harness.calls, []);
});
