import type { Agent, Turn } from '../contracts/Agent.js';
import type { Transport } from '../contracts/Transport.js';
import type { Stt } from '../contracts/Stt.js';
import type { Tts } from '../contracts/Tts.js';
import type { Endpointer } from '../contracts/Endpointer.js';
import type { SessionState } from './types.js';
import { log, error, startBuffering, flush } from '../../logger.js';

// Safety net only: how long the caller can go fully quiet mid-turn before we
// finalize despite the gate saying WAIT (trailed off / gate stuck). The gate's
// COMPLETE is the normal trigger; this just bounds the dead-air when the gate
// misjudges a finished turn as WAIT. With always-on capture, finalizing a touch
// early is cheap (later words just become the next turn), so we keep it tight.
const TURN_BACKSTOP_MS = 2000;

// Proportional "what was heard" speaking rate (ms per word). Rough but
// sufficient — precision is explicitly deferred (§3.4 / Phase 2 note).
const MS_PER_WORD = 350;

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'RequestAbortedError') return true;
  return isAbortError((err as { cause?: unknown }).cause);
}

/**
 * Does this transcript clearly end a turn? Only a question mark or exclamation —
 * strong, unambiguous "I'm done, your turn" signals. Ellipsis is trailing-off, not
 * done. Periods are deliberately NOT treated as complete (mid-list/continuation).
 */
function looksComplete(text: string): boolean {
  const t = text.trim();
  if (!t || t.endsWith('...') || t.endsWith('…')) return false;
  return /[?!]$/.test(t);
}

type TimelineEvent =
  | { speaker: 'caller';    text: string; startMs: number; endMs: number }
  | { speaker: 'assistant'; text: string; startMs: number; endMs: number; interrupted: boolean };

export type SessionLimits = {
  maxDurationSec: number;
  maxTurns: number;
  silenceTimeoutSec?: number;
  greeting?: string;
};

export class CallSession {
  private state: SessionState = 'LISTENING';
  private stopped = false;
  private thinkingAbort: AbortController | null = null;
  private cancelSpeaking: (() => void) | null = null;
  private turnId = 0;
  private completedTurns = 0;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Turn-taking: accumulate transcribed pieces into a "story" and let the
  // endpointer decide when the caller is actually done.
  private story = '';
  private storyVersion = 0;
  private gateAbort: AbortController | null = null;
  private backstopTimer: ReturnType<typeof setTimeout> | null = null;

  // Timeline — the session-owned conversation record.
  private timeline: TimelineEvent[] = [];
  private startedAt = 0;          // ms epoch at session start; all *Ms fields are relative to this
  private ttsStartMs = 0;         // when the current assistant TTS began
  private lastOnsetMs = 0;        // when caller voice was last detected (for truncation)
  private currentReply: string | null = null; // full intended text of the in-progress TTS

  constructor(
    private readonly transport: Transport,
    private readonly stt: Stt,
    private readonly tts: Tts,
    private readonly agent: Agent,
    private readonly endpointer: Endpointer,
    private readonly limits: SessionLimits,
  ) {}

