# Data schemas — Behavior Debugger

All contracts live in `shared/schemas/`. They were frozen **before** any consuming
module existed, because every expensive bug in this project traced back to a contract
ambiguity rather than a logic error.

Runtime enforcement is in `shared/schemas/validate.ts`. A contract violated in a way
TypeScript cannot express — a `WAIT` with no missing information, a `WAITING` state
with no deadline — throws a `SchemaError` carrying a path into the structure.

---

## `event.ts` — the raw observation

```ts
interface RawEvent {
  eventId: string;           // unique; dedupe key
  sessionId: string;
  timestamp: string;         // ISO 8601, the time it HAPPENED
  eventType: EventType;      // one of 10
  source?: string;           // where the user came from
  target?: string;           // where they went
  url?: string;
  dwellMs?: number;
  payload?: Record<string, unknown>;
}
```

**Immutability is the contract.** Events are written once to append-only JSONL and
never updated or deleted. Everything downstream is a derivation, so any claim can be
traced back to the raw observation via `eventId`.

Event types: `page_visit`, `page_switch`, `search`, `edit`, `idle_start`, `idle_end`,
`task_declared`, `task_completed`, `note_added`, `intervention_applied`.

`BEHAVIORAL_EVENTS` excludes the bookkeeping types, because counting
`task_declared` as evidence of *behavior* would inflate the sample.

---

## `behavior.ts` — what the events look like

```ts
interface BehaviorSegment {
  segmentId: string;
  sessionId: string;
  kind: BehaviorKind;        // 7 kinds
  startTs: string;
  endTs: string;
  durationMs: number;
  eventIds: string[];        // ★ REQUIRED, non-empty — the evidence link
  confidence: number;        // 0..1
}

interface BehaviorMetrics {
  totalDwellMs: number;
  switchCount: number;          // ★ primary intervention target
  switchRatePerMin: number;     // ★ primary comparison metric
  uniqueSources: number;
  avgDwellMs: number;
  returnRate: number;           // fraction of visits returning to a known source
  longestFocusMs: number;
}
```

`switchRatePerMin` is the metric everything else is organised around: it is
length-normalised, so a shorter window cannot look like an improvement merely by
containing fewer switches.

Kinds: `development`, `docs_search`, `ai_assistance`, `context_switch`, `idle`,
`communication`, `unknown`.

**Classification note.** `page_switch` is classified by its **destination** kind, not
as a generic `context_switch`. Classifying every switch as `context_switch` destroys
all segment structure — every segment collapses to one kind and pattern detection has
nothing to find. `switchCount` is already computed arithmetically in `computeMetrics()`,
so the segments don't need to duplicate it.

---

## `hypothesis.ts` — the competing explanations

```ts
interface Hypothesis {
  hypothesisId: string;
  statement: string;                    // "Documentation Fragmentation"
  rationale?: string;
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];    // ★ REQUIRED — may be [], never absent
  confidence: number;                   // ★ capped at 0.95
  missingEvidence: string[];            // ★ REQUIRED — non-empty drives WAITING
  state: HypothesisState;
}

interface Evidence {
  evidenceId: string;
  kind: "supporting" | "contradicting";
  statement: string;        // human-readable claim
  metric?: string;          // "switchRatePerMin"
  value?: number;
  eventIds: string[];       // ★ MUST be non-empty
  weight: number;           // 0..1
}
```

The two required arrays are the design. `contradictingEvidence` **must** exist even
when empty — the difference between "I found no counter-evidence" and "I didn't look
for any" must be visible in the data. `missingEvidence` is what feeds the next wait
cycle.

```ts
export const MAX_CONFIDENCE = 0.95;

export function assertMultiHypothesis(set: HypothesisSet): void {
  // throws unless set.hypotheses.length >= 2
}
```

`assertMultiHypothesis()` is called on every generated set. Committing to a single
root cause is the failure mode this project exists to avoid.

---

## `task-state.ts` — the Deferred Intelligence contract

```ts
interface TaskState {
  sessionId: string;
  taskId: string;
  phase: DebuggerPhase;        // one of 9
  enteredAt: string;
  waitUntil?: string;          // ★ ONLY set in WAITING; required there
  reEvalCount: number;
  sufficiency?: SufficiencyReport;
  activeHypothesisIds: string[];
  activeInterventionId?: string;
  activeExperimentId?: string;
  learnedAt?: string;
  note?: string;
  updatedAt: string;
}

interface SufficiencyReport {
  status: "INSUFFICIENT" | "WAIT" | "READY";
  confidence: number;
  missingInformation: string[];    // ★ non-empty when WAIT
  nextObservation?: NextObservation; // ★ required when WAIT
  reason?: string;                 // required when READY
  checks?: SufficiencyCheck[];     // the weighted ladder, for the UI
  evaluatedAt: string;
  cycle: number;
}
```

Two rules enforced by `validateTaskState()` / `validateSufficiencyReport()`:

1. `WAITING` without `waitUntil` → rejected. *WAIT must be actionable.*
2. `WAIT` without `missingInformation` or `nextObservation` → rejected.
   *"I need more info" is not a plan.*

