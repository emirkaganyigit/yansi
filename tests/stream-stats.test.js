import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/renderer/stream-stats.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window });
const { createSampler, measure } = window.YansiStreamStats;

const outbound = (overrides = {}) => ({
  id: 'video', type: 'outbound-rtp', kind: 'video', ssrc: 42, codecId: 'vp8',
  timestamp: 1000, framesEncoded: 100, framesSent: 100, bytesSent: 100000,
  totalEncodeTime: 0.5, frameWidth: 1280, frameHeight: 720,
  qualityLimitationReason: 'none', transportId: 'transport', remoteId: 'remote',
  ...overrides,
});
const stats = (...entries) => new Map(entries.map(entry => [entry.id, entry]));
const plain = value => JSON.parse(JSON.stringify(value));

test('first sample exposes measured snapshots and warms up interval metrics', () => {
  const { report } = measure(stats(
    outbound(),
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', currentRoundTripTime: 0.012, availableOutgoingBitrate: 4000000 },
    { id: 'remote', type: 'remote-inbound-rtp', packetsLost: 8, fractionLost: 0.02 },
  ));
  assert.deepEqual(plain(report), {
    fps: null, width: 1280, height: 720, bitrateKbps: null, encodeMs: null,
    rttMs: 12, qualityLimitationReason: 'none', availableOutgoingKbps: 4000,
    packetsLost: 8, fractionLost: 0.02,
    codec: null, encoderImplementation: null, powerEfficientEncoder: null,
  });
});

test('rates use stats timestamps and encoded frames, not sent frame count or poll timing', () => {
  const first = measure(stats(outbound()));
  const { report } = measure(stats(outbound({
    timestamp: 3000, framesEncoded: 150, framesSent: 145,
    bytesSent: 600000, totalEncodeTime: 0.8, qualityLimitationReason: 'cpu',
  })), first.baseline);
  assert.equal(report.fps, 25);
  assert.equal(report.bitrateKbps, 2000);
  assert.ok(Math.abs(report.encodeMs - 6) < 1e-10);
  assert.equal(report.qualityLimitationReason, 'cpu');
});

test('codec and encoder diagnostics are direct observations, including false hardware efficiency', () => {
  const { report } = measure(stats(
    outbound({ encoderImplementation: 'libvpx', powerEfficientEncoder: false }),
    { id: 'vp8', type: 'codec', mimeType: 'video/VP8' },
  ));
  assert.equal(report.codec, 'video/VP8');
  assert.equal(report.encoderImplementation, 'libvpx');
  assert.equal(report.powerEfficientEncoder, false);
  const unknown = measure(stats(outbound({ encoderImplementation: false, powerEfficientEncoder: 'true' }))).report;
  assert.equal(unknown.codec, null);
  assert.equal(unknown.encoderImplementation, null);
  assert.equal(unknown.powerEfficientEncoder, null);
});

test('absent optional stats remain null and framesSent is a real fallback', () => {
  const first = measure(stats(outbound({ framesEncoded: undefined, totalEncodeTime: undefined, frameWidth: undefined })));
  const { report } = measure(stats(outbound({
    timestamp: 2000, framesEncoded: undefined, totalEncodeTime: undefined,
    framesSent: 130, frameWidth: undefined, bytesSent: undefined,
  })), first.baseline);
  assert.equal(report.fps, 30);
  for (const field of ['width', 'bitrateKbps', 'encodeMs', 'rttMs', 'packetsLost', 'fractionLost']) {
    assert.equal(report[field], null, field);
  }
});

test('a reset does not produce negative rates or switch to the unrelated sent counter', () => {
  const first = measure(stats(outbound()));
  const reset = measure(stats(outbound({
    timestamp: 2000, framesEncoded: 1, framesSent: 130, bytesSent: 500, totalEncodeTime: 0.001,
  })), first.baseline);
  for (const field of ['fps', 'bitrateKbps', 'encodeMs']) assert.equal(reset.report[field], null, field);
  const resumed = measure(stats(outbound({
    timestamp: 3000, framesEncoded: 31, framesSent: 160, bytesSent: 100500, totalEncodeTime: 0.061,
  })), reset.baseline);
  assert.equal(resumed.report.fps, 30);
  assert.equal(resumed.report.bitrateKbps, 800);
  assert.equal(resumed.report.encodeMs, 2);
});

test('stream identity changes warm up instead of combining unrelated counters', () => {
  const first = measure(stats(outbound()));
  for (const changed of [{ id: 'new-video' }, { ssrc: 99 }, { codecId: 'h264' }]) {
    const { report } = measure(stats(outbound({ timestamp: 2000, framesEncoded: 130, bytesSent: 300000, ...changed })), first.baseline);
    assert.equal(report.fps, null);
    assert.equal(report.bitrateKbps, null);
    assert.equal(report.encodeMs, null);
  }
});

