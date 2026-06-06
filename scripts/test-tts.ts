import { LocalTransport } from '../src/infrastructure/transport/LocalTransport.js';
import { VoxtralTts } from '../src/infrastructure/tts/VoxtralTts.js';

const text = process.argv[2] ?? 'Hello! This is a TTS test. How does this sound?';

const transport = new LocalTransport();
const tts = new VoxtralTts();

process.stderr.write(`[test-tts] synthesizing: "${text}"\n`);

const chunks = tts.synthesize(text);

await transport.audioOut(chunks, (_cancel) => {});

process.stderr.write('[test-tts] done\n');
