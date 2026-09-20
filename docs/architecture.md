# Architecture — Behavior Debugger

## Design goal

A 1–3 person team needs to demo a coherent product in days. That constrains the
architecture hard:

1. **No build step.** The frontend is one HTML file with vanilla JS. `tsx` runs
   TypeScript directly. Nothing to configure, nothing to break.
2. **Zero runtime dependencies.** `shared/` ships a hand-rolled validator instead of
   pulling in a schema library. `npm install` cannot break the demo.
3. **Every claim must be demonstrable.** If the README says "WAIT survives a restart",
   there must be a test that kills the process and proves it.

## Dependency direction

The single most important rule: **dependencies flow one way, and `shared/` is the
bottom.**

```
shared/  ←  collector/  ←  behavior/  ←  reasoning/  ←  intervention/  ←  verification/
   ▲                                                                          │
   └────────────────────────  every module  ──────────────────────────────────┘
                                    │
                              service.ts (the only orchestrator)
                                    │
                                server.ts → frontend/
```

Why it matters:

- **`collector/` never imports `reasoning/`.** Collection must keep working if the
  reasoning layer is swapped out. A collector that knows about the LLM will
  eventually grow opinionated about what to collect.
- **`behavior/` never imports `reasoning/`.** Turning events into segments is a
  deterministic transform. It must be testable without a state machine.
- **Only `service.ts` wires modules together.** If module A needs module B, the
  wiring lives in `service.ts`, not inside A. This is what makes the modules
  independently testable — and what makes parallel development possible.

## Data contracts

`shared/schemas/` was written and frozen **before any other module existed.**

| Contract | Key invariant |
|---|---|
| `event.ts` | `RawEvent` is immutable; append-only JSONL, never updated |
| `behavior.ts` | Every `BehaviorSegment` cites `eventIds` — no unsourced claims |
| `hypothesis.ts` | `contradictingEvidence` and `missingEvidence` are **required**, may be empty, may never be absent |
| `task-state.ts` | `WAITING` **requires** `waitUntil`; `WAIT` reports **require** `missingInformation` + `nextObservation` |
| `intervention.ts` | An `Intervention` must reference an existing `hypothesisId`; approval needs a non-empty human identifier |
| `verification.ts` | A verdict is `SUPPORTED \| WEAKENED \| REJECTED \| INCONCLUSIVE` — four outcomes, not two |

`shared/schemas/validate.ts` enforces these at runtime. A contract violated in a way
TypeScript cannot see (a `WAIT` with no missing information) throws a `SchemaError`
with a path into the offending structure.

## The one place window math happens

`shared/utils/window.ts`. Integration risk R7 is stated plainly in the file header:
if `behavior/` and `verification/` each compute windows independently, before/after
numbers stop being comparable — and the comparison becomes quietly meaningless.

Every module imports `minutesBetween`, `addMinutes`, `trailingWindow`, `eventsInWindow`
from there. No exceptions.

## The reasoning core

### Pure transitions

`reasoning/state-machine.ts` exports `transition(state, event): TaskState` — no IO, no
clock. The transition table is **data**:

```ts
{ from: "VERIFYING", on: "VERIFICATION_COMPLETE", to: "LEARNED", guard: "result === SUPPORTED" }
```

Data is enumerable. `tests/unit/state-machine.test.ts` iterates every phase and
asserts `RESET` is legal from all of them — a test that would be tedious to write
against nested `if`s, and easy to get wrong.

### IO lives in the scheduler

`reasoning/scheduler.ts` owns every timer. The separation is what makes the WAIT
guarantee testable:

```ts
recoverPendingWaits(now)   // scan disk, re-arm or fire
arm(state, now)            // schedule one timer, idempotent per session
```

`applyEvent()` persists state **before** writing the timeline entry, so a crash
cannot leave the two out of sync.

### The evaluation cycle

`reasoning/engine.ts` — `evaluateSession()`:

1. Load events and compute the behavior representation
2. Evaluate the five sufficiency gates
3. If not ready → transition to `WAITING` with a report and a deadline
4. If ready → transition through `READY` to `DIAGNOSING`, generate competing hypotheses

The subtle case: a session below the event floor must **still WAIT, not sit in
`OBSERVING`** — otherwise no timer is armed and it is silently stuck forever. The
guard is `belowEventFloor && report.status !== "WAIT"`.

## Verification

`verification/verifier.ts` has two hard problems.

**Which window is "after"?** Two modes:

- `contiguous` — post is the trailing N minutes, pre is the N minutes before it.
  Correct when observation is continuous.
- `declared` — use the recorded windows. Correct when the two observations are
  separated in time.

`measure()` picks automatically when the recorded windows are disjoint.

The trap: in `declared` mode, anchoring the post window to the **last event on disk**
lets a single stray event (an approval audit trail written hours later) define "now".
The resulting window holds a handful of events bunched into milliseconds and reports a
~99% improvement that never happened. The fix: the boundary is the **close of the
baseline window**, and when no post-baseline observation exists at all, fall back to a
contiguous split pinned to the recorded baseline — which correctly reports
`INCONCLUSIVE`.

**What does the verdict mean?** `judge()` is arithmetic and has no LLM path:

```
|Δ| <  8%             → INCONCLUSIVE   (inside the noise band)
 Δ  ≥ 20%             → SUPPORTED
 8% ≤ Δ < 20%         → WEAKENED       (real, but below the bar)
 Δ  ≤ −20%            → REJECTED
 few samples          → INCONCLUSIVE   (checked first, short-circuits)
```

`INCONCLUSIVE` is a **first-class outcome**, not an error. With fixture-sized samples
it is the most common verdict — which is the point.

## Persistence

`database/store.ts` — JSONL for events (append-only, `cat`-able), JSON for state.

Idempotency is on `eventId` **and** `batchId`, so replaying a batch is safe. This
matters more than it looks: the fixtures namespace event IDs by session and start
instant, because a collision causes the (correct) dedupe to silently drop an entire
batch.

`BEHAVIOR_DEBUGGER_HOME` relocates the whole data root — which is how the tests get
isolation without a database.

## Integration risks and how they're handled

| Risk | Mitigation |
|---|---|
| R1 Two modules compute time differently | `shared/utils/window.ts` is the only place |
| R2 A claim with no traceable evidence | `eventIds` required on segments and evidence; validators enforce |
| R3 WAIT becomes a sentence, not a state | `waitUntil` required by schema; `recoverPendingWaits()` tested |
| R4 The verdict gets "improved" by an LLM | `judge()` is pure arithmetic; `guardNarrative()` blocks causal claims |
| R5 Intervention executes something dangerous | `ALLOWED_ACTIONS` whitelist; executor throws without approval |
| R6 A renamed field blanks a UI panel | `scripts/check-ui-contract.ts` asserts every field the dashboard reads |
| R7 Windows drift between modules | see R1 |
| R8 Session state leaks across sessions | `tests/integration` has an explicit isolation test |
