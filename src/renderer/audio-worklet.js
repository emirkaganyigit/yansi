/* PCM is rendered only into a MediaStream destination, never the PC speakers. */
class YansiSystemAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.channels = 2;
    this.capacity = Math.max(128, Math.round(sampleRate * (settings.maxBufferMs || 250) / 1000));
    this.warmupFrames = Math.min(this.capacity, Math.round(sampleRate * (settings.warmupMs || 30) / 1000));
    this.buffer = new Float32Array(this.capacity * this.channels);
    this.readFrame = 0;
    this.bufferedFrames = 0;
    this.primed = false;
    this.stopped = false;
    this.port.onmessage = event => {
      const message = event.data;
      if (message?.type === 'stop') {
        this.stopped = true;
        this.primed = false;
        this.bufferedFrames = 0;
        this.buffer.fill(0);
      } else if (!this.stopped && message?.type === 'pcm') {
        this.enqueue(new Float32Array(message.samples));
      }
    };
  }

  enqueue(samples) {
    const incomingFrames = Math.floor(samples.length / this.channels);
    if (!incomingFrames) return;
    // A delayed IPC batch must not turn into an ever-growing audio delay.
    const keptFrames = Math.min(incomingFrames, this.capacity);
    const skipFrames = incomingFrames - keptFrames;
    const discardedFrames = Math.max(0, this.bufferedFrames + keptFrames - this.capacity);
    this.readFrame = (this.readFrame + discardedFrames) % this.capacity;
    this.bufferedFrames -= discardedFrames;
    let writeFrame = (this.readFrame + this.bufferedFrames) % this.capacity;
    for (let frame = 0; frame < keptFrames; frame++) {
      const sourceOffset = (skipFrames + frame) * this.channels;
      const targetOffset = writeFrame * this.channels;
      for (let channel = 0; channel < this.channels; channel++) {
        const value = samples[sourceOffset + channel];
        this.buffer[targetOffset + channel] = Number.isFinite(value) ? value : 0;
      }
      writeFrame = (writeFrame + 1) % this.capacity;
    }
    this.bufferedFrames += keptFrames;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return !this.stopped;
    for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    if (!this.primed) {
      if (this.bufferedFrames < this.warmupFrames) return true;
      this.primed = true;
    }
    const frames = Math.min(output[0].length, this.bufferedFrames);
    for (let frame = 0; frame < frames; frame++) {
      const offset = this.readFrame * this.channels;
      for (let channel = 0; channel < Math.min(output.length, this.channels); channel++) {
        output[channel][frame] = this.buffer[offset + channel];
      }
      this.readFrame = (this.readFrame + 1) % this.capacity;
    }
    this.bufferedFrames -= frames;
    if (this.bufferedFrames === 0) this.primed = false;
    return true;
  }
}

registerProcessor('yansi-system-audio', YansiSystemAudioProcessor);
