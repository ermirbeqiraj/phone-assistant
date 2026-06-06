import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS_DIR = path.join(ROOT, 'logs');

fs.mkdirSync(LOGS_DIR, { recursive: true });

function logFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `${date}.log`);
}

let buffer: string[] | null = null;

type LogListener = (line: string) => void;
const listeners = new Set<LogListener>();

/** Subscribe to live log lines (e.g. for streaming to a browser). Returns an unsubscribe fn. */
export const subscribe = (fn: LogListener): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

function write(level: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;
  process.stderr.write(line);

  for (const fn of listeners) {
    try { fn(line); } catch { /* never let a listener break logging */ }
  }

  if (buffer) {
    buffer.push(line);
  } else {
    try {
      fs.appendFileSync(logFile(), line);
    } catch (err) {
      console.error('Failed to write log file:', err);
    }
  }
}

export const log = (message: string) => write('INFO', message);

export const error = (message: string, err?: unknown): void => {
  const tail = err instanceof Error ? `\n${err.stack ?? err.message}`
             : err !== undefined    ? `\n${String(err)}`
             : '';
  write('ERROR', message + tail);
};

export const startBuffering = (): void => {
  buffer = [];
};

export const flush = async (): Promise<void> => {
  if (!buffer || buffer.length === 0) return;
  const lines = buffer;
  buffer = null;
  try {
    await fs.promises.appendFile(logFile(), lines.join(''));
  } catch (err) {
    console.error('Failed to flush logs:', err);
  }
};
