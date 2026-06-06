# Turn-taking test script (read aloud in Italian)

Open **http://localhost:3000/local** → hard refresh (Ctrl+Shift+R) → **Start Call**.
Greeting: *"Pronto, qui l'assistente AI di Ermir."*

For each scenario, read the **bold** Italian aloud. `…[pausa Ns]…` = stop talking for ~N
seconds (stay silent, don't make noise). `‖ INTERROMPI` = start talking **over** the
assistant while it is still speaking. Watch the **Server logs** panel for the noted lines.

> Use a **headset** (the design assumes no echo). On a speakerphone the assistant would
> barge-in on its own voice — that's the deferred echo case, not a bug here.

**Log lines you'll be matching:**
- `[stt] speech onset` — caller voice detected (fires in any state; drives barge-in)
- `[gate] … → COMPLETE / WAIT ("…") for: "<open turn>"` — turn-completion verdict
- `[session] turn N/15: "…"` — a turn was finalized and sent to the LLM
- `[session] turn backstop — finalizing after long pause` — gate missed; 3.5s fallback fired
- `[session] barge-in: caller spoke while assistant speaking → stop`
- `[session] barge-in: caller spoke while assistant thinking → abort`
- `[browser-transport] barge-in: sent clear` — playback cut immediately
- `[session] truncated assistant line (N/M words heard): "…"` — only the heard prefix is kept
- `[session] render → LLM:  Caller: … | Assistant: … [cut off here ↓] | …` — the
  marker-rich transcript fed to the responder; interrupted lines show `… [cut off here ↓]`

---

# Part A — Turn completion (gate accuracy)

## A1 — Clean question (COMPLETE, fast)
> **"Pronto, con chi sto parlando?"**

Watch: one `piece` → `[gate] … → COMPLETE` → `turn 1`. No backstop, no waiting.

## A2 — Thinking pause mid-thought (WAIT, then finish)
> **"Allora… volevo lasciare un messaggio per Ermir…"**  …[pausa 3s]…  **"…gli dica che la riunione di domani è spostata alle quindici."**

Watch: first piece → `WAIT` (must NOT respond during the pause). After you continue and
stop → `COMPLETE` → `turn`. Core behavior — no premature cut-off.

## A3 — Listing with pauses (WAIT between items, COMPLETE at the end)
> **"Senta, mi servono tre cose…"**  …[pausa 2s]…  **"il preventivo…"**  …[pausa 2s]…  **"la fattura…"**  …[pausa 2s]…  **"e la data di consegna. Può riferirglielo?"**

Watch: several `WAIT` verdicts as the story grows; `COMPLETE` only after the final question.

## A4 — Trail off into silence (the 3.5s backstop finalizes)
> **"Niente, volevo solo dire che…"**  …[pausa 5s, resta in silenzio]…

Watch: `WAIT`, then after ~3.5s `turn backstop — finalizing after long pause` → it responds.

## A5 — Filler-first question (decisive gate, should NOT hit the backstop)
> **"Oh… ecco… insomma, con chi sto parlando?"**

Watch: should land `COMPLETE` on the closing question despite the filler opening — i.e. a
fast `turn`, NOT a 3.5s backstop. (This is the gate-decisiveness tune.)

---

# Part B — Always-on capture & barge-in (the rework)

## B1 — Interrupt the greeting (barge-in while SPEAKING)
Start the call and, **while the greeting is still playing**, ‖ INTERROMPI:
> **"Pronto?"**

Watch: `speech onset` → `barge-in: sent clear` → `barge-in: … speaking → stop`. Audio
stops almost immediately. The greeting is stored truncated (`truncated assistant line`).

## B2 — Interrupt a reply mid-sentence (barge-in + truncation)
> **"Pronto, con chi sto parlando?"**

Let it start answering, then ‖ INTERROMPI partway through:
> **"Sì, senta…"**

Watch: `truncated assistant line (N/M words heard): "…"` — N should roughly match how much
you heard; the stored line is the **prefix + …**, not the full sentence. Then it answers
your new words. Nothing you said is dropped.

## B3 — Interrupt while it's THINKING (abort the responder)
Ask a question, then start talking again **right after the gate says COMPLETE but before the
reply starts playing** (the ~1s LLM+TTS window):
> **"Pronto, mi sente?"** … (immediately) … **"Volevo aggiungere una cosa."**

Watch: `barge-in: … thinking → abort`. The aborted reply is **never** synthesized or logged;
your follow-up becomes the live turn. (Timing-dependent — retry if you miss the window.)

## B4 — Interrupt with NEW INFO (the merged re-decide) ★ headline test
> **"Lascio un messaggio: la riunione di domani è alle quindici."**

When it starts confirming "…alle quindici…", ‖ INTERROMPI with a correction:
> **"No, scusi, alle sedici."**

Watch: the first reply is `truncated`, then a **new turn** finalizes with your correction,
and the final answer must confirm **alle sedici** — proving it re-decided over the merged
picture, not the pre-interruption "quindici". (Phase 3 Part A + B.)

## B5 — No stale reply (rapid interrupt)
> **"Mi dica, Ermir c'è?"**

The instant it begins replying, ‖ INTERROMPI immediately:
> **"Aspetti, aspetti."**

Watch: `barge-in: … speaking → stop`. The original reply must **not** resume after your new
turn, and there must be **no second `turn` log for the aborted reply**. `turnId` bump
guarantees the dead turn's tail is discarded (no late `completed`/`hangup`).

## B6 — Common ground holds (it re-asks)
> **"Buongiorno."**

When it asks **"…posso sapere il suo nome…"**, ‖ INTERROMPI before it finishes the question:
> **"Sono Marco."** …[pausa 2s]…

Watch: because its question was stored truncated (`… [cut off here ↓]`), the assistant
should behave as if it **never finished asking** — it should not assume it already had a
prior answer. Coherent re-ask / acknowledgement, no hallucinated context.

---

# Part C — Clean full run (sanity)

A normal message with no interruptions, end to end:
> **"Buongiorno, sono il meccanico. La macchina di Ermir è pronta da ritirare. Mi può far
> richiamare? Grazie, arrivederci."**

Watch: gate `COMPLETE`, one `turn`, a full uninterrupted reply (NO `truncated` line,
`interrupted:false`), then the agent's goodbye/hangup. Telegram summary sent on disconnect.

---

### What we're judging
- **Gate accuracy** (A1–A5): does `COMPLETE`/`WAIT` match what a human would do? Backstop
  should be the exception, not the rule.
- **Barge-in latency** (B1–B5): assistant stops within a few hundred ms of `speech onset`.
- **Truncation fidelity** (B2, B4, B6): stored assistant line = what was actually *heard*,
  marked interrupted — never the full intended sentence.
- **Re-decide correctness** (B4): the final answer reflects the **merged** timeline.
- **No stale/duplicate turns** (B5): an interrupted turn leaves no completion behind.
- **Common ground** (B6): the model never acts on words the caller never heard.

> The marker-rich render is observable directly: `[cut off here ↓]` appears in the
> `[session] render → LLM:` line (the exact transcript the responder and gate see).
> B4/B6 confirm the model actually *acts* on those markers.

Paste the full Server-logs panel after the run.
