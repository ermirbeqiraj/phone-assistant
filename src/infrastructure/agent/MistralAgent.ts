import { Mistral } from '@mistralai/mistralai';
import type { Agent, AgentResponse, Turn } from '../../core/contracts/index.js';
import { config } from '../../config.js';
import { persona } from '../../persona.js';
import { log } from '../../logger.js';

const HANGUP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'hangup',
    description: 'End the call. Use when: the message is fully collected and you have said goodbye; the caller is persistently disruptive after one redirect; or it is clearly a misdial with no message to take.',
    parameters: { type: 'object', properties: {} },
  },
};

// Explains the render markers to the responder. The transcript may carry bracketed
// English stage directions (e.g. "[cut off here ↓]") that are NOT spoken words — they
// describe what happened. Critically: a line of yours marked as cut off was interrupted
// and abandoned, so you must NOT continue it (that's how "Ho…" became "annotato che…").
const TRANSCRIPT_NOTES = `

The conversation history may contain bracketed English stage directions such as "[cut off here ↓]". These are NOT spoken words and are never Italian — they describe what physically happened on the call. A line of yours ending in "[cut off here ↓]" is one the caller INTERRUPTED before you finished it: that sentence was abandoned, and the caller only heard the partial fragment shown. Never continue, complete, or resume a cut-off line — always start a fresh, complete reply from scratch that takes the interruption into account.`;

export class MistralAgent implements Agent {
  private readonly client = new Mistral({ apiKey: config.mistralApiKey });

  constructor(private readonly callerNumber?: string) {}

  async respond(history: Turn[], signal?: AbortSignal): Promise<AgentResponse> {
    const systemContent = persona.systemPrompt
      .replace('{datetime}', new Date().toLocaleString('it-IT', { dateStyle: 'full', timeStyle: 'short' }))
      .replace('{callerNumber}', this.callerNumber ? `The caller's number is ${this.callerNumber}.` : "The caller's number is unknown.")
      + TRANSCRIPT_NOTES;

    let lastUser = '';
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.role === 'user') { lastUser = history[i]!.content; break; }
    }
    log(`[agent] calling LLM for: "${lastUser}"`);
    const t0 = Date.now();
    const response = await this.client.chat.complete(
      {
        model: persona.model,
        messages: [
          { role: 'system', content: systemContent },
          ...history,
        ],
        tools: [HANGUP_TOOL],
      },
      { signal },
    );

    let text = '';
    let hangup = false;

    const choice = response.choices?.[0];
    if (choice?.message?.content) {
      const content = choice.message.content;
      text = typeof content === 'string' ? content : content.map(c => ('text' in c ? c.text : '')).join('');
    }

    if (choice?.message?.toolCalls) {
      for (const tc of choice.message.toolCalls) {
        if (tc.function?.name === 'hangup') hangup = true;
      }
    }

    log(`[agent] LLM done in ${Date.now() - t0}ms (${text.length} chars)`);
    if (text) log(`[agent] response: "${text}"`);
    if (hangup) log('[agent] hangup requested');

    return { text, hangup };
  }
}
