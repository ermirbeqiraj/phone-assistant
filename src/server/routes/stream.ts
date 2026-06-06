import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { timingSafeEqual } from 'crypto';
import { config } from '../../config.js';
import { createTransport, createStt, createTts, createAgent, createEndpointer, createNotifier } from '../../infrastructure/factory.js';
import { CallSession } from '../../core/session/CallSession.js';
import { persona } from '../../persona.js';
import { log, error } from '../../logger.js';

function authorize(provided: string | undefined): boolean {
  const expected = config.streamAuthToken;
  if (!expected) return false; // fail closed
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const streamRoute: FastifyPluginAsync = async (app) => {

  app.get('/media-stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const query = req.query as Record<string, string>;
    if (!authorize(query.auth)) {
      log('[server] /media-stream rejected: invalid or missing auth token');
      socket.close(1008, 'unauthorized');
      return;
    }
    const callerNumber = query.from || undefined;
    const callControlId = query.callControlId || undefined;
    log(`[server] WebSocket connected — caller: ${callerNumber ?? 'unknown'}`);

    const transport = createTransport(socket, callControlId);
    const stt = createStt();
    const tts = createTts();
    const agent = createAgent(callerNumber);
    const endpointer = createEndpointer();
    const notifier = createNotifier();
    const session = new CallSession(transport, stt, tts, agent, endpointer, {
      maxDurationSec: persona.maxDurationSec,
      maxTurns: persona.maxTurns,
      silenceTimeoutSec: persona.silenceTimeoutSec,
      greeting: persona.greeting,
    });

    const startedAt = Date.now();

    session.run().catch((err: unknown) => {
      error(`[server] session error: ${String(err)}`);
    });

    socket.on('close', () => {
      log('[server] WebSocket closed');
      session.stop();
      notifier.onCallEnded({
        callerNumber,
        transcript: session.getTranscript(),
        durationMs: Date.now() - startedAt,
      }).catch((err: unknown) => {
        error(`[telegram] notification failed: ${String(err)}`);
      });
    });
  });
  
};
