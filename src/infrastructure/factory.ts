import type { WebSocket } from 'ws';
import type { Transport } from '../core/contracts/index.js';
import type { Stt } from '../core/contracts/Stt.js';
import type { Tts } from '../core/contracts/Tts.js';
import type { Agent } from '../core/contracts/Agent.js';
import type { Endpointer } from '../core/contracts/Endpointer.js';
import type { Notifier } from '../core/contracts/Notifier.js';
import { config } from '../config.js';
import { TelnyxTransport } from './transport/TelnyxTransport.js';
import { UploadStt } from './stt/UploadStt.js';
import { VoxtralTts } from './tts/VoxtralTts.js';
import { MistralAgent } from './agent/MistralAgent.js';
import { MistralEndpointer } from './agent/MistralEndpointer.js';
import { TelegramNotifier } from './notifications/TelegramNotifier.js';

export function createTransport(socket: WebSocket, callControlId?: string): Transport {
  return new TelnyxTransport(socket, callControlId, config.telnyxApiKey);
}

export function createStt(): Stt {
  return new UploadStt();
}

export function createTts(): Tts {
  return new VoxtralTts();
}

export function createAgent(callerNumber?: string): Agent {
  return new MistralAgent(callerNumber);
}

export function createEndpointer(): Endpointer {
  return new MistralEndpointer();
}

export function createNotifier(): Notifier {
  return new TelegramNotifier();
}
