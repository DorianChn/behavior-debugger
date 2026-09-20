/**
 * TaskState + SufficiencyReport — the Deferred Intelligence contract.
 *
 * Principle 4 (WAIT Is a Real State): WAITING is a persisted phase with a
 * `waitUntil` timestamp, not an LLM sentence. A process restart must be able
 * to scan for due WAITING rows and resume. Nothing in this file may depend on
 * a language model.
 */

export const TASK_STATE_SCHEMA_VERSION = "1.0" as const;

/**
 * The nine phases. Order is the nominal happy path, but the machine is a
 * graph, not a list: RE_EVALUATING can loop back to WAITING, and FAILED
 * verification loops back to RE_EVALUATING.
 */
export const DEBUGGER_PHASES = [
  "OBSERVING",
  "INSUFFICIENT",
  "WAITING",
  "RE_EVALUATING",
  "READY",
  "DIAGNOSING",
  "INTERVENING",
  "VERIFYING",
  "LEARNED",
] as const;

export type DebuggerPhase = (typeof DEBUGGER_PHASES)[number];

/** The three statuses the sufficiency check can report. */
export const SUFFICIENCY_STATUSES = ["INSUFFICIENT", "WAIT", "READY"] as const;
export type SufficiencyStatus = (typeof SUFFICIENCY_STATUSES)[number];

/** What the scheduler should do when it re-enters the reasoning loop. */
export interface NextObservation {
  /** e.g. "Continue observing" */
  action: string;
  /** How long to wait before re-evaluating, in minutes. */
  durationMinutes: number;
  /** Metrics expected to become measurable, e.g. ["switchRatePerMin"]. */
  targetMetrics: string[];
}

/**
 * One weighted gate in the sufficiency ladder. Exposed on the report so the UI
 * can show WHY the system is waiting instead of restating the verdict.
 */
export interface SufficiencyCheck {
  id: string;
  /** 0..1 how well this gate is satisfied (partial credit allowed). */
  score: number;
  /** 0..1 contribution to the aggregate confidence. */
  weight: number;
  ok: boolean;
  /** Populated only when `ok === false`. */
  missing?: string;
}

/** Non-negotiable shape of "do we know enough yet?". */
export interface SufficiencyReport {
  sessionId: string;
  status: SufficiencyStatus;
  /** 0..1 aggregate confidence in the current evidence set. */
  confidence: number;
  /** REQUIRED when status === "WAIT". Never empty in that case. */
  missingInformation: string[];
  /** REQUIRED when status === "WAIT". */
  nextObservation?: NextObservation;
  /** Set when status === "READY". */
  reason?: string;
  /** The weighted gates behind `confidence` — the UI's evidence gauge. */
  checks?: SufficiencyCheck[];
  evaluatedAt: string;
  /** Which cycle produced this report; starts at 0 for the first check. */
  cycle: number;
}

export interface TaskState {
  sessionId: string;
  taskId: string;
  phase: DebuggerPhase;
  /** When the machine entered `phase`. */
  enteredAt: string;
  /** ★ Absolute ISO timestamp the scheduler wakes on. Only set in WAITING. */
  waitUntil?: string;
  /** How many times sufficiency has been re-checked. */
  reEvalCount: number;
  sufficiency?: SufficiencyReport;
  activeHypothesisIds: string[];
  activeInterventionId?: string;
  activeExperimentId?: string;
  /** Populated in LEARNED: what the system now believes. */
  learnedAt?: string;
  /** Free-form notes from the transition that produced this state. */
  note?: string;
  updatedAt: string;
  schemaVersion: typeof TASK_STATE_SCHEMA_VERSION;
}

/** Inputs to the pure transition function. */
export type PhaseEvent =
  | { type: "EVENTS_APPENDED"; count: number; at: string }
  | { type: "EVALUATED"; at: string }
  | { type: "SUFFICIENT"; at: string; report: SufficiencyReport }
  | { type: "INSUFFICIENT"; at: string; report: SufficiencyReport }
  | { type: "WAIT_ELAPSED"; at: string }
  | { type: "WAIT_EXPIRED"; at: string }
  | { type: "MAX_CYCLES_REACHED"; at: string }
  | { type: "DIAGNOSED"; at: string; hypothesisIds: string[] }
  | { type: "INTERVENTION_PROPOSED"; at: string; interventionId: string }
  | { type: "INTERVENTION_REJECTED"; at: string }
  | { type: "INTERVENTION_APPROVED"; at: string; experimentId: string }
  | { type: "VERIFICATION_COMPLETE"; at: string; result: VerificationResult }
  | { type: "RESET"; at: string };

export type VerificationResult = "SUPPORTED" | "WEAKENED" | "REJECTED" | "INCONCLUSIVE";

/**
 * Guard rails. Putting these here (not in reasoning/) keeps the limits part of
 * the contract, so the frontend and tests can reason about them.
 */
export const STATE_MACHINE_LIMITS = {
  /** Minimum raw events before sufficiency is even evaluated. */
  minEventsBeforeEvaluate: 12,
  /** Minimum observation span, minutes. */
  minObservationMinutes: 5,
  /** Hard cap on re-evaluation cycles before a low-confidence degraded READY. */
  maxReEvalCycles: 5,
  /** Default WAIT duration when the report omits one. */
  defaultWaitMinutes: 30,
  /** New events that force an early wake-up out of WAITING. */
  earlyWakeEventThreshold: 40,
} as const;

export const PHASE_LABELS: Record<DebuggerPhase, string> = {
  OBSERVING: "Observing",
  INSUFFICIENT: "Insufficient Evidence",
  WAITING: "Waiting for More Evidence",
  RE_EVALUATING: "Re-evaluating",
  READY: "Ready to Diagnose",
  DIAGNOSING: "Diagnosing",
  INTERVENING: "Intervening",
  VERIFYING: "Verifying",
  LEARNED: "Learned",
};

export function isWaiting(s: TaskState): boolean {
  return s.phase === "WAITING";
}

/** True when the scheduler should wake this state at or before `now`. */
export function isDue(s: TaskState, now: Date = new Date()): boolean {
  return s.phase === "WAITING" && !!s.waitUntil && Date.parse(s.waitUntil) <= now.getTime();
}
