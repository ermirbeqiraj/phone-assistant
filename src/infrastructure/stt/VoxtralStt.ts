import {
  RealtimeTranscription,
  AudioEncoding,
} from '@mistralai/mistralai/extra/realtime';
import type { Stt, TranscriptCallback } from '../../core/contracts/index.js';
import { config } from '../../config.js';
import { persona } from '../../persona.js';
import { log, error } from '../../logger.js';

const MODEL = 'voxtral-mini-realtime-latest';

export class VoxtralStt implements Stt {
  private readonly client = new RealtimeTranscription({ apiKey: config.mistralApiKey });

  async start(
    audioStream: AsyncGenerator<Uint8Array>,
    onTranscript: TranscriptCallback,
    shouldFlush?: () => boolean,
  ): Promise<void> {
    const connection = await this.client.connect(MODEL, {
      audioFormat: { encoding: AudioEncoding.PcmS16le, sampleRate: 16000 },
    });
    log('[stt] connected');

    const sendTask = (async () => {
      try {
        for await (const chunk of audioStream) {
          if (connection.isClosed) break;
          await connection.sendAudio(chunk);
        }
      } catch (err) {
        error(`[stt] send error: ${String(err)}`);
      } finally {
        if (!connection.isClosed) {
          await connection.endAudio().catch(() => {});
        }
      }
    })();

    let silenceTimer: ReturnType<typeof setTimeout> | null = null;

    const armSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(async () => {
        if (connection.isClosed) return;
        if (shouldFlush && !shouldFlush()) {
          armSilenceTimer(); // not ready to flush — check again after another interval
          return;
        }
        log('[stt] silence → flush');
        await connection.flushAudio().catch(() => {});
      }, persona.silenceMs);
    };

    const clearSilenceTimer = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    };

    try {
      for await (const event of connection) {
        if ('raw' in event) {
          log(`[stt] unknown event: ${JSON.stringify(event.raw)}`);
          continue;
        }

        switch (event.type) {
          case 'session.created':
            log('[stt] session created');
            break;
          case 'session.updated':
            break;
          case 'transcription.text.delta':
            armSilenceTimer();
            onTranscript(event.text, false);
            break;
          case 'transcription.done':
            clearSilenceTimer();
            if (event.text) log(`[stt] final: "${event.text}"`);
            onTranscript(event.text, true);
            break;
          case 'transcription.language':
            log(`[stt] language: ${event.language}`);
            break;
          case 'transcription.segment':
            break;
          case 'error':
            error(`[stt] error: ${JSON.stringify(event.error)}`);
            break;
        }
      }
    } catch (err) {
      error(`[stt] connection error: ${String(err)}`);
    } finally {
      clearSilenceTimer();
    }

    await sendTask;
  }
}
