import type { Turn } from './Agent.js';

export interface Endpointer {
  /**
   * Decide whether the caller's CURRENT (still-open) turn is complete and calls
   * for a response now, or whether more words are still expected (a thinking
   * pause, mid-sentence, filler).
   *
   * @param transcript The marker-rich conversation render (same view the responder
   *                    sees), built from the session timeline. The LAST entry is the
   *                    caller's open turn — the line being judged (left unmarked, so
   *                    the gate isn't biased toward "incomplete"). Earlier entries
   *                    (incl. interrupted assistant lines marked `[cut off here ↓]`)
   *                    are context.
   */
  isComplete(transcript: Turn[], signal?: AbortSignal): Promise<boolean>;

  /**
   * Optional: warm the underlying connection/model at call start so the FIRST real
   * verdict isn't slowed by cold-start latency (TLS + model warmup). Fire-and-forget.
   */
  warmup?(): void;
}
