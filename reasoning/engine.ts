/**
 * The reasoning driver — wires collector data + behavior + sufficiency + the
 * state machine into the closed loop.
 *
 * This is the only module allowed to talk to all the others, and it still goes
 * through `shared/` types. Every step writes state before returning, so the
 * caller can crash at any point and the next run resumes correctly.
 */

import type { RawEvent } from "../shared/schemas/event.js";
import type { BehaviorRepresentation } from "../shared/schemas/behavior.js";
import type { HypothesisSet } from "../shared/schemas/hypothesis.js";
import type { SufficiencyReport, TaskState } from "../shared/schemas/task-state.js";
import { STATE_MACHINE_LIMITS } from "../shared/schemas/task-state.js";
import { assertMultiHypothesis } from "../shared/schemas/hypothesis.js";
import { validateBehaviorRepresentation, validateSufficiencyReport, validateTaskState } from "../shared/schemas/validate.js";
import type { EvaluateResult } from "../shared/types/api.js";
import {
  loadBehavior,
  loadHypothesisSet,
  loadTaskState,
  readEventsForSession,
  saveBehavior,
  saveHypothesisSet,
  saveTaskState,
} from "../database/store.js";
import { buildBehaviorRepresentation } from "../behavior/engine.js";
import { analyzePatterns, summarizePatterns, type PatternFinding } from "./analyzer.js";
import { generateHypotheses, describeSet, reviseAfterFailure } from "./hypotheses.js";
import { DEFAULT_THRESHOLDS, evaluateSufficiency, type SufficiencyThresholds } from "./sufficiency.js";
import { applyEvent, initialState, tryApplyEvent } from "./state-machine-port.js";

export interface EvaluateOptions {
  thresholds?: SufficiencyThresholds;
  /** Override "now" — the demo and tests need determinism. */
  now?: string;
}

export interface EvaluateOutcome extends EvaluateResult {
  findings: PatternFinding[];
  /** True when this call produced a fresh hypothesis set. */
  diagnosed: boolean;
  /** True when this call passed through READY (even if it advanced onward). */
  reachedReady: boolean;
  /** Human-readable headline for the UI. */
  headline: string;
  /** True when the machine is parked and a scheduler timer should be armed. */
  waiting: boolean;
}

/** Get-or-create the task state for a session. */
export function ensureState(sessionId: string, now = new Date().toISOString()): TaskState {
  const existing = loadTaskState(sessionId);
  if (existing) return existing;
  const fresh = initialState(sessionId, `task_${sessionId}`, now);
  saveTaskState(fresh);
  return fresh;
}

/**
 * The core evaluation cycle. Idempotent: calling it twice on the same evidence
 * produces the same phase (modulo WAIT timing), so a retried HTTP request is
 * harmless.
 */
