import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-node';
import { log } from '../../logger.js';

/**
 * Silero VAD (v6.x, MIT) wrapper. A tiny neural net that detects *human speech*
 * rather than mere loudness — so steady background noise (car, café, wind) no
 * longer reads as continuous speech the way an energy/RMS detector would.
 *
 * Usage: one `new SileroVad()` per call (it holds the per-call recurrent `state`);
 * feed it exactly 512-sample (32ms @16kHz) float32 frames via `process()`, which
 * returns P(speech) in [0,1]. The ~2MB weights are loaded once and shared.
 */

// Resolve the .onnx relative to THIS module (cwd is unreliable — see logger.ts).
// src/infrastructure/stt/ → repo root is three levels up; assets/ sits beside src/
// and dist/, so the same relative path works in dev (tsx) and prod (dist).
const MODEL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../assets/silero_vad.onnx',
);

const STATE_LEN = 2 * 1 * 128;
const STATE_DIMS = [2, 1, 128];
const SAMPLE_RATE = 16000n;
// Silero v5+ prepends a rolling context of the previous samples to each window:
// the model is actually fed CONTEXT + 512 = 576 samples. Feeding a bare 512 makes
// it silently return ~0 for everything (the input dim is dynamic, so no error).
const CONTEXT_LEN = 64; // 64 @16kHz (would be 32 @8kHz)
const WINDOW_LEN = 512;

// Resolved I/O names (read from the loaded model rather than hardcoded blindly).
let inAudio = 'input';
let inState = 'state';
let inSr = 'sr';
let outProb = 'output';
let outState = 'stateN';

// Lazy singleton: the weights are read-only and shared across every call.
// Concurrent run() with per-call state tensors is safe.
let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_PATH).then((session) => {
      for (const name of session.inputNames) {
        if (/sr|sample/i.test(name)) inSr = name;
        else if (/state/i.test(name)) inState = name;
        else inAudio = name;
      }
      for (const name of session.outputNames) {
        if (/state/i.test(name)) outState = name;
        else outProb = name;
      }
      log(`[vad] silero loaded (in: ${session.inputNames.join(', ')}; out: ${session.outputNames.join(', ')})`);
      return session;
    });
  }
  return sessionPromise;
}

export class SileroVad {
  // Per-call recurrent state — NEVER shared across calls (their audio memories
  // would bleed). Zero-initialised; carried forward across frames within a call.
  private state = new Float32Array(STATE_LEN);
  // Rolling context: the last CONTEXT_LEN samples of the previous frame, prepended
  // to the next one. Carried within a call, reset between calls.
  private context = new Float32Array(CONTEXT_LEN);

  /** Clear the recurrent state + context (call once at the start of each call/stream). */
  reset(): void {
    this.state = new Float32Array(STATE_LEN);
    this.context = new Float32Array(CONTEXT_LEN);
  }

  /** Run one inference on a 512-sample float32 frame; returns P(speech) in [0,1]. */
  async process(frame512: Float32Array): Promise<number> {
    const session = await getSession();
    // Prepend the rolling context → the model is fed CONTEXT_LEN + 512 samples.
    const input = new Float32Array(CONTEXT_LEN + WINDOW_LEN);
    input.set(this.context, 0);
    input.set(frame512, CONTEXT_LEN);
    this.context = input.slice(-CONTEXT_LEN); // last 64 become next frame's context

    const feeds: Record<string, ort.Tensor> = {
      [inAudio]: new ort.Tensor('float32', input, [1, input.length]),
      [inState]: new ort.Tensor('float32', this.state, STATE_DIMS),
      [inSr]: new ort.Tensor('int64', BigInt64Array.from([SAMPLE_RATE]), []),
    };
    const result = await session.run(feeds);
    // Copy into a fresh array: fixes the buffer-type variance and avoids aliasing
    // any buffer onnxruntime may reuse on the next run.
    this.state = new Float32Array(result[outState]!.data as Float32Array);
    return (result[outProb]!.data as Float32Array)[0] ?? 0;
  }
}
