# Behavior Debugger

**Deferred Intelligence for behavioral debugging.**

Most "AI assistant" tools answer immediately. This one is built around a different
premise: **if the evidence is not good enough to support a conclusion, the correct
action is to WAIT — and to make that waiting a real, persisted, testable state.**

You tell it what you were trying to do. It watches *how* you actually worked,
decides whether it knows enough to explain why you got stuck, and — when it doesn't —
schedules a wake-up and comes back later with more evidence, instead of guessing.

---

## The two ideas

### 1. Deferred Intelligence

`WAITING` is not a sentence the model writes. It is a **persisted phase with an
absolute `waitUntil` timestamp**, owned by a state machine that cannot be talked out
of it:

- Kill the process mid-wait, restart it, and the scheduler **finds the parked session
  and resumes it**. (`WaitScheduler.recoverPendingWaits()`)
- A deadline that already passed fires **immediately** on boot.
- Sufficiency is computed from **five weighted, arithmetic gates** — never a vibe.

```
gate                      weight   what it measures
─────────────────────────────────────────────────────────────────
minEvents                  0.25    enough behavioral events (≥12)
minObservationMinutes      0.25    long enough to be a pattern (≥5 min)
minDistinctKinds           0.20    enough variety to compare (≥3 kinds)
minStableSubwindows        0.20    the pattern REPEATS (≥2 of 3 sub-windows)
baseline                   0.10    switching is countable at all
```

If any gate fails, the system emits a `SufficiencyReport` that **must** name what is
missing and **must** propose a concrete next observation — enforced by
`validateSufficiencyReport()`, which rejects a `WAIT` without those fields.

### 2. Behavior Debugging

It doesn't hand you one root cause. It produces **competing hypotheses**, each with
supporting evidence, **contradicting evidence**, a calibrated confidence, and —
crucially — **missing evidence**:

```
LEADING   81%  Documentation Fragmentation
            sup 3 · con 0 · missing 3
          71%  Frequent Context Switching
            sup 2 · con 0 · missing 2
          50%  Unclear Task Definition
            sup 1 · con 0 · missing 2
          31%  Undefined Success Criteria
            sup 1 · con 2 · missing 2
```

`assertMultiHypothesis()` rejects any diagnosis with fewer than two candidates, and
confidence is **capped at 0.95** — "enough to act on" is not "proven".

Then it closes the loop: propose an intervention → **a named human approves it** →
collect real post-intervention data → **compute the verdict arithmetically** → write
the lesson to memory.

---

## The honesty rules (what it refuses to do)

These are enforced in code and covered by tests:

| Rule | Where it lives |
|---|---|
| Never claim a root cause without evidence | `assertMultiHypothesis()`, `guardNarrative()` |
| Never report certainty — confidence ≤ 0.95 | `sufficiency.ts`, `MAX_CONFIDENCE` |
| Never fabricate a verdict from thin samples | `judge()` → `INCONCLUSIVE` |
| Never treat a small change as a win | `VERDICT_THRESHOLDS.noiseBandPct` (±8%) |
| Never approve an intervention anonymously | `reviewIntervention()`, `/api/approve` |
| Never execute an arbitrary command | `ALLOWED_ACTIONS` — checklists only |
| Never write memory unless a verdict was `SUPPORTED` | `runVerification()` |
| Never invent a post-intervention window | `measure()` — `declared`/`contiguous` modes |

The verdict is decided by arithmetic, not by a model:

```
SUPPORTED     improvement ≥ 20%
WEAKENED      improvement 8–20%   (real, but below the bar)
INCONCLUSIVE  |change| < 8%       (inside the noise band)
              or too few samples
REJECTED      regression ≥ 20%
```

---

## Quick start

```bash
npm install
npm test              # 36 tests, unit + integration
npm run demo:fast     # the whole loop, end to end, in one command
npm start             # dashboard at http://127.0.0.1:4317
```

`npm run demo:fast` boots the API on a scratch data root, drives a session through
`WAIT → diagnose → approve → verify → learn`, and prints a pass/fail for every claim
made above. It requires no API keys.

To watch the dashboard update live:

```bash
WAIT_TIME_SCALE=0.05 npm start
# → http://127.0.0.1:4317
```

