/**
 * End-to-end pipeline: ingest → behavior → reason → intervene → verify.
 *
 * Owns the cross-module orchestration and the persistence ordering. The
 * frontend only ever talks to this layer through the HTTP server, so module
 * internals stay swappable.
 */

import type { RawEvent } from "./shared/schemas/event.js";
import type { SessionDebugView } from "./shared/schemas/task.js";
import type { Task } from "./shared/schemas/task.js";
import { TASK_SCHEMA_VERSION } from "./shared/schemas/task.js";
import type { TimelineEntry } from "./shared/types/api.js";
import type { TimeWindow } from "./shared/schemas/intervention.js";
import {
  appendMemory,
  loadBehavior,
  loadExperiment,
  loadHypothesisSet,
  loadIntervention,
  loadTask,
  loadTaskState,
  loadVerification,
  readEventsForSession,
  readMemory,
  readTimeline,
  saveExperiment,
  saveIntervention,
  saveTask,
  saveVerification,
  listSessions,
} from "./database/store.js";
import { ingest } from "./collector/src/ingest.js";
import { evaluateSession, ensureState, onNewEvents } from "./reasoning/engine.js";
import { applyEvent, WaitScheduler, bootstrapScheduler } from "./reasoning/state-machine-port.js";
import { planIntervention, rankInterventions } from "./intervention/planner.js";
import { executeIntervention, reviewIntervention, type ExecutionOutcome } from "./intervention/executor.js";
import { buildVerification, measure, planExperiment, summarizeVerification } from "./verification/verifier.js";
import { narrate } from "./reasoning/provider.js";
import { shortId } from "./shared/utils/ids.js";
import { windowOf } from "./shared/schemas/behavior.js";

/** How the server reacts when a WAIT timer fires. */
let scheduler: WaitScheduler | null = null;

export function getScheduler(): WaitScheduler {
  if (!scheduler) {
    scheduler = new WaitScheduler((sessionId) => {
      // The wake handler is where a real deployment would also notify a queue.
      const state = loadTaskState(sessionId);
      if (!state || state.phase !== "WAITING") return;
      try {
        applyEvent(state, { type: "WAIT_ELAPSED", at: new Date().toISOString() });
        const result = evaluateSession(sessionId);
        if (result.waiting) scheduler?.arm(result.state);
        console.error(`[scheduler] woke ${sessionId} → ${result.state.phase}: ${result.headline}`);
      } catch (err) {
        console.error(`[scheduler] wake failed for ${sessionId}:`, err instanceof Error ? err.message : err);
      }
    }, { timeScale: Number(process.env.WAIT_TIME_SCALE ?? "1") });
    bootstrapScheduler(scheduler);
  }
  return scheduler;
}

export function createTask(sessionId: string, goal: string, successCriteria?: string[]): Task {
  const now = new Date().toISOString();
  const task: Task = {
    taskId: `task_${sessionId}`,
    sessionId,
    title: goal.slice(0, 60),
    goal,
    declaredAt: now,
    status: "active",
    successCriteria,
    schemaVersion: TASK_SCHEMA_VERSION,
  };
  saveTask(task);
  return task;
}

/**
 * Ingest a batch and react appropriately. Returns the evaluation outcome so the
 * HTTP layer can echo the phase straight back to the extension.
 *
 * `sessionId` is a required parameter, not something inferred from
 * `events[0].sessionId`. Inferring it meant the declared session could disagree
 * with the events' session and the mismatch would go unnoticed — the request
 * would say one thing and the data would be filed under another. Callers now
 * state the session, and `ingest()` rejects any event that disagrees.
 */
export function ingestAndEvaluate(
  sessionId: string,
  events: RawEvent[],
  opts: { batchId?: string } = {},
) {
  if (!sessionId) throw new Error("ingestAndEvaluate requires a sessionId");
  if (events.length === 0) throw new Error("ingestAndEvaluate requires at least one event");

  const result = ingest({ sessionId, events, batchId: opts.batchId });
  const outcome = onNewEvents(sessionId, result.accepted);
  if (outcome.waiting) getScheduler().arm(outcome.state);
  return { ingest: result, outcome };
}

