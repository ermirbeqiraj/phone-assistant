/**
 * Offline Silero VAD harness — validates what Phase 4 actually promises:
 *   - engine/road noise with NO voice → should NOT register as speech (no onset)
 *   - real speech → detected (onset)
 *   - speech mixed INTO noise → voice still detected (VAD detects presence; it does
 *     NOT denoise — transcription quality in noise is a separate, deferred problem)
 *
 * Speech is produced via TTS (needs network); noise is synthesised locally.
 * Run: pnpm tsx scripts/test-vad.ts
 */
import { VoxtralTts } from '../src/infrastructure/tts/VoxtralTts.js';
import { SileroVad } from '../src/infrastructure/stt/SileroVad.js';

const SR = 16000;
const WIN = 512;
const FRAME_MS = (WIN / SR) * 1000;
const SPEECH_THRESHOLD = 0.5;
const EXIT_THRESHOLD = 0.35;
const MIN_SPEECH_MS = 250;
const MIN_SILENCE_MS = 500;

// Engine-like rumble: low fundamental + harmonics + broadband, lightly modulated.
function engineNoise(seconds: number, amp: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const partials = [45, 90, 135, 180, 220];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < partials.length; k++) s += Math.sin(2 * Math.PI * partials[k]! * t) / (k + 1);
    s = s / 2 + rnd() * 0.6;                 // broadband hiss on top of the rumble
    s *= 0.85 + 0.15 * Math.sin(2 * Math.PI * 8 * t); // slight idle modulation
    out[i] = s * amp;
  }
  return out;
}

function rms(a: Float32Array): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length);
}

async function ttsSpeech16k(text: string): Promise<Float32Array> {
  const tts = new VoxtralTts();
  const bufs: Buffer[] = [];
  for await (const b of tts.synthesize(text)) bufs.push(b);
  const all = Buffer.concat(bufs);
  const f24 = new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4));
  const n16 = Math.floor(f24.length * SR / 24000);
  const f16 = new Float32Array(n16);
  for (let i = 0; i < n16; i++) { const x = i * 1.5, a = Math.floor(x), t = x - a; f16[i] = (f24[a] ?? 0) * (1 - t) + (f24[a + 1] ?? 0) * t; }
  return f16;
}

/** Run the production onset/piece state machine over a signal; report what fired. */
async function runVad(label: string, signal: Float32Array): Promise<void> {
  const vad = new SileroVad(); vad.reset();
  let voiced = false, speechMs = 0, silenceMs = 0, inSpeech = false, onsetFired = false;
  let onsets = 0, pieces = 0, voicedFrames = 0, total = 0, maxP = 0;
  for (let off = 0; off + WIN <= signal.length; off += WIN) {
    const p = await vad.process(signal.slice(off, off + WIN));
    maxP = Math.max(maxP, p); total++;
    if (p >= SPEECH_THRESHOLD) voiced = true; else if (p < EXIT_THRESHOLD) voiced = false;
    if (voiced) {
      voicedFrames++; speechMs += FRAME_MS; silenceMs = 0;
      if (!onsetFired && speechMs >= MIN_SPEECH_MS) { onsetFired = true; onsets++; }
      if (!inSpeech) inSpeech = true;
    } else {
      speechMs = 0;
      if (inSpeech) { silenceMs += FRAME_MS; if (silenceMs >= MIN_SILENCE_MS) { pieces++; inSpeech = false; onsetFired = false; } }
    }
  }
  console.log(`${label.padEnd(26)} rms=${rms(signal).toFixed(3)} maxP=${maxP.toFixed(3)} voiced=${voicedFrames}/${total} onsets=${onsets} pieces=${pieces}`);
}

const speech = await ttsSpeech16k('Pronto, sono il meccanico, la macchina di Ermir è pronta da ritirare.');
console.log(`(speech rms=${rms(speech).toFixed(3)}, ${(speech.length / SR).toFixed(1)}s)\n`);

// 1) noise only at increasing loudness — the headline: NO onsets expected.
for (const amp of [0.05, 0.1, 0.2, 0.35]) {
  await runVad(`noise-only amp=${amp}`, engineNoise(4, amp));
}
console.log();
// 2) clean speech — onset expected.
await runVad('clean speech', speech);
// 3) speech mixed into noise at a few SNRs — voice should still be detected.
for (const namp of [0.05, 0.1, 0.2]) {
  const noise = engineNoise(speech.length / SR + 1, namp);
  const mix = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) mix[i] = Math.max(-1, Math.min(1, speech[i]! + noise[i]!));
  await runVad(`speech+noise namp=${namp}`, mix);
}
