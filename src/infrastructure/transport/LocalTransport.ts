import { spawn } from 'child_process';
import type { Transport } from '../../core/contracts/index.js';

export class LocalTransport implements Transport {
  private micProc: ReturnType<typeof spawn> | null = null;

  ready(): Promise<void> { return Promise.resolve(); }

  async *audioIn(): AsyncGenerator<Uint8Array> {
    const proc = spawn('arecord', [
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      '-t', 'raw',
      '-q',
    ]);
    this.micProc = proc;

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) process.stderr.write(`[arecord] ${msg}\n`);
    });
    proc.on('error', (err) => {
      process.stderr.write(`[mic] arecord error: ${err.message}\n`);
    });

    try {
      for await (const chunk of proc.stdout) {
        yield new Uint8Array(chunk as Buffer);
      }
    } finally {
      proc.kill();
      this.micProc = null;
    }
  }

  async audioOut(
    chunks: AsyncGenerator<Buffer>,
    onCancel: (cancel: () => void) => void,
  ): Promise<void> {
    const proc = spawn('aplay', [
      '-f', 'FLOAT_LE',
      '-r', '24000',
      '-c', '1',
      '-q',
    ]);

    proc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      // "Interrupted system call" is expected when aplay is killed mid-write on barge-in
      if (msg && !msg.includes('Interrupted system call')) {
        process.stderr.write(`[aplay] ${msg}\n`);
      }
    });
    proc.stdin.on('error', () => {});

    let cancelled = false;

    onCancel(() => {
      cancelled = true;
      proc.kill();
    });

    try {
      for await (const chunk of chunks) {
        if (cancelled) break;
        proc.stdin.write(chunk);
      }
    } catch {
      // EPIPE on barge-in
    }

    if (!cancelled) proc.stdin.end();
    await new Promise<void>((resolve) => proc.on('close', resolve));
  }

  close(): void {
    this.micProc?.kill();
    this.micProc = null;
  }
}
