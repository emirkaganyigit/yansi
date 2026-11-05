// Deterministic PCM fixture; never reads a microphone, sound card or system audio.
const fs = require('node:fs');
const marker = process.env.YANSI_AUDIO_TEST_MARKER;
const device = process.argv.find((argument) => argument.startsWith('--device='));
if (device !== '--device=yansi_smoke.monitor') process.exit(2);
function record(event) { if (marker) fs.appendFileSync(marker, JSON.stringify({ event, device }) + '\n'); }
record('started');
let phase = 0;
const timer = setInterval(() => {
  const packet = Buffer.alloc(960 * 2 * 4);
  for (let frame = 0; frame < 960; frame++) {
    const sample = Math.sin(phase) * 0.2;
    phase = (phase + 2 * Math.PI * 440 / 48000) % (2 * Math.PI);
    packet.writeFloatLE(sample, frame * 8);
    packet.writeFloatLE(sample, frame * 8 + 4);
  }
  process.stdout.write(packet);
}, 20);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer); record('stopped'); process.exit(0); });
process.stdout.on('error', () => { clearInterval(timer); process.exit(0); });
