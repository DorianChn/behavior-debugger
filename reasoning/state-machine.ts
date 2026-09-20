/**
 * The Deferred Intelligence state machine.
 *
 * This file is PURE. No IO, no clock reads, no LLM. Every function takes the
 * current state plus an event and returns a new state. That makes the whole
 * WAIT / RE_EVALUATING loop unit-testable without a running server — which is
 * the only way to prove Principle 4 ("WAIT is a real state, not a sentence").
 *
 * Persistence and timers live in scheduler.ts. This file decides WHAT the next
 * phase is; it never decides WHEN to wake up on its own (that is a clock
 * concern, so `at` always arrives in the event).
 */

import {
  DEBUGGER_PHASES,
  STATE_MACHINE_LIMITS,
  TASK_STATE_SCHEMA_VERSION,
  type DebuggerPhase,
  type PhaseEvent,
  type SufficiencyReport,
  type TaskState,
} from "../shared/schemas/task-state.js";
import { addMinutes } from "../shared/utils/window.js";

/** Phases considered terminal for the demo loop. */
const TERMINAL: DebuggerPhase[] = ["LEARNED"];

export class IllegalTransitionError extends Error {
  constructor(from: DebuggerPhase, event: PhaseEvent["type"]) {
    super(`Illegal transition: cannot apply ${event} while in ${from}`);
    this.name = "IllegalTransitionError";
  }
}

export function initialState(sessionId: string, taskId = "task_001", at = new Date().toISOString()): TaskState {
  return {
    sessionId,
    taskId,
    phase: "OBSERVING",
    enteredAt: at,
    reEvalCount: 0,
    activeHypothesisIds: [],
    updatedAt: at,
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
  };
}

function to(state: TaskState, phase: DebuggerPhase, at: string, patch: Partial<TaskState> = {}): TaskState {
  const next: TaskState = {
    ...state,
    ...patch,
    phase,
    enteredAt: at,
    updatedAt: at,
  };
  // Invariant enforced here so no caller can leak a stale WAITING timer.
  if (phase !== "WAITING") delete next.waitUntil;
  return next;
}

/**
 * The transition table. Kept as data rather than nested ifs so the frontend can
 * render it and reviewers can diff it.
 */
export const TRANSITIONS: ReadonlyArray<{
  from: DebuggerPhase;
  on: PhaseEvent["type"];
  to: DebuggerPhase;
  guard: string;
}> = [
  { from: "OBSERVING", on: "EVENTS_APPENDED", to: "INSUFFICIENT", guard: "count >= minEventsBeforeEvaluate" },
  { from: "OBSERVING", on: "EVALUATED", to: "INSUFFICIENT", guard: "manual evaluate()" },
  { from: "INSUFFICIENT", on: "INSUFFICIENT", to: "WAITING", guard: "missingInformation non-empty" },
  { from: "INSUFFICIENT", on: "SUFFICIENT", to: "READY", guard: "confidence >= threshold" },
  { from: "WAITING", on: "WAIT_ELAPSED", to: "RE_EVALUATING", guard: "now >= waitUntil" },
  { from: "WAITING", on: "WAIT_EXPIRED", to: "RE_EVALUATING", guard: "early wake: new events >= threshold" },
  { from: "WAITING", on: "EVENTS_APPENDED", to: "WAITING", guard: "still below early-wake threshold" },
  { from: "RE_EVALUATING", on: "SUFFICIENT", to: "READY", guard: "confidence >= threshold" },
  { from: "RE_EVALUATING", on: "INSUFFICIENT", to: "WAITING", guard: "reEvalCount < maxReEvalCycles" },
  { from: "RE_EVALUATING", on: "MAX_CYCLES_REACHED", to: "READY", guard: "degraded READY (low confidence)" },
  { from: "READY", on: "DIAGNOSED", to: "DIAGNOSING", guard: "hypothesisIds.length >= 2" },
  { from: "DIAGNOSING", on: "INTERVENTION_PROPOSED", to: "INTERVENING", guard: "intervention references a hypothesis" },
  { from: "DIAGNOSING", on: "INTERVENTION_REJECTED", to: "RE_EVALUATING", guard: "human said no" },
  { from: "INTERVENING", on: "INTERVENTION_APPROVED", to: "VERIFYING", guard: "approval.status === approved" },
  { from: "INTERVENING", on: "INTERVENTION_REJECTED", to: "DIAGNOSING", guard: "human said no" },
  { from: "VERIFYING", on: "VERIFICATION_COMPLETE", to: "LEARNED", guard: "result === SUPPORTED" },
  { from: "VERIFYING", on: "VERIFICATION_COMPLETE", to: "RE_EVALUATING", guard: "result !== SUPPORTED" },
  // RESET is legal from EVERY phase, including LEARNED: an operator must always
  // be able to unstick a session. It is deliberately not reachable by the
  // agent's own tool loop — only the approval-gated HTTP surface calls it.
  ...DEBUGGER_PHASES.map((from) => ({ from, on: "RESET" as const, to: "OBSERVING" as const, guard: "human-only escape hatch" })),
];

export const VALID_EVENTS: Record<DebuggerPhase, readonly PhaseEvent["type"][]> = DEBUGGER_PHASES.reduce(
  (acc, phase) => {
    acc[phase] = [];
    return acc;
  },
  {} as Record<DebuggerPhase, PhaseEvent["type"][]>
) as Record<DebuggerPhase, readonly PhaseEvent["type"][]>;

