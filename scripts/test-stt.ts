import { LocalTransport } from '../src/infrastructure/transport/LocalTransport.js';
import { VoxtralStt } from '../src/infrastructure/stt/VoxtralStt.js';

const transport = new LocalTransport();
const stt = new VoxtralStt();

process.stderr.write('[test-stt] speak into the mic...\n');

await stt.start(transport.audioIn(), (text, isFinal) => {
  if (isFinal) {
    process.stdout.write(`[final] ${text}\n`);
  } else {
    process.stdout.write(`[delta] ${text}\n`);
  }
});
