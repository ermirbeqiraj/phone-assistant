import type { WebSocket } from 'ws';
import type { Transport } from '../../core/contracts/index.js';
import { float32PlaybackMs, cancellableDelay } from './playbackClock.js';
import { log } from '../../logger.js';

/**
 * Browser-based transport for local dev testing.
 * Expects: inbound binary = Int16Array (16kHz PCM s16le)
 *          outbound binary = Buffer (Float32 24kHz PCM)
 *          text frames = JSON control { event: 'clear' | 'stop' }
 */
export class BrowserTransport implements Transport {
  private audioQueue: Uint8Array[] = [];
  private audioResolve: (() => void) | null = null;
  private done = false;
  private closed = false;

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      this.audioQueue.push(new Uint8Array(raw));
      this.audioResolve?.();
      this.audioResolve = null;
    });
    ws.on('close', () => {
      this.done = true;
      this.audioResolve?.();
      this.audioResolve = null;
    });
  }

  ready(): Promise<void> {
    return Promise.resolve();
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
        log('[browser-transport] barge-in: sent clear');
      }
      cancelWait?.();   // cut the playback wait short
    });

    let totalBytes = 0;
    let playStartedAt = 0;
    for await (const chunk of chunks) {
      if (cancelled || this.ws.readyState !== 1) return;
      if (playStartedAt === 0) playStartedAt = Date.now(); // first chunk ≈ playback start
      this.ws.send(chunk);
      totalBytes += chunk.byteLength;
    }
    if (cancelled || this.ws.readyState !== 1) return;

    // Chunks are sent far faster than real time, but the browser plays them over
    // the audio's true duration. Hold here (interruptibly) until playback should
    // be done — keeps the session SPEAKING so barge-in works for the whole reply.
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
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ event: 'stop' }));
      this.ws.close();
    }
  }
}
