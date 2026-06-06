import { Mistral } from '@mistralai/mistralai';
import { SpeechOutputFormat } from '@mistralai/mistralai/models/components';
import type { Tts } from '../../core/contracts/index.js';
import { config } from '../../config.js';
import { persona } from '../../persona.js';
import { log, error } from '../../logger.js';

const TTS_MODEL = 'voxtral-mini-tts-2603';

export class VoxtralTts implements Tts {
  private readonly client = new Mistral({ apiKey: config.mistralApiKey });

  async *synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    log(`[tts] synthesizing: "${text}"`);
    const t0 = Date.now();
    let chunks = 0;
    const stream = await this.client.audio.speech.complete(
      {
        model: TTS_MODEL,
        input: text,
        voiceId: persona.voice,
        responseFormat: SpeechOutputFormat.Pcm,
        stream: true,
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.data.type === 'speech.audio.delta') {
        const buf = Buffer.from(event.data.audioData, 'base64');
        if (chunks === 0) log(`[tts] first chunk: ${buf.byteLength} bytes, first4: ${buf.slice(0, 4).toString('hex')}`);
        chunks++;
        yield buf;
      }
    }
    log(`[tts] done: ${chunks} chunks in ${Date.now() - t0}ms`);
  }
}
