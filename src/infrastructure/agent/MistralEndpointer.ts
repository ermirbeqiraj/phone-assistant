import { Mistral } from '@mistralai/mistralai';
import type { Endpointer, Turn } from '../../core/contracts/index.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';

// Runs on every pause, so we want it fast — but mistral-small mis-judged short
// corrections ("Infatti no, no, alle 6, mi scusi.") as WAIT, costing the 2s backstop.
// Bumped one size to medium: a correct COMPLETE beats a wrong WAIT + backstop, even at
// slightly higher per-call latency.
const GATE_MODEL = 'mistral-medium-latest';

const SYSTEM = `You are the turn-taking judge for a phone voice assistant that takes messages in Italian.
You see the conversation so far as a transcript: "Caller:" is the human, "Assistant:" is the bot. Bracketed English notes like [cut off here ↓] are STAGE DIRECTIONS describing what happened — never spoken words, never Italian.
Judge ONLY the LAST "Caller:" line — a live transcription that may be mid-thought. Has the caller finished a self-contained thought that now expects a reply, or are they likely still talking / pausing to think?

Answer with EXACTLY one word, nothing else:
COMPLETE — the last caller line ends on a clear question or a finished request/statement. Judge by how it ENDS: a closing question or complete thought is COMPLETE even if it OPENED with filler or a false start ("allora", "oh", "ehm", "insomma", "senta").
WAIT — the last caller line is mid-sentence, trailing off ("e...", "cioè", "volevo solo dire che..."), or still listing and will clearly continue.

Decide on the latest words, not the opening ones. When genuinely unsure, prefer WAIT — but do not stall on a clearly finished question or request.`;

function renderScript(transcript: Turn[]): string {
  return transcript
    .map(t => `${t.role === 'user' ? 'Caller' : 'Assistant'}: ${t.content}`)
    .join('\n');
}

export class MistralEndpointer implements Endpointer {
  private readonly client = new Mistral({ apiKey: config.mistralApiKey });

  /** Fire-and-forget: open the connection + warm the model so the first real gate is fast. */
  warmup(): void {
    this.client.chat.complete({
      model: GATE_MODEL,
      messages: [{ role: 'user', content: 'ok' }],
      maxTokens: 1,
      temperature: 0,
    }).then(
      () => log('[gate] warmed up'),
      () => { /* ignore — best effort */ },
    );
  }

  async isComplete(transcript: Turn[], signal?: AbortSignal): Promise<boolean> {
    const script = renderScript(transcript);
    const openTurn = transcript[transcript.length - 1]?.content ?? '';
    const t0 = Date.now();
    const response = await this.client.chat.complete(
      {
        model: GATE_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `${script}\nVerdict:` },
        ],
        maxTokens: 4,
        temperature: 0,
      },
      { signal },
    );

    const choice = response.choices?.[0];
    const content = choice?.message?.content;
    const raw = (typeof content === 'string'
      ? content
      : (content ?? []).map(c => ('text' in c ? c.text : '')).join('')
    ).trim().toUpperCase();

    const complete = raw.startsWith('COMPLETE');
    log(`[gate] ${Date.now() - t0}ms → ${complete ? 'COMPLETE' : 'WAIT'} ("${raw}") for: "${openTurn}"`);
    return complete;
  }
}
