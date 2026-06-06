import { LocalTransport } from '../src/infrastructure/transport/LocalTransport.js';
import { VoxtralStt } from '../src/infrastructure/stt/VoxtralStt.js';
import { VoxtralTts } from '../src/infrastructure/tts/VoxtralTts.js';
import { MistralAgent } from '../src/agents/MistralAgent.js';
import { CallSession } from '../src/core/session/CallSession.js';
import { persona } from '../src/persona.js';

const transport = new LocalTransport();
const stt = new VoxtralStt();
const tts = new VoxtralTts();
const agent = new MistralAgent();
const session = new CallSession(transport, stt, tts, agent, {
  maxDurationSec: persona.maxDurationSec,
  maxTurns: persona.maxTurns,
  greeting: persona.greeting,
});

process.stderr.write('[test-loop] voice loop started. Ctrl+C to stop.\n');

process.on('SIGINT', () => {
  process.stderr.write('\n[test-loop] stopping...\n');
  session.stop();
  process.exit(0);
});

await session.run();
