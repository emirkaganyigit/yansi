const { spawn } = require('node:child_process');

const AUDIO_FORMAT = Object.freeze({ sampleRate: 48000, channels: 2, format: 'f32le' });
const FRAME_BYTES = AUDIO_FORMAT.channels * Float32Array.BYTES_PER_ELEMENT;
const MAX_DIAGNOSTIC_BYTES = 2048;

function cancelledError() {
  const error = new Error('Sistem sesi paylaşımı durduruldu.');
  error.name = 'AbortError';
  return error;
}

function commandError(command, error) {
  if (error?.code === 'ENOENT') return new Error(`Sistem sesi için ${command} komutu bulunamadı. Fedora'da pulseaudio-utils paketini kurun.`);
  return new Error(`${command} başlatılamadı: ${error?.message || 'Bilinmeyen hata.'}`);
}

/** Captures the default OUTPUT monitor. It never selects a microphone/source default. */
class SystemAudioCapture {
  constructor({ spawn: spawnCommand = spawn, startupTimeoutMs = 8000, discoveryTimeoutMs = 4000, killTimeoutMs = 1000, env = process.env } = {}) {
    this.spawnCommand = spawnCommand;
    this.startupTimeoutMs = startupTimeoutMs;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.env = env;
    this.session = null;
  }

  /** onData receives interleaved float32 LE stereo bytes, always whole frames. */
  start({ onData, onError = () => {} } = {}) {
    if (this.session) return Promise.reject(new Error('Sistem sesi zaten paylaşılıyor.'));
    if (typeof onData !== 'function' || typeof onError !== 'function') return Promise.reject(new TypeError('Geçerli ses işleyicileri gerekli.'));

    const active = {
      active: true, ready: false, children: new Set(), remainder: Buffer.alloc(0),
      onData, onError, startupTimer: null, cancelDiscovery: null,
    };
    this.session = active;
    const started = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    this.findDefaultSink(active).then((sink) => {
      if (active.active) this.startMonitor(active, `${sink}.monitor`);
    }, (error) => this.fail(active, error));
    return started;
  }

  /** Synchronous cancellation also covers a pending pactl query or parec startup. */
  stop() {
    const active = this.session;
    if (!active) return;
    this.cleanup(active);
    if (!active.ready) active.reject(cancelledError());
  }