Then click **载入会话 Load** with `sparse` selected to watch a real countdown, or
`baseline` to see the hypothesis panel.

---

## Data flow

Dependencies point in **one direction only**. `collector/` never imports an LLM, and
nothing outside `reasoning/` touches the state machine.

```
                 ┌──────────────────────── shared/ ────────────────────────┐
                 │  schemas/  (frozen contract)   utils/window.ts           │
                 └────────────────────────────┬────────────────────────────┘
                                              │ everything imports this
        ┌──────────────────┬──────────────────┼──────────────────┬─────────────────┐
        ▼                  ▼                  ▼                  ▼                 ▼
  ┌───────────┐    ┌─────────────┐    ┌─────────────┐    ┌──────────────┐   ┌──────────┐
  │ collector │───▶│  behavior   │───▶│  reasoning  │───▶│ intervention │──▶│frontend  │
  │  ingest   │    │  segment /  │    │ sufficiency │    │ verification │   │dashboard │
  │           │    │  classify / │    │ state-mach. │    │  planner /   │   │          │
  │           │    │  metrics    │    │ scheduler   │    │  executor    │   │          │
  └───────────┘    └─────────────┘    └──────┬──────┘    └──────┬───────┘   └──────────┘
                                              │                  │
                                              ▼                  ▼
                                       ┌─────────────────────────────┐
                                       │  database/  (JSONL + JSON)  │
                                       └─────────────────────────────┘
```

**`shared/utils/window.ts` is the only place window arithmetic happens.** If
`behavior/` and `verification/` each had their own, before/after numbers would stop
being comparable — and the comparison would be quietly meaningless.

### Raw events are immutable

Append-only JSONL. An event is never updated or deleted. Every claim the system makes
carries the `eventId`s that justify it, so any conclusion can be traced back to the
raw observation.

---

## The state machine

```
                  EVENTS_APPENDED (below floor)
                            │
                            ▼
  OBSERVING ──── EVALUATED ────▶ INSUFFICIENT ──┐
      │                          │              │
      │                  INSUFFICIENT           │
      │                          ▼              │
      │                       WAITING ◀─────────┘
      │                          │
      │              WAIT_ELAPSED / WAIT_EXPIRED / new events
      │                          ▼
      │                   RE_EVALUATING
      │                          │
      │                    SUFFICIENT
      │                          ▼
      │                       READY ──▶ DIAGNOSING ──▶ INTERVENING
      │                          ▲                            │
      │                          │              INTERVENTION_APPROVED
      │                          │                            ▼
      │                          │                        VERIFYING
      │                          │                            │
      │              VERIFICATION_COMPLETE (not SUPPORTED)     │
      │                          │                            │
      │                          └────────────────────────────┤
      │                                                       │ SUPPORTED
      │                                                       ▼
      └──────────────── RESET (human-only) ────────────────  LEARNED
```

`transition(state, event)` is a **pure function** — no IO, no clock, no randomness.
The transition table is data, not nested `if`s, so it can be enumerated and tested.
`LEARNED` is terminal except for `RESET`, which is available from every phase as a
human escape hatch.

The machine's limits are part of the contract (`STATE_MACHINE_LIMITS`), so the
frontend and the tests reason about the same numbers.

---

## Repository layout

```
shared/          the frozen contract — zero runtime dependencies
  schemas/       event, behavior, hypothesis, task-state, intervention, verification
  utils/         window.ts (the ONLY window math), ids.ts
  types/         cross-module DTOs for the API

collector/       raw events in; nothing else
  src/ingest.ts  validate + dedupe, fail-open on volume
  src/adapters/  synthetic.ts — the demo fixtures

behavior/        events → segments → metrics
  engine.ts      classify, segment, computeMetrics, compress

reasoning/       the technical heart — decides WHAT and WHEN
  state-machine.ts  pure transition table
  sufficiency.ts    the five weighted gates
  analyzer.ts       pattern detection
  hypotheses.ts     competing-hypothesis generation
  scheduler.ts      timers + WAIT persistence
  engine.ts         the evaluation cycle
  provider.ts       optional LLM narration (never decides anything)

intervention/    what to do about it
  planner.ts     recipes keyed by hypothesis
  executor.ts    approval gate + whitelisted actions

verification/    did it actually work?
  verifier.ts    measure() + judge() — arithmetic only

database/        append-only JSONL events, JSON state
service.ts       orchestration — the only module that wires things together
server.ts        node:http API + static dashboard
frontend/        index.html — single page, no build step
scripts/         demo.ts, run-demo.ts, check-ui-contract.ts
tests/           unit/ (state machine, scheduler) + integration/ (closed loop)
```

