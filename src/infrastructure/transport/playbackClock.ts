// Shared playback timing for all transports.
//
// TTS (VoxtralTts) emits the SAME format to every transport: Float32 mono PCM
// at 24kHz (4 bytes/sample). A transport's audioOut sends chunks far faster than
// real time — the user hears them over the audio's true duration. To keep the
// session in SPEAKING (and thus interruptible) for the whole reply, audioOut must
// not resolve until that duration has actually elapsed. These helpers express that
// uniformly, independent of how each transport encodes/ships the bytes downstream.

const TTS_SAMPLE_RATE = 24000;
const BYTES_PER_FLOAT32_SAMPLE = 4;

/** Wall-clock playback duration (ms) of `byteLength` bytes of Float32 24kHz mono PCM. */
export function float32PlaybackMs(byteLength: number): number {
  return (byteLength / BYTES_PER_FLOAT32_SAMPLE / TTS_SAMPLE_RATE) * 1000;
}

/** A setTimeout you can resolve early (used to cut the playback wait short on barge-in). */
export function cancellableDelay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => { clearTimeout(timer); resolveFn(); },
  };
}