// Built from the table so the two can never drift apart.
for (const t of TRANSITIONS) {
  const list = (VALID_EVENTS as Record<DebuggerPhase, PhaseEvent["type"][]>)[t.from];
  if (!list.includes(t.on)) list.push(t.on);
}

/**
 * Apply one event. Throws IllegalTransitionError when the event is not legal
 * from the current phase — a crash here is a bug in the caller, and silently
 * ignoring it would hide a stuck WAIT.
 */
export function transition(state: TaskState, event: PhaseEvent): TaskState {
  if (TERMINAL.includes(state.phase) && event.type !== "RESET") {
    throw new IllegalTransitionError(state.phase, event.type);
  }
  const allowed = VALID_EVENTS[state.phase] ?? [];
  if (!allowed.includes(event.type)) throw new IllegalTransitionError(state.phase, event.type);

  switch (event.type) {
    case "RESET":
      return initialState(state.sessionId, state.taskId, event.at);

    case "EVENTS_APPENDED": {
      if (state.phase === "WAITING") {
        // Principle 4 realised: more data can pull the machine out of WAIT early,
        // but only past a real threshold — never on the first stray event.
        if (event.count >= STATE_MACHINE_LIMITS.earlyWakeEventThreshold) {
          return to(state, "RE_EVALUATING", event.at, { note: "early wake: evidence burst" });
        }
        return state;
      }
      return to(state, "INSUFFICIENT", event.at, { note: `${event.count} event(s) appended` });
    }

    case "EVALUATED":
      return to(state, "INSUFFICIENT", event.at);

    case "INSUFFICIENT": {
      const report = event.report;
      const from: DebuggerPhase = state.phase;
      if (from === "RE_EVALUATING") {
        if (state.reEvalCount + 1 >= STATE_MACHINE_LIMITS.maxReEvalCycles) {
          // Degraded READY is produced by the caller via MAX_CYCLES_REACHED;
          // stay in RE_EVALUATING so the caller can decide.
          return to(state, "RE_EVALUATING", event.at, {
            reEvalCount: state.reEvalCount + 1,
            sufficiency: report,
            note: "re-evaluation budget exhausted — degraded diagnosis available",
          });
        }
        return scheduleWait(state, report, event.at, state.reEvalCount + 1);
      }
      return scheduleWait(state, report, event.at, state.reEvalCount);
    }

    case "SUFFICIENT": {
      if (state.phase !== "INSUFFICIENT" && state.phase !== "RE_EVALUATING") {
        throw new IllegalTransitionError(state.phase, event.type);
      }
      return to(state, "READY", event.at, { sufficiency: event.report, note: event.report.reason });
    }

    case "WAIT_ELAPSED":
      return to(state, "RE_EVALUATING", event.at, { note: "wait elapsed" });

    case "WAIT_EXPIRED":
      return to(state, "RE_EVALUATING", event.at, { note: "wait expired (ceiling)" });

    case "MAX_CYCLES_REACHED": {
      const report = state.sufficiency;
      return to(state, "READY", event.at, {
        sufficiency: report
          ? { ...report, status: "READY", reason: "Re-evaluation budget exhausted; emitting low-confidence hypothesis set." }
          : undefined,
        note: "degraded READY",
      });
    }

    case "DIAGNOSED":
      return to(state, "DIAGNOSING", event.at, { activeHypothesisIds: event.hypothesisIds });

    case "INTERVENTION_PROPOSED":
      return to(state, "INTERVENING", event.at, { activeInterventionId: event.interventionId });

    case "INTERVENTION_REJECTED":
      // From DIAGNOSING we go back to re-evaluate; from INTERVENING back to diagnose.
      return to(state, state.phase === "INTERVENING" ? "DIAGNOSING" : "RE_EVALUATING", event.at, {
        activeInterventionId: undefined,
        note: "human rejected the proposed intervention",
      });

    case "INTERVENTION_APPROVED":
      return to(state, "VERIFYING", event.at, { activeExperimentId: event.experimentId });

    case "VERIFICATION_COMPLETE":
      return event.result === "SUPPORTED"
        ? to(state, "LEARNED", event.at, { learnedAt: event.at, note: "hypothesis supported by observed data" })
        : to(state, "RE_EVALUATING", event.at, {
            note: `verification ${event.result} — regenerating hypotheses`,
            activeInterventionId: undefined,
            activeExperimentId: undefined,
          });

    default: {
      const never: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Enter WAITING and stamp a concrete wake time. This is the difference between
 * a real system state and an LLM saying "please tell me more".
 */
function scheduleWait(state: TaskState, report: SufficiencyReport, at: string, reEvalCount: number): TaskState {
  const minutes = report.nextObservation?.durationMinutes ?? STATE_MACHINE_LIMITS.defaultWaitMinutes;
  return to(state, "WAITING", at, {
    waitUntil: addMinutes(at, minutes),
    reEvalCount,
    sufficiency: report,
    note: `waiting ${minutes}m for: ${report.missingInformation.join(", ")}`,
  });
}

/** Convenience wrapper used by the driver: append events, then auto-evaluate. */
export function onEventsAppended(state: TaskState, count: number, at: string): TaskState {
  if (state.phase === "OBSERVING" && count < STATE_MACHINE_LIMITS.minEventsBeforeEvaluate) {
    return { ...state, updatedAt: at };
  }
  return transition(state, { type: "EVENTS_APPENDED", count, at });
}

export function describe(state: TaskState): string {
  if (state.phase === "WAITING") {
    return `WAITING until ${state.waitUntil} — missing: ${(state.sufficiency?.missingInformation ?? []).join(", ")}`;
  }
  return `${state.phase}${state.note ? ` (${state.note})` : ""}`;
}
