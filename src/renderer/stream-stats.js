/* global window */
(() => {
  'use strict';

  const emptyReport = () => ({
    fps: null,
    width: null,
    height: null,
    bitrateKbps: null,
    encodeMs: null,
    rttMs: null,
    qualityLimitationReason: null,
    availableOutgoingKbps: null,
    packetsLost: null,
    fractionLost: null,
    codec: null,
    encoderImplementation: null,
    powerEfficientEncoder: null,
  });

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const nonnegative = value => finite(value) && value >= 0;
  const video = stat => (stat.kind || stat.mediaType) === 'video';

  function counterDelta(current, previous) {
    return nonnegative(current) && nonnegative(previous) && current >= previous
      ? current - previous
      : null;
  }

  function chooseOutbound(entries, previous) {
    const candidates = entries.filter(stat => stat.type === 'outbound-rtp'
      && video(stat) && stat.isRemote !== true && stat.active !== false);
    return candidates.find(stat => stat.id === previous?.id)
      || candidates.sort((left, right) => {
        const leftArea = (left.frameWidth || 0) * (left.frameHeight || 0);
        const rightArea = (right.frameWidth || 0) * (right.frameHeight || 0);
        return rightArea - leftArea || (right.bytesSent || 0) - (left.bytesSent || 0);
      })[0]
      || null;
  }

  function selectedPair(entries, byId, outbound) {
    // Prefer the transport carrying this video's RTP, not another transport's ICE path.
    const transport = byId.get(outbound?.transportId);
    if (transport?.selectedCandidatePairId) {
      const pair = byId.get(transport.selectedCandidatePairId);
      return pair?.type === 'candidate-pair' ? pair : null;
    }
    if (outbound?.transportId) return null;
    const pairs = entries
      .filter(stat => stat.type === 'transport' && stat.selectedCandidatePairId)
      .map(stat => byId.get(stat.selectedCandidatePairId))
      .filter(stat => stat?.type === 'candidate-pair');
    if (pairs.length === 1) return pairs[0];
    // Older Chromium exposes `selected` on the pair itself. A nominated pair alone
    // does not establish that it is the selected pair.
    const legacy = entries.filter(stat => stat.type === 'candidate-pair' && stat.selected === true);
    return legacy.length === 1 ? legacy[0] : null;
  }

  function remoteInbound(entries, byId, outbound) {
    if (!outbound) return null;
    const remote = byId.get(outbound.remoteId);
    if (remote?.type === 'remote-inbound-rtp') return remote;
    return entries.find(stat => stat.type === 'remote-inbound-rtp' && stat.localId === outbound.id)
      || entries.find(stat => stat.type === 'remote-inbound-rtp' && video(stat)
        && outbound.ssrc != null && stat.ssrc === outbound.ssrc)
      || null;
  }

  /**
   * Pure RTCStatsReport reader. Rates use the selected video report's own timestamp
   * (milliseconds), not the UI polling interval. Pass the returned baseline into
   * the next call. Missing, reset and first-sample rate values are null, never
   * estimates. Snapshot fields such as dimensions/RTT can be present immediately.
   *
   * packetsLost is the receiver's cumulative RTCP counter (which may be negative),
   * and fractionLost is its reported interval fraction; neither is synthesized.
   */
  function measure(stats, previous = null) {
    const entries = Array.from(stats.values());
    const byId = new Map(entries.map(stat => [stat.id, stat]));
    const outbound = chooseOutbound(entries, previous);
    const report = emptyReport();
    const pair = selectedPair(entries, byId, outbound);
    if (nonnegative(pair?.currentRoundTripTime)) report.rttMs = pair.currentRoundTripTime * 1000;
    if (nonnegative(pair?.availableOutgoingBitrate)) report.availableOutgoingKbps = pair.availableOutgoingBitrate / 1000;
    if (!outbound) return { report, baseline: null };

    if (nonnegative(outbound.frameWidth) && outbound.frameWidth > 0) report.width = outbound.frameWidth;
    if (nonnegative(outbound.frameHeight) && outbound.frameHeight > 0) report.height = outbound.frameHeight;
    if (['none', 'cpu', 'bandwidth', 'other'].includes(outbound.qualityLimitationReason)) {
      report.qualityLimitationReason = outbound.qualityLimitationReason;
    }
    const codec = byId.get(outbound.codecId);
    if (codec?.type === 'codec' && typeof codec.mimeType === 'string') report.codec = codec.mimeType;
    if (typeof outbound.encoderImplementation === 'string') report.encoderImplementation = outbound.encoderImplementation;
    if (typeof outbound.powerEfficientEncoder === 'boolean') report.powerEfficientEncoder = outbound.powerEfficientEncoder;
    const remote = remoteInbound(entries, byId, outbound);
    if (finite(remote?.packetsLost)) report.packetsLost = remote.packetsLost;
    if (nonnegative(remote?.fractionLost) && remote.fractionLost <= 1) report.fractionLost = remote.fractionLost;

    const baseline = {
      id: outbound.id,
      ssrc: outbound.ssrc,
      codecId: outbound.codecId,
      timestamp: outbound.timestamp,
      framesEncoded: outbound.framesEncoded,
      framesSent: outbound.framesSent,
      bytesSent: outbound.bytesSent,
      totalEncodeTime: outbound.totalEncodeTime,
    };
    const sameStream = previous && previous.id === baseline.id
      && previous.ssrc === baseline.ssrc && previous.codecId === baseline.codecId;
    const elapsedMs = sameStream && finite(baseline.timestamp) && finite(previous.timestamp)
      ? baseline.timestamp - previous.timestamp
      : null;
    if (elapsedMs == null || elapsedMs <= 0) {
      // Cached or out-of-order stats must not move a valid baseline backwards.
      return { report, baseline: sameStream && elapsedMs !== null && elapsedMs <= 0 ? previous : baseline };
    }

    const encoded = counterDelta(baseline.framesEncoded, previous.framesEncoded);
    const sent = counterDelta(baseline.framesSent, previous.framesSent);
    // Prefer encoded frames. Fall back only if this counter is unavailable,
    // never to conceal a counter reset.
    const frameDelta = nonnegative(baseline.framesEncoded) && nonnegative(previous.framesEncoded)
      ? encoded
      : sent;
    if (frameDelta !== null) report.fps = frameDelta * 1000 / elapsedMs;
    const bytes = counterDelta(baseline.bytesSent, previous.bytesSent);
    if (bytes !== null) report.bitrateKbps = bytes * 8 / elapsedMs;
    const encodeSeconds = counterDelta(baseline.totalEncodeTime, previous.totalEncodeTime);
    if (encoded !== null && encoded > 0 && encodeSeconds !== null) {
      report.encodeMs = encodeSeconds * 1000 / encoded;
    }
    return { report, baseline };
  }

  /**
   * Usage: const sampler = YansiStreamStats.createSampler();
   *        const report = await sampler.sample(peerConnection);
   * clear(pc) forgets one connection; clear() forgets every connection. This
   * helper has no timer and makes no network requests. getStats errors propagate
   * so the caller can stop its polling loop when a peer closes.
   */
  function createSampler(onReport) {
    let baselines = new WeakMap();
    return {
      async sample(pc) {
        const stats = await pc.getStats();
        const result = measure(stats, baselines.get(pc));
        if (result.baseline) baselines.set(pc, result.baseline);
        else baselines.delete(pc);
        if (typeof onReport === 'function') onReport(result.report, pc);
        return result.report;
      },
      clear(pc) {
        if (pc) baselines.delete(pc);
        else baselines = new WeakMap();
      },
    };
  }

  window.YansiStreamStats = Object.freeze({ createSampler, measure });
})();
