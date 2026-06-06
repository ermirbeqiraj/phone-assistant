import { Mistral } from '@mistralai/mistralai';
import type { Stt, TranscriptCallback, SpeechStartCallback } from '../../core/contracts/index.js';
import { config } from '../../config.js';
import { persona } from '../../persona.js';
import { SileroVad } from './SileroVad.js';
import { log, error } from '../../logger.js';

/**
 * "Upload mode" STT. Instead of the realtime socket (which auto-detects language
 * and misreads Italian as Spanish), this buffers each utterance locally via a VAD
 * and POSTs it to the HTTP transcription endpoint with the language LOCKED — so
 * Voxtral can't drift to the wrong language.
 *
 * Speech detection is Silero (neural VAD): it recognises human *voice*, not mere
 * loudness, so steady background noise doesn't trigger false onsets / phantom
 * pieces the way an energy detector would.
 *
 * Trade-off: turn-based, +~1 round-trip of latency per turn.
 * Input: 16kHz mono PCM s16le (same as the realtime path).
 */

const MODEL = 'voxtral-mini-latest'; // batch transcription model (NOT the realtime one)
const LANGUAGE = 'it';               // the whole point of this mode — hard-locked
const SAMPLE_RATE = 16000;
const VAD_FRAME = 512;                                 // Silero requires EXACTLY 512 samples @16k (fixed in v5+)
const FRAME_MS = (VAD_FRAME / SAMPLE_RATE) * 1000;     // 32ms per VAD frame
const SPEECH_THRESHOLD = 0.5;                          // P(speech) to count a frame as voiced
const EXIT_THRESHOLD = 0.35;                           // hysteresis: stay voiced until prob drops below this
const MIN_SPEECH_MS = 250;                             // sustained voice before we declare onset (debounces blips)
const MIN_SILENCE_MS = 500;                            // sustained silence that ends a piece (tunable for turn-taking)
const PREROLL_MS = 200;                                // audio kept before onset so we don't clip the start
const PREROLL_FRAMES = Math.ceil(PREROLL_MS / FRAME_MS);
const MIN_UTTERANCE_SAMPLES = SAMPLE_RATE * 0.3;       // ignore <300ms blips

export class UploadStt implements Stt {
  private readonly client = new Mistral({ apiKey: config.mistralApiKey });

  async start(
    audioStream: AsyncGenerator<Uint8Array>,
    onTranscript: TranscriptCallback,
    shouldFlush?: () => boolean,
    onSpeechStart?: SpeechStartCallback,
  ): Promise<void> {
    void shouldFlush; // mic is always on now; gating moved to the assistant's "mouth" (see overview §1/§4)

    const vad = new SileroVad();
    vad.reset();                    // per-call recurrent state; runs continuously across the whole call

    const samples: number[] = [];   // pending samples awaiting full VAD frames
    let carryByte = -1;             // odd trailing byte across chunks

    const preRoll: number[][] = []; // ring buffer of recent silent frames
    let utterance: number[] = [];
    let inSpeech = false;
    let voiced = false;             // smoothed (hysteresis) voice-activity state
    let speechMs = 0;               // consecutive voiced ms (for onset)
    let silenceMs = 0;              // consecutive unvoiced ms while in speech (for piece end)

    // Onset fires once per speech segment, regardless of session state — it's how
    // the session barges in. Reset when the segment ends (finalize).
    let onsetFired = false;

    const reset = () => {
      utterance = [];
      inSpeech = false;
      voiced = false;
      speechMs = 0;
      silenceMs = 0;
      onsetFired = false;
      // NB: do NOT reset the VAD here — Silero runs as a continuous stream across
      // the whole call; only its per-segment bookkeeping resets.
    };

    const finalize = async () => {
      const captured = utterance;
      reset();
      preRoll.length = 0;
      if (captured.length < MIN_UTTERANCE_SAMPLES) return;
      try {
        const wav = encodeWav(Int16Array.from(captured), SAMPLE_RATE);
        const t0 = Date.now();
        const res = await this.client.audio.transcriptions.complete({
          model: MODEL,
          file: { fileName: 'utterance.wav', content: wav },
          language: LANGUAGE,
          // Bias transcription toward proper nouns it would otherwise mangle
          // (e.g. the owner's name, frequent callers). Configured per persona.
          contextBias: persona.contextBias,
        });
        const text = (res.text ?? '').trim();
        log(`[stt] transcribed ${(captured.length / SAMPLE_RATE).toFixed(1)}s in ${Date.now() - t0}ms → "${text}"`);
        if (text) onTranscript(text, true);
      } catch (err) {
        error(`[stt] transcription failed: ${String(err)}`);
      }
    };

    // One 512-sample VAD frame. Mic is ALWAYS on (§1/§4): we detect voice
    // unconditionally and fire onset so the session can barge-in.
    const handleFrame = async (frame: number[]) => {
      const f32 = new Float32Array(VAD_FRAME);
      for (let i = 0; i < VAD_FRAME; i++) f32[i] = frame[i]! / 32768;
      const prob = await vad.process(f32);

      // Hysteresis: only flip to voiced at >= SPEECH_THRESHOLD, back to unvoiced
      // at < EXIT_THRESHOLD; in between, hold — so minor dips don't fragment speech.
      if (prob >= SPEECH_THRESHOLD) voiced = true;
      else if (prob < EXIT_THRESHOLD) voiced = false;

      if (voiced) {
        speechMs += FRAME_MS;
        silenceMs = 0;
        // Debounce: only sustained voice counts as onset, so a brief blip of
        // detected speech doesn't trigger barge-in.
        if (!onsetFired && speechMs >= MIN_SPEECH_MS) {
          onsetFired = true;
          log('[stt] speech onset');
          onSpeechStart?.();
        }
        if (!inSpeech) {
          inSpeech = true;
          for (const f of preRoll) utterance.push(...f); // prepend onset context
          preRoll.length = 0;
        }
        utterance.push(...frame);
      } else if (inSpeech) {
        speechMs = 0;
        utterance.push(...frame); // keep trailing silence
        silenceMs += FRAME_MS;
        if (silenceMs >= MIN_SILENCE_MS) await finalize();
      } else {
        speechMs = 0;
        preRoll.push(frame);
        if (preRoll.length > PREROLL_FRAMES) preRoll.shift();
      }
    };

    log(`[stt] upload mode ready (lang=${LANGUAGE}, model=${MODEL}, vad=silero)`);

    try {
      for await (const chunk of audioStream) {
        // Decode s16le bytes → samples, carrying any odd byte between chunks.
        let i = 0;
        if (carryByte !== -1 && chunk.length > 0) {
          samples.push(toInt16(carryByte | (chunk[0]! << 8)));
          carryByte = -1;
          i = 1;
        }
        for (; i + 1 < chunk.length; i += 2) {
          samples.push(toInt16(chunk[i]! | (chunk[i + 1]! << 8)));
        }
        if (i < chunk.length) carryByte = chunk[i]!;

        // Re-window to Silero's required 512-sample frames.
        while (samples.length >= VAD_FRAME) {
          await handleFrame(samples.splice(0, VAD_FRAME));
        }
      }
      // Stream ended mid-utterance — flush whatever we have.
      if (inSpeech) await finalize();
    } catch (err) {
      error(`[stt] upload stream error: ${String(err)}`);
    }
  }
}

function toInt16(u: number): number {
  return u >= 0x8000 ? u - 0x10000 : u;
}

function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) { view.setInt16(off, pcm[i]!, true); off += 2; }
  return new Uint8Array(buf);
}