  spawnChild(active, command, args) {
    const child = this.spawnCommand(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: this.env });
    const record = { child, closed: false, killTimer: null };
    active.children.add(record);
    child.once('close', () => {
      record.closed = true;
      clearTimeout(record.killTimer);
      active.children.delete(record);
    });
    return record;
  }

  terminate(record) {
    if (record.closed || record.killTimer) return;
    try { record.child.kill('SIGTERM'); } catch { /* The process may already have exited. */ }
    if (record.closed) return;
    record.killTimer = setTimeout(() => {
      if (!record.closed) {
        try { record.child.kill('SIGKILL'); } catch { /* Already exited. */ }
      }
    }, this.killTimeoutMs);
    record.killTimer.unref?.();
  }

  cleanup(active) {
    if (!active.active) return;
    active.active = false;
    active.remainder = Buffer.alloc(0);
    clearTimeout(active.startupTimer);
    if (this.session === active) this.session = null;
    const cancelDiscovery = active.cancelDiscovery;
    active.cancelDiscovery = null;
    cancelDiscovery?.();
    for (const record of active.children) this.terminate(record);
  }

  fail(active, error) {
    if (!active.active) return;
    this.cleanup(active);
    if (!active.ready) active.reject(error);
    else {
      try { active.onError(error); } catch { /* A consumer cannot prevent process cleanup. */ }
    }
  }

  findDefaultSink(active) {
    return new Promise((resolve, reject) => {
      let record;
      let output = Buffer.alloc(0);
      let diagnostic = Buffer.alloc(0);
      let finished = false;
      let timer;
      const finish = (error, sink) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        active.cancelDiscovery = null;
        if (error) reject(error);
        else resolve(sink);
      };
      active.cancelDiscovery = () => finish(cancelledError());
      try { record = this.spawnChild(active, 'pactl', ['get-default-sink']); }
      catch (error) { finish(commandError('pactl', error)); return; }
      record.child.on('error', (error) => finish(commandError('pactl', error)));
      record.child.stdout.on('data', (chunk) => {
        if (finished) return;
        if (output.length + chunk.length > 4096) { finish(new Error('Varsayılan ses çıkışı geçersiz bir yanıt verdi.')); return; }
        output = Buffer.concat([output, chunk]);
      });
      record.child.stderr.on('data', (chunk) => {
        if (diagnostic.length < MAX_DIAGNOSTIC_BYTES) diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length)]);
      });
      record.child.once('close', (code) => {
        if (finished) return;
        if (code !== 0) { finish(new Error(`Varsayılan ses çıkışı okunamadı: ${diagnostic.toString('utf8').trim() || `pactl (${code})`}`)); return; }
        const sink = output.toString('utf8').trim();
        // Names are obtained from pactl, not a user-selected source; never fall back to input.
        if (!sink || sink.length > 1024 || !/^[A-Za-z0-9_.:-]+$/.test(sink)) { finish(new Error('Varsayılan ses çıkışı bulunamadı. Bir hoparlör veya kulaklık çıkışı seçin.')); return; }
        finish(null, sink);
      });
      timer = setTimeout(() => finish(new Error('Varsayılan ses çıkışı zamanında yanıt vermedi.')), this.discoveryTimeoutMs);
    });
  }

  startMonitor(active, sourceName) {
    let record;
    let diagnostic = Buffer.alloc(0);
    try {
      record = this.spawnChild(active, 'parec', [
        `--device=${sourceName}`, '--format=float32le', '--rate=48000', '--channels=2',
        '--raw', '--latency-msec=20', '--client-name=Yansi',
      ]);
    } catch (error) { this.fail(active, commandError('parec', error)); return; }
    record.child.on('error', (error) => this.fail(active, commandError('parec', error)));
    record.child.stderr.on('data', (chunk) => {
      if (diagnostic.length < MAX_DIAGNOSTIC_BYTES) diagnostic = Buffer.concat([diagnostic, chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - diagnostic.length)]);
    });
    record.child.stdout.on('data', (chunk) => {
      if (!active.active || !chunk.length) return;
      const bytes = active.remainder.length ? Buffer.concat([active.remainder, chunk]) : chunk;
      const alignedLength = bytes.length - (bytes.length % FRAME_BYTES);
      active.remainder = Buffer.from(bytes.subarray(alignedLength));
      if (!alignedLength) return;
      if (!active.ready) {
        active.ready = true;
        clearTimeout(active.startupTimer);
        active.resolve({ ...AUDIO_FORMAT, sourceName });
      }
      // Promise consumers receive the format before the first audio callback.
      const pcm = bytes.subarray(0, alignedLength);
      queueMicrotask(() => {
        if (!active.active) return;
        try { active.onData(pcm); }
        catch (error) { this.fail(active, new Error(`Sistem sesi işlenemedi: ${error.message}`)); }
      });
    });
    record.child.once('close', (code, signal) => {
      if (!active.active) return;
      this.fail(active, new Error(`Sistem sesi yakalama durdu: ${diagnostic.toString('utf8').trim() || signal || `parec (${code})`}`));
    });
    active.startupTimer = setTimeout(() => this.fail(active, new Error('Sistem sesi başlatılamadı: ses çıkışından veri alınamadı.')), this.startupTimeoutMs);
  }
}

function createSystemAudioCapture(options) { return new SystemAudioCapture(options); }

module.exports = { SystemAudioCapture, createSystemAudioCapture };
