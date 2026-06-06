export type CallEndedEvent = {
  callerNumber?: string;
  transcript: { role: 'user' | 'assistant'; content: string }[];
  durationMs: number;
};

export interface Notifier {
  onCallEnded(event: CallEndedEvent): Promise<void>;
}
