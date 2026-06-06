export interface Tts {
  // Yields decoded PCM audio chunks (24kHz float32) as they arrive.
  // signal: used to cancel the HTTP request on barge-in.
  synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer>;
}
