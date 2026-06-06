import type { Notifier, CallEndedEvent } from '../../core/contracts/index.js';
import { config } from '../../config.js';
import { log, error } from '../../logger.js';

export class TelegramNotifier implements Notifier {
  async onCallEnded(event: CallEndedEvent): Promise<void> {
    if (!config.telegramApiKey || !config.telegramChatId) {
      log('[telegram] skipped — TELEGRAM_API_KEY or TELEGRAM_CHAT_ID not set');
      return;
    }

    if (event.transcript.length === 0) {
      log('[telegram] skipped — no conversation to report');
      return;
    }

    const from = event.callerNumber ?? 'unknown number';
    const duration = Math.round(event.durationMs / 1000);
    const transcript = event.transcript
      .map((m) => `${m.role === 'user' ? '📞 Caller' : '🤖 Assistant'}: ${m.content}`)
      .join('\n');

    const text = `📬 *New voicemail from ${from}* (${duration}s)\n\n${transcript}`;

    const res = await fetch(
      `https://api.telegram.org/bot${config.telegramApiKey}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          parse_mode: 'Markdown',
        }),
      },
    );

    if (res.ok) {
      log('[telegram] call summary sent');
    } else {
      const body = await res.text();
      error(`[telegram] failed to send: ${res.status} ${body}`);
    }
  }
}
