# The Deferred Intelligence state machine

## Why a state machine, and not a prompt

The product's central claim is: *"if the evidence isn't good enough, wait."*

If that decision lives in a prompt, it is not testable, not persistent, and not
enforceable. A model that says "I need more information" and then forgets is
indistinguishable from one that never said it.

So the decision is a **pure function over a finite set of phases**, and `WAITING` is a
**persisted state with an absolute deadline**. The guarantees that follow are the whole
point:

- A process restart re-arms the wait. (`recoverPendingWaits()`)
- An overdue deadline fires immediately. (tested)
- A `WAIT` without a deadline is a **schema violation**, not a style issue.
- `transition()` is side-effect free, so the machine is provable by enumeration.

## The nine phases

```
OBSERVING       collecting raw events; below the floor for evaluation
INSUFFICIENT    evaluated, evidence not good enough — not yet parked
WAITING         ★ parked with `waitUntil`; a timer is armed
RE_EVALUATING   woke up (deadline, new events, or manual) and is re-checking
READY           evidence sufficient; may diagnose
DIAGNOSING      hypotheses generated
INTERVENING     an intervention is proposed and awaiting human approval
VERIFYING       approved; a post-intervention window is being collected
LEARNED         verdict was SUPPORTED; terminal
```

`LEARNED` is terminal except for `RESET`, which is legal from **every** phase as a
human escape hatch. That is asserted by enumerating all nine phases, not by hand.

## Legal transitions

| from | event | to | guard |
|---|---|---|---|
| `OBSERVING` | `EVENTS_APPENDED` | `OBSERVING` | below the event floor |
| `OBSERVING` | `EVALUATED` | `RE_EVALUATING` | at or above the floor |
| `INSUFFICIENT` | `INSUFFICIENT` | `WAITING` | report carries a deadline |
| `WAITING` | `WAIT_ELAPSED` / `WAIT_EXPIRED` | `RE_EVALUATING` | — |
| `WAITING` | `EVENTS_APPENDED` | `RE_EVALUATING` | event count ≥ early-wake threshold |
| `RE_EVALUATING` | `SUFFICIENT` | `READY` | report status is `READY` |
| `RE_EVALUATING` | `INSUFFICIENT` | `WAITING` | re-eval cycles below the cap |
| `RE_EVALUATING` | `MAX_CYCLES_REACHED` | `READY` | degraded, low-confidence |
| `READY` | `DIAGNOSED` | `DIAGNOSING` | ≥ 2 hypotheses |
| `DIAGNOSING` | `INTERVENTION_PROPOSED` | `INTERVENING` | references a live hypothesis |
| `INTERVENING` | `INTERVENTION_APPROVED` | `VERIFYING` | named human |
| `INTERVENING` | `INTERVENTION_REJECTED` | `DIAGNOSING` | — |
| `VERIFYING` | `VERIFICATION_COMPLETE` | `LEARNED` | `result === SUPPORTED` |
| `VERIFYING` | `VERIFICATION_COMPLETE` | `RE_EVALUATING` | any other result |
| _any_ | `RESET` | `OBSERVING` | human-only escape hatch |

Illegal transitions throw `IllegalTransitionError` with the phase, event, and the list
of events that *were* legal from that phase — a debugging affordance, not just a
rejection.

## The sufficiency gates

`evaluateSufficiency()` computes five weighted scores. Nothing here consults a model.

| gate | weight | threshold | what it rules out |
|---|---|---|---|
| `minEvents` | 0.25 | ≥ 12 | drawing conclusions from a handful of actions |
| `minObservationMinutes` | 0.25 | ≥ 5 min | a burst that isn't a pattern |
| `minDistinctKinds` | 0.20 | ≥ 3 kinds | not enough variety to compare |
| `minStableSubwindows` | 0.20 | ≥ 2 of 3 | a one-off rather than a pattern |
| `baseline` | 0.10 | ≥ 2 switches | nothing measurable to compare against |

Confidence is the weighted sum, **capped at 0.95**:

```ts
const confidence = Math.round(Math.min(0.95, rawConfidence) * 1000) / 1000;
```

The cap is deliberate. Every gate passing means *"enough to act on"*, not *"proven"*.
A UI showing 100% invites false trust.

`minStableSubwindows` deserves a note: it splits the observation span into three equal
parts and counts how many show **both movement and variety**. A pattern appearing in
only one sub-window is a fluke. This is the gate that most often keeps a session in
`WAITING` — and the most valuable one.

## The wait plan

A `WAIT` report **must** carry:

```ts
{
  status: "WAIT",
  missingInformation: [...],          // non-empty — schema-enforced
  nextObservation: {
    action: "Continue observing...",  // REQUIRED
    durationMinutes: 17,              // REQUIRED, > 0 — schema-enforced
    targetMetrics: ["eventCount"],
  }
}
```

`validateSufficiencyReport()` **rejects** a `WAIT` missing either field. The duration
comes from the largest shortfall (`proposeWaitMinutes()`), clamped to 5–45 minutes so a
demo doesn't stall for an hour. It is derived, never a magic constant.

## Timers and recovery

`reasoning/scheduler.ts` owns all IO. Splitting it from the pure machine is what makes
the WAIT guarantee testable.

```ts
arm(state, now)                // idempotent per session; cancels any prior timer
cancel(sessionId)
recoverPendingWaits(now)       // ★ the restart guarantee
```

`recoverPendingWaits()` scans disk for every session in `WAITING` and either re-arms it
or — if the deadline already passed — fires the wake callback immediately. A deadline
that elapsed while the process was down must not be lost.

Ordering in `applyEvent()` matters: **state is persisted before the timeline entry**.
A crash between the two leaves a recoverable state, never a state change that happened
but was not recorded.

`WAIT_TIME_SCALE` multiplies the *delay* for demos. The persisted `waitUntil` is always
real, so scaling cannot change what the system believes.

## Verified properties

From `tests/unit/state-machine.test.ts` and `tests/unit/scheduler.test.ts`:

- `transition()` is pure — same input twice, same output; input not mutated
- `RESET` is legal from all nine phases (by enumeration)
- Illegal transitions throw, and the error lists the legal alternatives
- `maxReEvalCycles` bounds the loop; exceeding it degrades to `READY`
- `waitUntil` is derived from the report's `durationMinutes`
- A future deadline re-arms; a past deadline wakes at boot
- Cancelling a timer prevents the wake
- Arming three times yields exactly one timer and one wake
- A session past `WAITING` is not woken again