test('duplicate and out-of-order timestamps do not corrupt the next interval', () => {
  const first = measure(stats(outbound()));
  for (const timestamp of [1000, 900]) {
    const ignored = measure(stats(outbound({ timestamp, framesEncoded: 500, bytesSent: 999999 })), first.baseline);
    assert.equal(ignored.report.fps, null);
    assert.equal(ignored.baseline, first.baseline);
    const next = measure(stats(outbound({ timestamp: 2000, framesEncoded: 130, bytesSent: 200000 })), ignored.baseline);
    assert.equal(next.report.fps, 30);
    assert.equal(next.report.bitrateKbps, 800);
  }
});

test('a missing timestamp warms up again and can recover when timestamps return', () => {
  const first = measure(stats(outbound({ timestamp: undefined })));
  const second = measure(stats(outbound({ timestamp: 2000, framesEncoded: 130 })), first.baseline);
  assert.equal(second.report.fps, null);
  const third = measure(stats(outbound({ timestamp: 3000, framesEncoded: 160 })), second.baseline);
  assert.equal(third.report.fps, 30);
});

test('zero traffic is zero FPS/bitrate; no encoded frames cannot imply an encode duration', () => {
  const first = measure(stats(outbound()));
  const { report } = measure(stats(outbound({ timestamp: 2000 })), first.baseline);
  assert.equal(report.fps, 0);
  assert.equal(report.bitrateKbps, 0);
  assert.equal(report.encodeMs, null);
});

test('uses the video transport and corresponding remote receiver without leaking audio statistics', () => {
  const { report } = measure(stats(
    outbound(),
    { id: 'audio', type: 'outbound-rtp', kind: 'audio', remoteId: 'audio-remote' },
    { id: 'audio-remote', type: 'remote-inbound-rtp', kind: 'audio', localId: 'audio', packetsLost: 100, fractionLost: 0.9 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'video-pair' },
    { id: 'other-transport', type: 'transport', selectedCandidatePairId: 'other-pair' },
    { id: 'video-pair', type: 'candidate-pair', currentRoundTripTime: 0.005 },
    { id: 'other-pair', type: 'candidate-pair', currentRoundTripTime: 0.5 },
  ));
  assert.equal(report.rttMs, 5);
  assert.equal(report.packetsLost, null);
  assert.equal(report.fractionLost, null);
});

test('matches remote inbound by localId and preserves legitimate negative packet loss counts', () => {
  const { report } = measure(stats(
    outbound({ remoteId: undefined }),
    { id: 'receiver', type: 'remote-inbound-rtp', localId: 'video', packetsLost: -1, fractionLost: 0 },
  ));
  assert.equal(report.packetsLost, -1);
  assert.equal(report.fractionLost, 0);
});

test('nominated candidate pairs are not assumed selected and malformed values are not reported', () => {
  const { report } = measure(stats(
    outbound({ frameWidth: NaN, frameHeight: -1, qualityLimitationReason: 'excellent' }),
    { id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.02 },
    { id: 'remote', type: 'remote-inbound-rtp', packetsLost: NaN, fractionLost: 1.5 },
  ));
  for (const field of ['width', 'height', 'rttMs', 'qualityLimitationReason', 'packetsLost', 'fractionLost']) {
    assert.equal(report[field], null, field);
  }
});

test('a sampler keeps connection baselines independent and can clear one or all', async () => {
  const notifications = [];
  const sampler = createSampler((report, pc) => notifications.push({ report, pc }));
  let timestamp = 1000;
  let framesEncoded = 100;
  const one = { getStats: async () => stats(outbound({ timestamp, framesEncoded })) };
  const two = { getStats: async () => stats(outbound({ timestamp, framesEncoded })) };
  assert.equal((await sampler.sample(one)).fps, null);
  timestamp = 2000;
  framesEncoded = 130;
  assert.equal((await sampler.sample(one)).fps, 30);
  assert.equal((await sampler.sample(two)).fps, null);
  sampler.clear(one);
  timestamp = 3000;
  framesEncoded = 160;
  assert.equal((await sampler.sample(one)).fps, null);
  assert.equal((await sampler.sample(two)).fps, 30);
  sampler.clear();
  timestamp = 4000;
  framesEncoded = 190;
  assert.equal((await sampler.sample(two)).fps, null);
  assert.equal(notifications.length, 6);
  assert.equal(notifications[0].pc, one);
});

test('disappearance of video resets the baseline and getStats failures propagate', async () => {
  let report = stats(outbound());
  const pc = { getStats: async () => report };
  const sampler = createSampler();
  await sampler.sample(pc);
  report = stats();
  assert.equal((await sampler.sample(pc)).fps, null);
  report = stats(outbound({ timestamp: 2000, framesEncoded: 130 }));
  assert.equal((await sampler.sample(pc)).fps, null);
  const error = new Error('closed');
  await assert.rejects(sampler.sample({ getStats: async () => { throw error; } }), error);
});
