# Voice Assistant

A self-hosted AI voicemail assistant that answers phone calls, takes messages, and sends you a transcript via Telegram. Built on [Telnyx](https://telnyx.com) for telephony and [Mistral](https://mistral.ai) for speech-to-text, text-to-speech, and the LLM.

## How it works

1. Someone calls your Telnyx number
2. Telnyx POSTs a webhook to `/webhook` — the server answers and starts a bidirectional audio stream
3. The caller's audio is transcribed in real time (Voxtral STT)
4. A Mistral LLM generates a response, which is synthesized to speech (Voxtral TTS) and played back
5. On hangup, the full transcript is sent to you via Telegram

Supports barge-in (caller can interrupt the assistant mid-sentence), configurable call limits (max duration, max turns), and multilingual callers.

## Requirements

- [Telnyx](https://telnyx.com) account with a phone number
- [Mistral](https://mistral.ai) API key (for STT, TTS, and LLM)
- [Telegram](https://telegram.org) bot token + chat ID (for call notifications)
- A public HTTPS URL (e.g. via [ngrok](https://ngrok.com) for local dev, or a VPS for production)
- Node.js 22+ and [pnpm](https://pnpm.io)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Create a `.env` file in the project root with the variables listed in the [Environment variables](#environment-variables) section below.

### 3. Expose your server

The server must be reachable from the public internet for Telnyx webhooks and audio streaming.

For local development:

```bash
ngrok http 3000
```

Set `PUBLIC_URL` in your `.env` to the ngrok HTTPS URL (e.g. `https://abc123.ngrok.io`).

### 4. Configure Telnyx

In the [Telnyx Portal](https://portal.telnyx.com):

- Under your phone number's messaging/voice settings, set the webhook URL to `https://<your-domain>/webhook`
- Copy the **Ed25519 public key** from the portal and set it as `TELNYX_WEBHOOK_PUBLIC_KEY` in your `.env`
- Create an API key and set it as `TELNYX_API_KEY`

### 5. Forward your phone to Telnyx

Dial these codes from the phone you want to forward (replace `+1234567890` with your Telnyx number):

| Condition | Code |
|---|---|
| No answer | `**61*+1234567890**30#` — forwards after 30s of ringing (adjust 5–30 in 5s steps) |
| Busy | `**67*+1234567890#` |
| Unreachable (off / no signal) | `**62*+1234567890#` |
| All three at once | `**004*+1234567890#` |
| **Disable all** | `##004#` |
| Check status | `*#61#` / `*#67#` / `*#62#` |

These are standard GSM MMI codes — they work on any carrier, dialed directly from the iPhone/Android keypad. No app needed.

### 6. Run

```bash
pnpm dev        # development (tsx, hot-reload not included)
pnpm build      # compile TypeScript
pnpm start      # run compiled output
```

> **First-time setup note:** pnpm v10+ blocks native build scripts by default. If `pnpm dev` fails with `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds` once to allow `onnxruntime-node` (the Silero VAD binary) to build.

### 7. Test locally (without a real phone call)

Open **http://localhost:3000/local** in your browser (hard-refresh with Ctrl+Shift+R). This page connects your microphone directly to the assistant — no Telnyx number or ngrok needed. Use a headset; speakerphone will cause the assistant to barge in on its own voice.

## Persona

The assistant's behaviour is defined in `persona.json`. The defaults ship a neutral English-speaking voicemail assistant using the **Paul - Neutral** voice.

| Field | Description |
|---|---|
| `model` | Mistral chat model for the LLM (e.g. `mistral-large-latest`) |
| `voice` | Voxtral voice ID for TTS |
| `silenceMs` | Milliseconds of silence before the STT flush fires |
| `maxDurationSec` | Maximum call duration before auto-hangup |
| `maxTurns` | Maximum conversation turns before auto-hangup |
| `greeting` | First thing the assistant says when the call connects |
| `systemPrompt` | LLM system prompt. Supports `{callerNumber}` and `{datetime}` placeholders |
| `contextBias` | Array of proper nouns (e.g. the owner's name, frequent callers) to bias transcription toward, so STT doesn't mangle them. Optional; defaults to `[]` |

### Personalising the assistant

To customise the persona without modifying the committed `persona.json`, create a `persona.override.json` file in the project root. Only the fields you include will override the defaults — the rest stay as-is.

```bash
cp persona.override.json.example persona.override.json
# edit persona.override.json with your name, language, voice, etc.
```

`persona.override.json` is gitignored and never committed. See `persona.override.json.example` for a full example.

#### Finding voice IDs

```bash
pnpm list-voices   # lists all available Voxtral voices and their IDs
```

The built-in voices are limited. For a custom voice, you can source one from a library like [MiniMax](https://www.minimax.io/audio/voices) or any other platform that offers downloadable voice samples, then upload it to Mistral via their API or console. Once uploaded, the voice gets its own ID that you can drop into `persona.override.json`.

### Using with Docker

The image bakes in the default `persona.json`. To apply your overrides at runtime, uncomment the volume mount in `docker-compose.yml`:

```yaml
volumes:
  - ./persona.override.json:/app/persona.override.json
```

Then run:

```bash
docker compose up
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MISTRAL_API_KEY` | Yes | Mistral API key |
| `TELNYX_WEBHOOK_PUBLIC_KEY` | Yes (prod) | Ed25519 public key from Telnyx portal (base64 DER). Requests are rejected without it. |
| `TELNYX_API_KEY` | Yes (prod) | Telnyx API key for Call Control (answering calls, starting streams) |
| `STREAM_AUTH_TOKEN` | Yes (prod) | Shared secret appended to the `/media-stream` WebSocket URL. Requests are rejected without it. |
| `PUBLIC_URL` | Yes (prod) | Publicly reachable HTTPS base URL of your server |
| `TELEGRAM_API_KEY` | No | Telegram bot token. If unset, call notifications are skipped. |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID to send transcripts to |
| `PORT` | No | HTTP port (default: `3000`) |

## Project structure

```
src/
  core/
    contracts/      # Interfaces: Agent, Transport, Stt, Tts, Notifier, Endpointer
    session/        # CallSession state machine (LISTENING → THINKING → SPEAKING)
  infrastructure/
    agent/          # MistralAgent (LLM), MistralEndpointer (turn-completion gate)
    notifications/  # TelegramNotifier
    stt/            # UploadStt (Voxtral batch STT + Silero VAD)
    transport/      # TelnyxTransport (WebSocket audio), LocalTransport (browser mic/speaker)
    tts/            # VoxtralTts
  server/
    middleware/     # Telnyx webhook Ed25519 auth
    routes/         # /webhook (call control), /media-stream (WebSocket audio), /local (browser test)
  config.ts
  persona.ts
scripts/            # Dev/test utilities (test-stt, test-tts, test-vad, list-voices, …)
assets/
  silero_vad.onnx   # Silero VAD model (neural voice activity detection)
```