/** Assemble everything the dashboard needs for one session. */
export function buildSessionView(sessionId: string): SessionDebugView {
  const state = loadTaskState(sessionId) ?? ensureState(sessionId);
  return {
    sessionId,
    task: loadTask(sessionId),
    state,
    behavior: loadBehavior(sessionId),
    hypothesisSet: loadHypothesisSet(sessionId),
    sufficiency: state.sufficiency ?? null,
    intervention: loadIntervention(sessionId),
    experiment: loadExperiment(sessionId),
    verification: loadVerification(sessionId),
  };
}

export interface ProposeOutcome {
  view: SessionDebugView;
  alternatives: Array<{ title: string; kind: string; score: number }>;
  narrative: string;
}

/** READY → DIAGNOSING → INTERVENING. Proposes; never executes. */
export async function proposeIntervention(sessionId: string): Promise<ProposeOutcome> {
  const evalResult = evaluateSession(sessionId);
  const { state, behavior, hypothesisSet } = evalResult;
  if (!hypothesisSet || !behavior) {
    throw new Error(`Cannot propose an intervention: session ${sessionId} is still in ${state.phase}`);
  }
  if (state.phase === "INTERVENING" && loadIntervention(sessionId)?.approval.status === "pending") {
    // Already proposed and awaiting a decision — return the existing proposal
    // instead of minting a second one, so a double-click is harmless.
    const existing = loadIntervention(sessionId)!;
    return {
      view: buildSessionView(sessionId),
      alternatives: rankInterventions({ sessionId, hypothesisSet, behavior }).map((r) => ({
        title: r.recipe.title,
        kind: r.recipe.kind,
        score: r.score,
      })),
      narrative: (await narrate({ kind: "intervention", behavior, findings: evalResult.findings, hypothesisSet })).text,
    } satisfies ProposeOutcome;
  }
  if (state.phase !== "READY" && state.phase !== "DIAGNOSING") {
    throw new Error(
      `Cannot propose an intervention from phase ${state.phase} — evidence must be READY first (currently: ${evalResult.headline})`
    );
  }

  const intervention = planIntervention({ sessionId, hypothesisSet, behavior });
  saveIntervention(intervention);

  const advanced = applyEvent(
    { ...state, phase: "DIAGNOSING" },
    { type: "INTERVENTION_PROPOSED", at: new Date().toISOString(), interventionId: intervention.interventionId }
  );

  const alternatives = rankInterventions({ sessionId, hypothesisSet, behavior }).map((r) => ({
    title: r.recipe.title,
    kind: r.recipe.kind,
    score: r.score,
  }));

  const narrative = await narrate({
    kind: "intervention",
    behavior,
    findings: evalResult.findings,
    hypothesisSet,
  });

  return {
    view: { ...buildSessionView(sessionId), state: advanced, intervention },
    alternatives,
    narrative: narrative.text,
  };
}

export interface ApproveOutcome {
  view: SessionDebugView;
  execution: ExecutionOutcome;
  message: string;
}