  async run(): Promise<void> {
    this.startedAt = Date.now();

    // Warm the gate's connection now so the first real verdict isn't cold-start slow
    // (which would otherwise lose the race to the backstop on the opening turn).
    this.endpointer.warmup?.();

    this.durationTimer = setTimeout(() => {
      log(`[session] max duration reached (${this.limits.maxDurationSec}s) — hanging up`);
      this.stop();
    }, this.limits.maxDurationSec * 1000);

    await this.transport.ready();

    // Start STT in background so it captures audio during and after the greeting.
    const sttDone = this.stt.start(
      this.transport.audioIn(),
      (text) => { this.onPiece(text); },
      () => this.state === 'LISTENING',
      () => { this.onSpeechStart(); },
    );

    if (this.limits.greeting) {
      this.state = 'SPEAKING';
      this.ttsStartMs = Date.now() - this.startedAt;
      this.currentReply = this.limits.greeting;
      const ttsAbort = new AbortController();
      const audioStream = this.tts.synthesize(this.limits.greeting, ttsAbort.signal);
      await this.transport.audioOut(audioStream, (cancel) => {
        this.cancelSpeaking = () => { cancel(); ttsAbort.abort(); };
      });
      this.cancelSpeaking = null;
      // Push greeting event — truncated if barge-in fired, full otherwise.
      if (this.currentReply !== null) {
        this.timeline.push({ speaker: 'assistant', text: this.currentReply, startMs: this.ttsStartMs, endMs: Date.now() - this.startedAt, interrupted: false });
        this.currentReply = null;
      }
      if (this.state === 'SPEAKING') this.state = 'LISTENING';
    }

    this.resetSilenceTimer();
    await sttDone;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.backstopTimer) { clearTimeout(this.backstopTimer); this.backstopTimer = null; }
    this.gateAbort?.abort();
    this.thinkingAbort?.abort();
    this.cancelSpeaking?.();
    this.transport.close();
  }

  /** Returns the conversation record as role/content pairs for the notifier. */
  getTranscript(): { role: 'user' | 'assistant'; content: string }[] {
    return this.timeline.map(e => ({
      role: e.speaker === 'caller' ? 'user' as const : 'assistant' as const,
      content: e.text,
    }));
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (!this.limits.silenceTimeoutSec) return;
    this.silenceTimer = setTimeout(() => {
      if (this.stopped || this.state !== 'LISTENING') return;
      log(`[session] silence timeout (${this.limits.silenceTimeoutSec}s) — hanging up`);
      this.stop();
    }, this.limits.silenceTimeoutSec * 1000);
  }

  /**
   * Render the committed timeline to a marker-rich Turn[] for the LLM (§2.2b).
   * Both the responder and the gate consume this, so the model never has to infer
   * turn dynamics: an interrupted assistant line ends with a bracketed English
   * stage direction `[cut off here ↓]` pointing at the caller line that cut it off.
   * `openStory`, when given, is appended as the caller's current (still-open) turn
   * — the line the gate judges. It is NOT marked: pre-labelling the very line the
   * gate must rule on ("[still speaking]") biases it to always WAIT, defeating the
   * gate. The `[cut off here ↓]` context on prior lines is enough for it to read
   * the interruption dynamics.
   */
  private renderTranscript(openStory?: string): Turn[] {
    const turns: Turn[] = this.timeline.map(e => {
      if (e.speaker === 'assistant') {
        return { role: 'assistant' as const, content: e.interrupted ? `${e.text} [cut off here ↓]` : e.text };
      }
      return { role: 'user' as const, content: e.text };
    });
    if (openStory) turns.push({ role: 'user', content: openStory });
    return turns;
  }

  /**
   * Caller voice onset (server-timestamped, fires regardless of state). This is
   * the barge-in trigger: if the assistant is speaking or thinking, stop it and
   * hand the floor back. The caller's piece arrives ~1s later and accumulates
   * normally (state is LISTENING by then).
   */
  private onSpeechStart(): void {
    if (this.stopped) return;
    this.lastOnsetMs = Date.now() - this.startedAt;

    if (this.state === 'SPEAKING') {
      // Compute and record what the caller actually heard before they spoke.
      if (this.currentReply !== null) {
        const heardMs = Math.max(0, this.lastOnsetMs - this.ttsStartMs);
        const words = this.currentReply.split(/\s+/).filter(Boolean);
        const wordsSpoken = Math.round(heardMs / MS_PER_WORD);
        const interrupted = wordsSpoken < words.length;
        const text = interrupted
          ? words.slice(0, Math.max(1, wordsSpoken)).join(' ') + '…'
          : this.currentReply;
        this.timeline.push({ speaker: 'assistant', text, startMs: this.ttsStartMs, endMs: this.lastOnsetMs, interrupted });
        log(`[session] truncated assistant line (${wordsSpoken}/${words.length} words heard): "${text}"`);
        this.currentReply = null; // prevent handleTurn from double-pushing
      }
      this.cancelSpeaking?.();
      this.cancelSpeaking = null;
      this.turnId++;                      // invalidate the turn so handleTurn's tail is discarded
      this.state = 'LISTENING';
      log('[session] barge-in: caller spoke while assistant speaking → stop');
    } else if (this.state === 'THINKING') {
      this.thinkingAbort?.abort();
      this.thinkingAbort = null;
      this.turnId++;                      // invalidate that turn so its result is dropped
      this.state = 'LISTENING';
      log('[session] barge-in: caller spoke while assistant thinking → abort');
    }
    this.resetSilenceTimer();             // caller is active — push back hangup clock
    if (this.backstopTimer) { clearTimeout(this.backstopTimer); this.backstopTimer = null; }
  }

  /**
   * A transcribed piece arrived. We only capture while LISTENING (no barge-in),
   * so append it to the running story and ask the endpointer whether the caller
   * is done. The gate runs per piece; a long pause is caught by the backstop.
   */
  private onPiece(text: string): void {
    if (this.stopped) return;
    if (this.state !== 'LISTENING') return; // assistant has the floor; ignore stragglers
    const piece = text.trim();
    if (!piece) return;

    this.story = this.story ? `${this.story} ${piece}` : piece;
    const myVersion = ++this.storyVersion;
    this.resetSilenceTimer();  // caller is active — push back the hangup clock
    this.armBackstop();
    log(`[session] piece: "${piece}" → story: "${this.story}"`);

    // Fast-path: a clear question/exclamation almost always expects a reply now.
    // Finalize immediately — skip the gate round-trip AND the backstop. If we're
    // wrong and the caller keeps going, they barge in and we re-decide. (We do NOT
    // fast-path on "." — a period mid-message is often a list/continuation, e.g.
    // "Mi servono tre cose." — so those still go through the gate.)
    if (looksComplete(piece)) {
      log('[session] fast-path: clear question/exclamation → finalize (no gate)');
      this.finalizeTurn();
      return;
    }

    this.runGate(myVersion);
  }

  /** Ask the endpointer if the story so far is a complete turn; finalize if so. */
  private runGate(myVersion: number): void {
    this.gateAbort?.abort();
    const ab = new AbortController();
    this.gateAbort = ab;
    // Gate sees the same marker-rich render as the responder, with the open story
    // appended as the [still speaking] turn it must judge.
    const transcript = this.renderTranscript(this.story);

    (async () => {
      let complete = false;
      try {
        complete = await this.endpointer.isComplete(transcript, ab.signal);
      } catch (err) {
        if (!isAbortError(err)) error('[gate] error', err);
        return;
      }
      // Discard stale verdicts: the caller said more since we asked.
      if (this.stopped || myVersion !== this.storyVersion || this.state !== 'LISTENING') return;
      if (complete) this.finalizeTurn();
    })();
  }

  /** Force-finalize if the caller goes quiet mid-turn (gate stuck / trailed off). */
  private armBackstop(): void {
    if (this.backstopTimer) clearTimeout(this.backstopTimer);
    this.backstopTimer = setTimeout(() => {
      if (this.stopped || this.state !== 'LISTENING' || !this.story) return;
      log('[session] turn backstop — finalizing after long pause');
      this.finalizeTurn();
    }, TURN_BACKSTOP_MS);
  }

  /** The caller's turn is complete: push it to the timeline and hand it to the agent. */
  private finalizeTurn(): void {
    if (this.backstopTimer) { clearTimeout(this.backstopTimer); this.backstopTimer = null; }
    this.gateAbort?.abort();
    this.gateAbort = null;
    // Pause the silence clock while the assistant has the floor; it restarts in
    // handleTurn() once the reply is fully delivered.
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }

    const userText = this.story.trim();
    this.story = '';
    if (!userText) return;

    if (this.completedTurns >= this.limits.maxTurns) {
      log(`[session] max turns reached (${this.limits.maxTurns}) — hanging up`);
      this.stop();
      return;
    }

    // Push caller event to the timeline before handing to the agent.
    const nowMs = Date.now() - this.startedAt;
    this.timeline.push({ speaker: 'caller', text: userText, startMs: this.lastOnsetMs, endMs: nowMs });

    const myTurnId = ++this.turnId;
    this.state = 'THINKING';
    log(`[session] turn ${this.completedTurns + 1}/${this.limits.maxTurns}: "${userText}"`);

    (async () => {
      startBuffering();
      try {
        await this.handleTurn(myTurnId);
      } catch (err: unknown) {
        if (!isAbortError(err)) error('[session] turn error', err);
        if (this.turnId === myTurnId) this.state = 'LISTENING';
      } finally {
        await flush();
      }
    })();
  }

  private async handleTurn(myTurnId: number): Promise<void> {
    const llmAbort = new AbortController();
    this.thinkingAbort = llmAbort;

    let response;
    try {
      const render = this.renderTranscript();
      // Single line: embedded newlines break the SSE log stream to /local.
      log(`[session] render → LLM:  ${render.map(t => `${t.role === 'user' ? 'Caller' : 'Assistant'}: ${t.content}`).join('  |  ')}`);
      response = await this.agent.respond(render, llmAbort.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.thinkingAbort = null;
    }

    if (this.turnId !== myTurnId) return;
    this.state = 'SPEAKING';

    if (response.text) {
      this.ttsStartMs = Date.now() - this.startedAt;
      this.currentReply = response.text;
      const ttsAbort = new AbortController();
      const audioStream = this.tts.synthesize(response.text, ttsAbort.signal);

      await this.transport.audioOut(audioStream, (cancel) => {
        this.cancelSpeaking = () => {
          cancel();
          ttsAbort.abort();
        };
      });

      this.cancelSpeaking = null;
    }

    // Barge-in during SPEAKING bumps turnId and already pushed the truncated line
    // (onSpeechStart). Discard the rest of this turn's tail so it neither logs a
    // completion nor fires a hangup the caller talked over — they re-decide instead.
    if (this.turnId !== myTurnId) return;

    // Completed without interruption — record the full reply as heard.
    if (this.currentReply !== null) {
      this.timeline.push({ speaker: 'assistant', text: this.currentReply, startMs: this.ttsStartMs, endMs: Date.now() - this.startedAt, interrupted: false });
      this.currentReply = null;
    }

    this.completedTurns++;

    if (response.hangup) {
      log('[session] agent requested hangup — closing call');
      this.stop();
      return;
    }

    this.state = 'LISTENING';
    // Restart the caller-silence clock now that we've handed the floor back —
    // otherwise it keeps counting through our own thinking + speaking time.
    this.resetSilenceTimer();
  }
}
