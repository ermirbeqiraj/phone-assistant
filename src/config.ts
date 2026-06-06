import 'dotenv/config';

function require(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  mistralApiKey: require('MISTRAL_API_KEY'),
  port: Number(process.env.PORT ?? 3000),
  // Telnyx — optional locally, required in production
  telnyxWebhookPublicKey: process.env.TELNYX_WEBHOOK_PUBLIC_KEY, // Ed25519 public key (base64 DER) from Telnyx portal
  streamAuthToken: process.env.STREAM_AUTH_TOKEN, // shared secret we put in /media-stream URLs to authenticate Telnyx
  telnyxApiKey: process.env.TELNYX_API_KEY,        // for Call Control API (bidirectional RTP streaming)
  publicUrl: process.env.PUBLIC_URL,
  telegramApiKey: process.env.TELEGRAM_API_KEY,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};