---

## API

```
GET  /api/health
GET  /api/sessions                       list tracked sessions
GET  /api/sessions/:id                   full dashboard snapshot
GET  /api/sessions/:id/events            raw immutable events
POST /api/events                         ingest { sessionId, events[], batchId }

POST /api/demo/load                      { profile: baseline|improved|sparse }
POST /api/demo/fast-forward              expire WAIT timers now

POST /api/sessions/:id/task              { goal, successCriteria[] }
POST /api/sessions/:id/evaluate          run the sufficiency cycle
POST /api/sessions/:id/intervention      propose (requires READY/DIAGNOSING)
POST /api/sessions/:id/approve           { by, decision }   // `by` must name a human
POST /api/sessions/:id/verify            compute the verdict
GET  /api/memory                         learned lessons
```

---

## The demo fixtures

| profile | shape | purpose |
|---|---|---|
| `baseline` | 21 switches / 30 min | the problem case → READY → 4 hypotheses |
| `improved` | 8 switches / 30 min | the post-intervention case → SUPPORTED |
| `sparse` | 3 minutes, 8 events | **triggers a genuine WAIT** |

`WAIT_TIME_SCALE` multiplies wait durations so a demo doesn't stall for 30 minutes.
It changes the *delay*, never the deadline semantics — the persisted `waitUntil` is
always the real one.

---

## Design decisions worth calling out

**Why JSONL and not a database.** A hackathon MVP needs to be inspectable. You can
`cat` the event log and see exactly what the system saw. Swapping in SQLite later only
touches `database/store.ts`.

**Why the contract is frozen first.** `shared/schemas/` was written and validated
before any module existed. Every later bug that mattered was a *contract* bug —
hence the validation layer, and hence `scripts/check-ui-contract.ts`.

**Why a pure state machine.** The interesting question ("should we wait?") is
decidable without a clock or a model. Keeping IO out of `transition()` is what makes
the WAIT guarantee testable rather than aspirational.

**Why the LLM is optional and boxed in.** `reasoning/provider.ts` can phrase a
narrative, but `guardNarrative()` rejects causal claims ("the root cause is",
"proves that"), and the verdict never consults it. The product runs fully with **zero
API keys**.

---

## Testing

```bash
npm test          # 36 tests
npm run test:unit # state machine purity, WAIT recovery, deadline arithmetic
npm run demo:fast # 37 end-to-end checks through the real HTTP API
npm run check:ui  # every field the dashboard reads exists in the payload
```

Notable cases:

- **`transition()` is pure** — the same input twice yields the same output, and the
  input state is not mutated.
- **`RESET` is legal from every phase** — verified by enumeration, not by hand.
- **Overdue WAIT fires on boot** — a deadline in the past must wake, not be lost.
- **A stray late event cannot fabricate an improvement** — the post window is
  anchored to the baseline close, never to the last event on disk.
- **`INCONCLUSIVE` never writes memory** — only a `SUPPORTED` verdict does.
- **Anonymous approval is rejected** — including a whitespace-only name.

---

## Honest limitations

- **The collection layer is synthetic.** `collector/src/adapters/synthetic.ts`
  generates realistic browsing sessions. A real browser extension is not included;
  the ingest contract is stable and ready for one.
- **Single-user, local-only.** No auth, no multi-tenancy. The API binds to
  `127.0.0.1`.
- **The intervention executor renders checklists.** It deliberately cannot run
  commands, so there is nothing to sandbox — and nothing it can break.
- **`INCONCLUSIVE` is common.** With fixture-sized samples the noise band is often
  wider than the effect. That is the honest outcome, not a bug.
- **No cross-session learning yet.** Memory records what worked *for this session*;
  applying it to the next one is the obvious next step.

---

## License

MIT