/** Human approves → INTERVENING → VERIFYING, baseline frozen at plan time. */
export function approveIntervention(
  sessionId: string,
  opts: { acknowledgedBy: string; decision?: "approved" | "rejected"; note?: string }
): ApproveOutcome {
  const state = loadTaskState(sessionId);
  const intervention = loadIntervention(sessionId);
  if (!state || !intervention) throw new Error(`No pending intervention for session ${sessionId}`);

  const decision = opts.decision ?? "approved";
  const reviewed = reviewIntervention(intervention, {
    interventionId: intervention.interventionId,
    acknowledgedBy: opts.acknowledgedBy,
    decision,
    note: opts.note,
  });
  saveIntervention(reviewed.intervention);

  const now = new Date().toISOString();

  if (decision === "rejected") {
    const next = applyEvent(state, { type: "INTERVENTION_REJECTED", at: now });
    return {
      view: { ...buildSessionView(sessionId), state: next, intervention: reviewed.intervention },
      execution: { interventionId: reviewed.intervention.interventionId, kind: "checklist", title: "rejected", items: [], markdown: "" },
      message: "Intervention rejected. The system will re-evaluate rather than proceed.",
    };
  }

  // Freeze the baseline from the behavior window BEFORE the change.
  const behavior = loadBehavior(sessionId);
  const events = readEventsForSession(sessionId);
  const w: TimeWindow = behavior
    ? { start: behavior.windowStart, end: behavior.windowEnd }
    : (() => {
        const x = windowOf(events);
        return { start: x.startTs, end: x.endTs };
      })();

  const experiment = planExperiment({
    sessionId,
    intervention: reviewed.intervention,
    baselineWindow: w,
    metrics: behavior?.metrics ?? {
      totalDwellMs: 0, switchCount: 0, switchRatePerMin: 0, uniqueSources: 0,
      avgDwellMs: 0, returnRate: 0, longestFocusMs: 0,
    },
  });
  saveExperiment(experiment);

  const verifying = applyEvent(state, { type: "INTERVENTION_APPROVED", at: now, experimentId: experiment.experimentId });
  const execution = executeIntervention(reviewed.intervention);

  return {
    view: {
      ...buildSessionView(sessionId),
      state: verifying,
      intervention: reviewed.intervention,
      experiment,
    },
    execution,
    message: `Approved by ${opts.acknowledgedBy}. Baseline frozen at ${experiment.baselineValue} ${experiment.metric}. Collect a post-intervention window, then run verify.`,
  };
}

export interface VerifyOutcome {
  view: SessionDebugView;
  summary: string;
  narrative: string;
}

/** Measure the post window, judge arithmetically, and loop or learn. */
export async function runVerification(sessionId: string, opts: { comparisonMinutes?: number; now?: string } = {}): Promise<VerifyOutcome> {
  const state = loadTaskState(sessionId);
  const intervention = loadIntervention(sessionId);
  const experiment = loadExperiment(sessionId);
  if (!state || !intervention || !experiment) {
    throw new Error(`Session ${sessionId} has no approved experiment to verify`);
  }

  const events = readEventsForSession(sessionId);
  const outcome = measure({ experiment, events, comparisonMinutes: opts.comparisonMinutes });
  const verification = buildVerification(experiment, intervention, outcome);
  saveVerification(verification);
  saveExperiment(outcome.experiment);

  const next = applyEvent(state, {
    type: "VERIFICATION_COMPLETE",
    at: verification.verifiedAt,
    result: verification.result,
  });

  if (verification.result === "SUPPORTED") {
    appendMemory({
      memoryId: shortId("mem"),
      sessionId,
      hypothesisId: verification.hypothesisId,
      interventionId: intervention.interventionId,
      result: verification.result,
      lesson: `${intervention.title} reduced ${verification.comparison.metric} by ${Math.abs(verification.comparison.deltaPct)}%`,
      deltaPct: verification.comparison.deltaPct,
      metric: verification.comparison.metric,
      createdAt: verification.verifiedAt,
    });
  }

  const narrative = await narrate({
    kind: "verification",
    behavior: outcome.afterRepresentation,
    findings: [],
    extra: { comparison: verification.comparison, result: verification.result },
  });

  return {
    view: { ...buildSessionView(sessionId), state: next, verification, experiment: outcome.experiment },
    summary: summarizeVerification(verification),
    narrative: narrative.text,
  };
}

export function sessionTimeline(sessionId: string): TimelineEntry[] {
  return loadTaskState(sessionId) ? readTimeline(sessionId) : [];
}

export { listSessions, readMemory };

/** Start the scheduler. Call once at process start. */
export function bootstrap(): void {
  getScheduler();
}
