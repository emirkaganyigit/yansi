(() => {
  const SAMPLE_RATE = 48000;
  const CHANNELS = 2;

  function decodePcm(data) {
    const bytes = ArrayBuffer.isView(data)
      ? new DataView(data.buffer, data.byteOffset, data.byteLength)
      : new DataView(data);
    if (bytes.byteLength % (CHANNELS * Float32Array.BYTES_PER_ELEMENT) !== 0) {
      throw new Error('Sistem sesi verisi stereo PCM biçiminde değil.');
    }
    // Own this buffer before transferring it: the preload bridge may retain its copy.
    const samples = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = bytes.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    }
    return samples;
  }

  function cancelledError() {
    const error = new Error('Sistem sesi paylaşımı durduruldu.');
    error.name = 'AbortError';
    return error;
  }

  async function start(api, { signal } = {}) {
    if (!api?.startSystemAudio || !api?.stopSystemAudio || !api?.onAudioData) {
      throw new Error('Bu sürüm sistem sesi paylaşımını desteklemiyor.');
    }
    let audioContext;
    let destination;
    let node;
    let unsubscribeData;
    let unsubscribeEvent;
    let backendStarted = false;
    let stopped = false;
    let stopPromise;
    let fatalError;

    const stop = () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      signal?.removeEventListener('abort', stop);
      unsubscribeData?.();
      unsubscribeEvent?.();
      if (node) {
        node.port.onmessage = null;
        node.port.postMessage({ type: 'stop' });
        node.disconnect();
      }
      destination?.stream.getTracks().forEach(track => track.stop());
      destination?.disconnect();
      stopPromise = Promise.allSettled([
        backendStarted ? api.stopSystemAudio() : Promise.resolve(),
        audioContext && audioContext.state !== 'closed' ? audioContext.close() : Promise.resolve(),
      ]).then(() => undefined);
      return stopPromise;
    };

    try {
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) throw cancelledError();
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      // Call resume immediately, while the caller's share-button action is active.
      const resumed = audioContext.resume();
      const moduleUrl = new URL('audio-worklet.js', document.baseURI);
      await Promise.all([resumed, audioContext.audioWorklet.addModule(moduleUrl.href)]);
      if (stopped || signal?.aborted) throw cancelledError();
      if (audioContext.sampleRate !== SAMPLE_RATE) {
        throw new Error('Sistem sesi için 48 kHz ses çıkışı oluşturulamadı.');
      }
      destination = audioContext.createMediaStreamDestination();
      node = new AudioWorkletNode(audioContext, 'yansi-system-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [CHANNELS],
        processorOptions: { maxBufferMs: 250, warmupMs: 30 },
      });
      node.connect(destination);
      // Do not connect to audioContext.destination: this would replay PC output
      // into its own captured monitor and create feedback.
      unsubscribeData = api.onAudioData(data => {
        if (stopped) return;
        try {
          const samples = decodePcm(data);
          if (samples.length) node.port.postMessage({ type: 'pcm', samples: samples.buffer }, [samples.buffer]);
        } catch (error) {
          fatalError = error;
          void stop();
        }
      });
      if (api.onEvent) {
        unsubscribeEvent = api.onEvent(event => {
          if (event?.type !== 'audio-error') return;
          fatalError = new Error(event.message || 'Sistem sesi paylaşımı durdu.');
          void stop();
        });
      }
      // Subscribe first so the first audio chunk cannot be lost during IPC setup.
      if (stopped || signal?.aborted) throw fatalError || cancelledError();
      backendStarted = true;
      const details = await api.startSystemAudio();
      if (fatalError) throw fatalError;
      if (stopped || signal?.aborted) throw cancelledError();
      if (details?.sampleRate !== SAMPLE_RATE || details?.channels !== CHANNELS || details?.format !== 'f32le') {
        throw new Error('Sistem sesi 48 kHz stereo PCM biçiminde başlatılamadı.');
      }
      return { stream: destination.stream, audioContext, sourceName: details.sourceName || '', stop };
    } catch (error) {
      await stop();
      throw error;
    }
  }

  window.YansiSystemAudio = Object.freeze({ start });
})();