export function evaluateSession(sessionId: string, opts: EvaluateOptions = {}): EvaluateOutcome {
  const now = opts.now ?? new Date().toISOString();
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  let state = ensureState(sessionId, now);
  const events: RawEvent[] = readEventsForSession(sessionId);

  // 1. Behavior representation — always recomputed, it is cheap and must never
  //    lag the evidence.
  const behavior: BehaviorRepresentation = buildBehaviorRepresentation(events, {
    taskId: state.taskId,
  });
  validateBehaviorRepresentation(behavior);
  saveBehavior(behavior);

  // 2. Pattern analysis — arithmetic over the representation, no LLM.
  const findings = analyzePatterns(behavior, { minSwitchRate: thresholds.highSwitchRatePerMin });

  // 3. Sufficiency gate — the Deferred Intelligence decision.
  const report: SufficiencyReport = evaluateSufficiency(
    { sessionId, events, behavior, cycle: state.reEvalCount, at: now },
    thresholds
  );
  validateSufficiencyReport(report);

  // 4. Push the machine.
  //
  //    Staying in OBSERVING is only valid when there is nothing meaningful to
  //    wait for yet — i.e. we are below the event floor AND the judge has not
  //    produced a WAIT verdict. As soon as the judge says WAIT, we must enter
  //    the real WAIT machinery, because OBSERVING has no deadline and so no
  //    scheduler timer would ever be armed: the session would sit forever.
  //    (This is exactly the failure mode the "thin evidence → WAITING" test
  //    exists to catch.)
  const belowEventFloor = events.length < STATE_MACHINE_LIMITS.minEventsBeforeEvaluate;
  if (state.phase === "OBSERVING" && belowEventFloor && report.status !== "WAIT") {
    state = applyEvent(state, { type: "EVENTS_APPENDED", count: events.length, at: now });
    state = { ...state, phase: "OBSERVING", sufficiency: report, note: `${events.length} event(s) so far` };
    saveTaskState(state);
    return {
      state: validateTaskState(state),
      sufficiency: report,
      behavior,
      hypothesisSet: null,
      findings,
      diagnosed: false,
      reachedReady: false,
      waiting: false,
      headline: `Observing — ${events.length}/${STATE_MACHINE_LIMITS.minEventsBeforeEvaluate} events before the first sufficiency check.`,
    };
  }

  const suitable: "SUFFICIENT" | "INSUFFICIENT" = report.status === "READY" ? "SUFFICIENT" : "INSUFFICIENT";

  if (state.phase === "OBSERVING" || state.phase === "INSUFFICIENT" || state.phase === "RE_EVALUATING") {
    if (state.phase === "OBSERVING") {
      state = applyEvent(state, { type: "EVALUATED", at: now });
    }
    const r = tryApplyEvent(state, { type: suitable, at: now, report } as never);
    if (!r.applied) {
      // Already in a terminal-ish phase for this cycle; record the fresh report.
      state = { ...state, sufficiency: report, updatedAt: now };
      saveTaskState(state);
    } else {
      state = r.state;
    }
  } else {
    // Parked in a later phase (READY/DIAGNOSING/...): keep the report current.
    state = { ...state, sufficiency: report, updatedAt: now };
    saveTaskState(state);
  }

  // 5. Diagnosis happens only in READY.
  //
  //    Design choice: this call also emits the hypotheses AND advances to
  //    DIAGNOSING. That means a caller who evaluates a fresh, evidence-rich
  //    session observes phase === "DIAGNOSING" rather than "READY" — READY was
  //    a real intermediate state, it was just traversed within this call.
  //    `reachedReady` reports that honestly so the UI can show "READY →
  //    DIAGNOSING happened", and `diagnosed` says whether this call did it.
  let hypothesisSet = loadHypothesisSet(sessionId);
  let diagnosed = false;
  const reachedReady = state.phase === "READY";
  if (reachedReady && (!hypothesisSet || hypothesisSet.revision === 0)) {
    const set = generateHypotheses({
      sessionId,
      findings,
      metrics: {
        switchCount: behavior.metrics.switchCount,
        switchRatePerMin: behavior.metrics.switchRatePerMin,
        returnRate: behavior.metrics.returnRate,
        uniqueSources: behavior.metrics.uniqueSources,
        longestFocusMs: behavior.metrics.longestFocusMs,
      },
      windowMinutes: behavior.windowMinutes,
      revision: 0,
    });
    assertMultiHypothesis(set, 2);
    saveHypothesisSet(set);
    hypothesisSet = set;
    const diag = tryApplyEvent(state, {
      type: "DIAGNOSED",
      at: now,
      hypothesisIds: set.hypotheses.map((h) => h.hypothesisId),
    });
    if (diag.applied) state = diag.state;
    diagnosed = true;
  }

  const headline = diagnosed && hypothesisSet
    ? describeSet(hypothesisSet)
    : report.status === "READY"
      ? (report.reason ?? "Evidence sufficient.")
      : `Waiting — ${report.missingInformation[0] ?? "more evidence needed"}`;

  return {
    state: validateTaskState(state),
    sufficiency: report,
    behavior,
    hypothesisSet: hypothesisSet ?? null,
    findings,
    diagnosed,
    reachedReady,
    waiting: state.phase === "WAITING",
    headline,
  };
}

/**
 * Called when new events arrive. Decides between a cheap counter bump (when
 * parked) and a full re-evaluation, so a burst of events outside a WAIT does
 * not trigger expensive work on every POST.
 */
export function onNewEvents(sessionId: string, count: number, now = new Date().toISOString()): EvaluateOutcome {
  const state = ensureState(sessionId, now);
  if (state.phase === "WAITING") {
    if (count >= STATE_MACHINE_LIMITS.earlyWakeEventThreshold) {
      const woken = applyEvent(state, { type: "EVENTS_APPENDED", count, at: now });
      void woken;
      return evaluateSession(sessionId, { now });
    }
    // Stay parked: keep the wait timer authoritative. Record nothing new.
    return {
      state,
      sufficiency: state.sufficiency ?? {
        sessionId,
        status: "WAIT",
        confidence: 0,
        missingInformation: ["Awaiting enough new evidence to justify re-evaluation"],
        nextObservation: { action: "Continue observing", durationMinutes: 30, targetMetrics: ["eventCount"] },
        evaluatedAt: now,
        cycle: state.reEvalCount,
      },
      behavior: loadBehavior(sessionId) ?? buildBehaviorRepresentation([], {}),
      hypothesisSet: loadHypothesisSet(sessionId),
      findings: [],
      diagnosed: false,
      reachedReady: false,
      waiting: true,
      headline: "Still waiting for more evidence.",
    };
  }
  return evaluateSession(sessionId, { now });
}

/** Re-run diagnosis after a failed verification. */
export function reDiagnose(sessionId: string, failedHypothesisId: string, deltaPct: number, now = new Date().toISOString()): EvaluateOutcome {
  const behavior = loadBehavior(sessionId) ?? buildBehaviorRepresentation(readEventsForSession(sessionId), {});
  const findings = analyzePatterns(behavior);
  const existing = loadHypothesisSet(sessionId);
  const set: HypothesisSet = existing
    ? reviseAfterFailure(existing, failedHypothesisId, deltaPct)
    : generateHypotheses({
        sessionId,
        findings,
        metrics: behavior.metrics,
        windowMinutes: behavior.windowMinutes,
        revision: 1,
      });
  saveHypothesisSet(set);
  return evaluateSession(sessionId, { now });
}

export { summarizePatterns, describeSet };
