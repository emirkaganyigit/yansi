import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const viewerSource = await readFile(new URL('../src/web/viewer.js', import.meta.url), 'utf8');
// Exercise the actual telemetry helpers without a browser or media playback.
const helpers = viewerSource.slice(viewerSource.indexOf('  function statsNumber('), viewerSource.indexOf('  async function showVideo('));

function report(overrides = {}) {
  return {
    id: 'video-1', type: 'inbound-rtp', kind: 'video', timestamp: 1000,
    framesDecoded: 100, bytesReceived: 100000, totalDecodeTime: 0.5,
    framesDropped: 3, jitterBufferDelay: 2, jitterBufferEmittedCount: 100,
    frameWidth: 1280, frameHeight: 720, codecId: 'codec',
    decoderImplementation: 'Hardware decoder', powerEfficientDecoder: true,
    ...overrides,
  };
}
function reports(overrides = {}) {
  return new Map([
    ['video-1', report(overrides)],
    ['audio-1', { id: 'audio-1', type: 'inbound-rtp', kind: 'audio', bytesReceived: 99999999 }],
    ['remote-video', { id: 'remote-video', type: 'inbound-rtp', kind: 'video', isRemote: true, bytesReceived: 99999999 }],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
  ]);
}
function harness() {
  const sent = [], timers = new Map();
  let timerId = 0;
  const socket = { readyState: 1 };
  const connection = { connectionState: 'connected', getStats: async () => reports() };
  const context = vm.createContext({
    receiverStatsTimer: null, receiverStatsPeer: null, receiverStatsGeneration: 0,
    peer: connection, connection, socket, WebSocket: { OPEN: 1 }, approved: true, sharing: true,
    negotiationId: 'neg-1', signalEpoch: 1,
    videoStream: { getVideoTracks: () => [{ readyState: 'live' }] },
    sendSignal: payload => sent.push(structuredClone(payload)),
    setTimeout(callback, delay) { assert.equal(delay, 2000); timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(helpers, context);
  return {
    context, connection, sent, timers,
    sample: (current, previous) => structuredClone(context.receiverStatsSample(current, previous)),
    start: () => context.startReceiverStats(connection, context.negotiationId),
    async tick() {
      const [id, callback] = timers.entries().next().value || [];
      assert.ok(callback, 'a stats sample should be scheduled'); timers.delete(id);
      await callback();
    },
  };
}

test('receiver stats warm up then measure real decode, bandwidth and jitter deltas', () => {
  const { sample } = harness();
  const first = sample(reports());
  assert.deepEqual(first.metrics, {
    fps: null, width: 1280, height: 720, bitrateKbps: null, decodeMs: null,
    droppedFrames: null, jitterBufferMs: null, codec: 'video/H264',
    decoderImplementation: 'Hardware decoder', powerEfficientDecoder: true,
  });
  const next = sample(reports({ timestamp: 3000, framesDecoded: 160, bytesReceived: 1100000, totalDecodeTime: 0.8, framesDropped: 5, jitterBufferDelay: 3.8, jitterBufferEmittedCount: 160 }), first.sample);
  assert.equal(next.metrics.fps, 30);
  assert.equal(next.metrics.bitrateKbps, 4000);
  assert.ok(Math.abs(next.metrics.decodeMs - 5) < 0.0001);
  assert.equal(next.metrics.droppedFrames, 2);
  assert.ok(Math.abs(next.metrics.jitterBufferMs - 30) < 0.0001);
});

test('receiver stats omit unknown or reset measurements instead of fabricating frame rates', () => {
  const { sample } = harness();
  const first = sample(reports());
  const reset = sample(reports({ timestamp: 3000, framesDecoded: 0, bytesReceived: 0, totalDecodeTime: 0, framesDropped: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }), first.sample);
  for (const key of ['fps', 'bitrateKbps', 'decodeMs', 'droppedFrames', 'jitterBufferMs']) assert.equal(reset.metrics[key], null, key);
  const missing = sample(reports({ timestamp: NaN, framesDecoded: undefined, frameWidth: -1, frameHeight: Infinity, decoderImplementation: 'x'.repeat(200), powerEfficientDecoder: 'true' }), first.sample);
  assert.equal(missing.metrics.fps, null);
  assert.equal(missing.metrics.width, null);
  assert.equal(missing.metrics.height, null);
  assert.equal(missing.metrics.decoderImplementation.length, 80);
  assert.equal(missing.metrics.powerEfficientDecoder, null);
  assert.equal(sample(new Map()), null);
});

test('receiver stats sample at most once per timer and stop after disconnect', async () => {
  const state = harness();
  state.start(); state.start();
  assert.equal(state.timers.size, 1);
  await state.tick();
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].type, 'receiver-stats');
  assert.equal(state.sent[0].negotiationId, 'neg-1');
  assert.equal(state.timers.size, 1);
  state.connection.connectionState = 'closed';
  await state.tick();
  assert.equal(state.sent.length, 1);
  assert.equal(state.timers.size, 0);
});

test('pending receiver stats never leak into a replaced session or reschedule after cancellation', async () => {
  for (const change of [
    state => state.context.stopReceiverStats(),
    state => { state.context.negotiationId = 'neg-2'; },
    state => { state.context.socket = { readyState: 1 }; },
    state => { state.context.sharing = false; },
    state => { state.context.approved = false; },
    state => { state.connection.connectionState = 'closed'; },
  ]) {
    const state = harness();
    let resolveStats;
    state.connection.getStats = () => new Promise(resolve => { resolveStats = resolve; });
    state.start();
    const pending = state.tick();
    assert.equal(state.timers.size, 0, 'no overlapping sample while getStats is pending');
    change(state); resolveStats(reports()); await pending;
    assert.equal(state.sent.length, 0);
    assert.equal(state.timers.size, 0);
  }
});
