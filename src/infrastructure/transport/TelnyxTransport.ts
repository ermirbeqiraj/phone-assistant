import type { WebSocket } from 'ws';
import type { Transport } from '../../core/contracts/index.js';
import { float32PlaybackMs, cancellableDelay } from './playbackClock.js';
import { log, error } from '../../logger.js';

/**
 * Telnyx bidirectional RTP streaming (PCMA 8kHz).
 * STT expects 16kHz PCM s16le.
 * TTS outputs 24kHz PCM float32.
 *
 * Inbound:  PCMA 8kHz → PCM s16le 8kHz → upsample 2× → PCM s16le 16kHz
 * Outbound: PCM float32 24kHz → downsample 3× → PCM s16le → PCMA 8kHz
 *           streamed chunk-by-chunk as {"event":"media","media":{"payload":"<base64-pcma>"}}
 */
export class TelnyxTransport implements Transport {
  private streamSid: string | null = null;
  private audioQueue: Uint8Array[] = [];
  private audioResolve: (() => void) | null = null;
  private done = false;
  private closed = false;
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;

  constructor(
    private readonly ws: WebSocket,
    private readonly callControlId?: string,
    private readonly telnyxApiKey?: string,
  ) {
    this.readyPromise = new Promise((resolve) => { this.readyResolve = resolve; });
    ws.on('message', (raw: Buffer) => this.handleMessage(raw));
    ws.on('close', () => this.handleClose());
  }

  ready(): Promise<void> { return this.readyPromise; }

  private handleMessage(raw: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        this.streamSid = (msg.stream_id ?? (msg.start as Record<string, unknown> | undefined)?.streamSid) as string;
        log(`[transport] stream started: ${this.streamSid}`);
        this.readyResolve();
        break;
      }
      case 'media': {
        const media = msg.media as Record<string, unknown> | undefined;
        const payload = media?.payload as string | undefined;
        if (!payload) break;
        const alawBytes = Buffer.from(payload, 'base64');
        const pcm16 = alawTo16kPcm(alawBytes);
        this.audioQueue.push(pcm16);
        this.audioResolve?.();
        this.audioResolve = null;
        break;
      }
      case 'stop':
        this.handleClose();
        break;
    }
  }

  private handleClose(): void {
    this.done = true;
    this.audioResolve?.();
    this.audioResolve = null;
  }

  async *audioIn(): AsyncGenerator<Uint8Array> {
    while (!this.done) {
      while (this.audioQueue.length > 0) {
        yield this.audioQueue.shift()!;
      }
      if (!this.done) {
        await new Promise<void>((resolve) => { this.audioResolve = resolve; });
      }
    }
    while (this.audioQueue.length > 0) {
      yield this.audioQueue.shift()!;
    }
  }

  async audioOut(
    chunks: AsyncGenerator<Buffer>,
    onCancel: (cancel: () => void) => void,
  ): Promise<void> {
    let cancelled = false;
    let cancelWait: (() => void) | null = null;
    onCancel(() => {
      cancelled = true;
      if (this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ event: 'clear' }));
        log('[transport] barge-in: sent clear');
      }
      cancelWait?.();   // cut the playback wait short
    });

    let totalBytes = 0;
    let playStartedAt = 0;
    for await (const chunk of chunks) {
      if (cancelled || this.ws.readyState !== 1) return;
      if (playStartedAt === 0) playStartedAt = Date.now(); // first chunk ≈ playback start
      totalBytes += chunk.byteLength;                      // source Float32 24kHz, before transcode
      const pcma = float32_24kToAlaw8k(chunk);
      this.ws.send(JSON.stringify({
        event: 'media',
        media: { payload: pcma.toString('base64') },
      }));
    }
    if (cancelled || this.ws.readyState !== 1) return;

    // Frames are sent far faster than real time, but Telnyx plays them to the
    // caller over the audio's true duration. Hold here (interruptibly) until
    // playback should be done — keeps the session SPEAKING so barge-in works for
    // the whole reply, matching the browser transport.
    const remaining = float32PlaybackMs(totalBytes) - (Date.now() - playStartedAt);
    if (remaining > 0) {
      const wait = cancellableDelay(remaining);
      cancelWait = wait.cancel;
      await wait.promise;
      cancelWait = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.callControlId && this.telnyxApiKey) {
      const apiKey = this.telnyxApiKey;
      fetch(`https://api.telnyx.com/v2/calls/${this.callControlId}/actions/hangup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then(res => { log(`[transport] hangup → ${res.status}`); })
        .catch(err => { error(`[transport] hangup failed: ${String(err)}`); });
    }

    if (this.ws.readyState === 1) this.ws.close();
  }
}

// ── Inbound codec: PCMA 8kHz → PCM s16le 16kHz ───────────────────────────────

const ALAW_DECODE = new Int16Array(256);
(function buildAlawDecodeTable() {
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55;
    const sign = a & 0x80;
    const t = a & 0x7f;
    let sample: number;
    if (t < 16) {
      sample = (t << 1) | 1;
    } else {
      const exp = t >> 4;
      const mant = t & 0x0f;
      sample = (0x10 | mant) << exp;
    }
    sample <<= 3;
    ALAW_DECODE[i] = sign ? -sample : sample;
  }
})();

function alawTo16kPcm(alawBytes: Buffer): Uint8Array {
  const sampleCount = alawBytes.length;
  const out = Buffer.alloc(sampleCount * 2 * 2);
  let outOff = 0;
  let prev = 0;
  for (let i = 0; i < sampleCount; i++) {
    const curr = ALAW_DECODE[alawBytes[i]!]!;
    const interp = Math.round((prev + curr) / 2);
    out.writeInt16LE(interp, outOff); outOff += 2;
    out.writeInt16LE(curr, outOff); outOff += 2;
    prev = curr;
  }
  return new Uint8Array(out.buffer, 0, outOff);
}

// ── Outbound codec: PCM float32 24kHz → PCMA 8kHz ───────────────────────────

function linearToAlaw(sample: number): number {
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  sample >>= 3;
  let alaw: number;
  if (sample < 16) {
    alaw = sample;
  } else {
    let exp = 1;
    while (sample > (0x1f << exp)) exp++;
    const mant = (sample >> exp) & 0x0f;
    alaw = (exp << 4) | mant;
  }
  return ((sign | alaw) ^ 0x55) & 0xff;
}

function float32_24kToAlaw8k(float32Buf: Buffer): Buffer {
  const floatCount = float32Buf.byteLength / 4;
  const outCount = Math.floor(floatCount / 3);
  const out = Buffer.alloc(outCount);
  for (let i = 0; i < outCount; i++) {
    const s0 = float32Buf.readFloatLE(i * 12);
    const s1 = float32Buf.readFloatLE(i * 12 + 4);
    const s2 = float32Buf.readFloatLE(i * 12 + 8);
    const avg = (s0 + s1 + s2) / 3;
    const pcm16 = Math.round(Math.max(-1, Math.min(1, avg)) * 32767);
    out[i] = linearToAlaw(pcm16);
  }
  return out;
}
