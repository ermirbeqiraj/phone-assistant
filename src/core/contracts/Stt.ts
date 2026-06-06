// text: the transcript chunk (partial) or full utterance (final)
// isFinal: true when the utterance is complete (transcription.done event)
export type TranscriptCallback = (text: string, isFinal: boolean) => void;

// Fired once, server-side, the moment sustained caller voice is detected — the
// onset primitive that drives barge-in. Independent of session state.
export type SpeechStartCallback = () => void;

export interface Stt {
  start(
    audioStream: AsyncGenerator<Uint8Array>,
    onTranscript: TranscriptCallback,
    shouldFlush?: () => boolean,
    onSpeechStart?: SpeechStartCallback,
  ): Promise<void>;
}