The inverse is also checked: `waitUntil` must be **cleared** outside `WAITING`, so a
stale deadline cannot linger and wake a session that has moved on.

`STATE_MACHINE_LIMITS` lives here rather than in `reasoning/` so the frontend and the
tests reason about the same numbers:

```ts
{ minEventsBeforeEvaluate: 12, minObservationMinutes: 5, maxReEvalCycles: 5,
  defaultWaitMinutes: 30, earlyWakeEventThreshold: 40 }
```

`checks` is the UI's evidence gauge — the five gates with their scores, so the
dashboard can show **why** the system is waiting instead of restating the verdict.

---

## `intervention.ts` — what to do about it

```ts
interface Intervention {
  interventionId: string;
  hypothesisId: string;        // ★ MUST reference a live hypothesis
  kind: InterventionKind;
  title: string;
  description: string;
  steps: InterventionStep[];
  targetMetric: string;        // "switchRatePerMin"
  expectedEffect: string;      // an estimate, explicitly not a promise
  approval: Approval;
}

interface InterventionStep {
  stepId: string;
  instruction: string;
  action: string;              // whitelisted id, or "manual"
}

interface Approval {
  required: true;
  status: "pending" | "approved" | "rejected";
  by?: string;                 // ★ a named human — never "system"
  at?: string;
  note?: string;
}

interface Experiment {
  preWindow: TimeWindow;       // frozen at plan time
  postWindow: TimeWindow;      // starts EMPTY on purpose
  baselineValue: number;       // frozen — never recomputed
  metric: string;
}
```

Three deliberate constraints:

- **`hypothesisId` is required.** An intervention that doesn't address a stated
  hypothesis has no falsifiable claim behind it.
- **`Approval.by` must be a non-empty human identifier.** Whitespace-only is rejected.
  Enforced in `executor.ts` *and* at the HTTP boundary.
- **`postWindow` starts as a zero-length marker at `now`.** Filling it with a guess
  would bake in a wrong assumption. Its emptiness is the signal `measure()` uses to
  detect that the two observation periods are disjoint.

```ts
export const VERDICT_THRESHOLDS = {
  supportedPct: 20,   // improvement must clear this to be SUPPORTED
  rejectedPct: 20,    // regression must clear this to be REJECTED
  noiseBandPct: 8,    // inside this band, the change is not distinguishable
};
```

---

## `verification.ts` — did it work?

```ts
interface Verification {
  experimentId: string;
  hypothesisId: string;
  interventionId: string;
  comparison: MetricComparison;
  result: "SUPPORTED" | "WEAKENED" | "REJECTED" | "INCONCLUSIVE";
  reason: string;              // machine-generated, quotes the numbers
  eventIdsBefore: string[];    // ★ the verdict is auditable
  eventIdsAfter: string[];
}

interface MetricComparison {
  metric: string;
  before: number;
  after: number;
  deltaPct: number;                 // (before - after) / before * 100
  sampleSizeBefore: number;
  sampleSizeAfter: number;
  windowMinutesBefore: number;      // ★ must match, or the comparison is invalid
  windowMinutesAfter: number;
}
```

`eventIdsBefore` / `eventIdsAfter` make the verdict auditable: you can pull the exact
events behind both numbers and re-derive the arithmetic yourself.

**Four outcomes, not two.** A binary verdict forces every middling result into
"worked" or "failed". `WEAKENED` (8–20%) is a real effect below the bar;
`INCONCLUSIVE` (< 8%, or thin samples) is the honest answer when the data can't
distinguish signal from noise.

`judge()` computes `result` arithmetically. An LLM may phrase `reason`; it may never
choose the verdict.

---

## `task.ts` / `types/api.ts` — what the API returns

`SessionDebugView` is the single payload the dashboard polls. It contains only public
DTOs, so the frontend never reaches into module internals:

```ts
interface SessionDebugView {
  sessionId: string;
  task: Task | null;
  state: TaskState;
  behavior: BehaviorRepresentation | null;
  hypothesisSet: HypothesisSet | null;
  sufficiency: SufficiencyReport | null;
  intervention: Intervention | null;
  experiment: Experiment | null;
  verification: Verification | null;
}
```

Every panel in the dashboard is driven by exactly one of these fields being non-null —
which is what makes the demo's reveal sequence work: the panels fill in as the loop
progresses.

---

## Cross-cutting rules

1. **Immutability.** Raw events are append-only. Derivations are recomputable.
2. **Provenance.** Any claim carries `eventId`s. No unsourced assertions.
3. **Explicitness.** Empty is a valid answer; absent is a bug.
4. **Bounded confidence.** Nothing reports 1.0.
5. **One window implementation.** `shared/utils/window.ts`, universally.
6. **Four verdicts.** Not two.

`scripts/check-ui-contract.ts` asserts at runtime that every field the dashboard reads
actually exists in the payload. Without it, a renamed schema field blanks a panel
silently — the frontend has no build step to catch it.
