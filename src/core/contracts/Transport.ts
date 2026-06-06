export interface Transport {
  // Resolves when the transport is ready to send/receive audio.
  ready(): Promise<void>;

  audioIn(): AsyncGenerator<Uint8Array>;

  // Plays the synthesized audio to the user. MUST resolve only when playback has
  // actually finished (or was cancelled) — NOT merely when the last chunk was sent.
  // The session treats this promise as "the assistant is done speaking", so resolving
  // early (at synthesis speed) would drop it out of SPEAKING while audio is still
  // playing and break barge-in. `onCancel` exposes a cancel fn for barge-in.
  audioOut(
    chunks: AsyncGenerator<Buffer>,
    onCancel: (cancel: () => void) => void,
  ): Promise<void>;

  close(): void;
}
