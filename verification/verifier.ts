/**
 * Experiment lifecycle + before/after comparison + verdict.
 *
 * The verification layer's whole reason to exist: the LLM is not allowed to say
 * "the intervention worked". `judge()` computes that from numbers, and
 * `INCONCLUSIVE` is a normal outcome whenever the samples are too thin or the
 * change sits inside the noise band.
 */

import type { RawEvent } from "../shared/schemas/event.js";
import type { BehaviorRepresentation, BehaviorMetrics } from "../shared/schemas/behavior.js";
import { buildBehaviorRepresentation } from "../behavior/engine.js";
import {
  MIN_EXPERIMENT_SAMPLES,
  VERDICT_THRESHOLDS,
  EXPERIMENT_SCHEMA_VERSION,
  type Experiment,
  type Intervention,
  type TimeWindow,
} from "../shared/schemas/intervention.js";
import {
  VERIFICATION_SCHEMA_VERSION,
  buildComparison,
  type MetricComparison,
  type Verification,
  type VerificationDraft,
} from "../shared/schemas/verification.js";
import type { VerificationResult } from "../shared/schemas/task-state.js";
import { eventsInWindow, minutesBetween, trailingWindow, addMinutes } from "../shared/utils/window.js";
import { shortId, round } from "../shared/utils/ids.js";

/** Default comparison length so before/after are always the same duration. */
export const DEFAULT_COMPARISON_MINUTES = 30;

export interface PlanExperimentInput {
  sessionId: string;
  intervention: Intervention;
  baselineWindow: TimeWindow;
  metrics: BehaviorMetrics;
}

/**
 * Freeze the baseline at plan time. If we recomputed the baseline after the
 * intervention started, the "before" number would drift and the comparison
 * would silently be against a moving target.
 *
 * `postWindow` starts EMPTY on purpose: nothing has been observed yet. Leaving
 * it as a zero-length marker at `now` is what lets `measure()` detect that the
 * post period is disjoint from the pre period and pick the right windowing
 * mode. (Filling it with a guess here would bake in a wrong assumption.)
 */
export function planExperiment(input: PlanExperimentInput): Experiment {
  const metric = input.intervention.targetMetric;
  const value = metricValue(input.metrics, metric);
  const now = new Date().toISOString();

  return {
    experimentId: shortId("exp"),
    sessionId: input.sessionId,
    interventionId: input.intervention.interventionId,
    hypothesisId: input.intervention.hypothesisId,
    preWindow: input.baselineWindow,
    postWindow: { start: now, end: now },
    baselineValue: value,
    metric,
    status: "planned",
    createdAt: now,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
  };
}

export function metricValue(m: BehaviorMetrics, metric: string): number {
  switch (metric) {
    case "switchRatePerMin":
      return m.switchRatePerMin;
    case "switchCount":
      return m.switchCount;
    case "uniqueSources":
      return m.uniqueSources;
    case "returnRate":
      return m.returnRate;
    case "longestFocusMs":
      return m.longestFocusMs;
    case "avgDwellMs":
      return m.avgDwellMs;
    case "totalDwellMs":
      return m.totalDwellMs;
    default:
      return 0;
  }
}

/**
 * Measure both windows.
 *
 * Two modes, and the choice matters:
 *
 *  - `mode: "contiguous"` (default): the post window is the trailing
 *    `comparisonMinutes` ending at the anchor, and the pre window is the
 *    `comparisonMinutes` immediately BEFORE it. This is the honest comparison
 *    when observation is continuous — same duration, no overlap, and no event
 *    can be counted on both sides.
 *
 *  - `mode: "declared"`: use the windows the experiment already recorded. Needed
 *    when the two observation periods are separated in time (e.g. baseline this
 *    morning, re-measured this afternoon). In that case a contiguous split would
 *    slice the "before" window out of the gap and report a meaningless number.
 *
 * `measure()` picks `declared` automatically when the recorded post window is
 * disjoint from the recorded pre window, because that is exactly the signal
 * that the two observations are not adjacent.
 */
export interface MeasureInput {
  experiment: Experiment;
  /** All events for the session, pre and post. */
  events: RawEvent[];
  comparisonMinutes?: number;
  mode?: "contiguous" | "declared";
}

export interface MeasureOutcome {
  experiment: Experiment;
  beforeRepresentation: BehaviorRepresentation;
  afterRepresentation: BehaviorRepresentation;
  comparison: MetricComparison;
  eventsBefore: RawEvent[];
  eventsAfter: RawEvent[];
  /** True when either window has too little data to judge. */
  insufficient: boolean;
  insufficientReason?: string;
  mode: "contiguous" | "declared";
}

export function measure(input: MeasureInput): MeasureOutcome {
  const minutes = input.comparisonMinutes ?? DEFAULT_COMPARISON_MINUTES;
  const sorted = [...input.events]
    .filter((e) => e.sessionId === input.experiment.sessionId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const sessionEvents = sorted;
  const lastTs = sessionEvents[sessionEvents.length - 1]?.timestamp ?? new Date().toISOString();
  const windowMinutes = Math.max(
    1,
    Math.round(minutesBetween(input.experiment.preWindow.start, input.experiment.preWindow.end)) || minutes
  );

  // Decide the mode: are the two recorded observation periods adjacent, or
  // separated by a gap (which means "declared" windows are the only valid read)?
  const declaredPreMinutes = minutesBetween(input.experiment.preWindow.start, input.experiment.preWindow.end);
  const gapBetween = minutesBetween(input.experiment.preWindow.end, input.experiment.postWindow.start);
  const autoDeclared = gapBetween > Math.max(2, declaredPreMinutes * 0.5);
  let mode = input.mode ?? (autoDeclared ? "declared" : "contiguous");

  let preWindow: TimeWindow;
  let postWindow: TimeWindow;

  if (mode === "declared") {
    // ★ The post window must be anchored to events that were actually observed
    // AFTER the baseline period — not to the last event on disk. A stray event
    // written minutes or hours later (an approval audit trail, a late import)
    // would otherwise define "now" and produce a post window containing three
    // events bunched into a few milliseconds, which reads as a gigantic,
    // entirely fictional improvement.
    //
    // The boundary is the close of the baseline window. The recorded
    // `postWindow.start` is deliberately NOT used as the anchor: it is stamped
    // at wall-clock approval time, which in a replay sits far after the fixture
    // data. Anything observed after the baseline ended is post-intervention.
    const preEnd = input.experiment.preWindow.end;
    const afterIntervention = sessionEvents.filter((e) => Date.parse(e.timestamp) > Date.parse(preEnd));

    if (afterIntervention.length === 0) {
      // No post-intervention observation exists at all.
      //
      // The honest move is to compare the baseline against the period that
      // followed it — but there IS no such period, so any comparison would be
      // fiction. We still return a well-formed outcome (the caller reports
      // INCONCLUSIVE because the sample is thin) and we keep `pre` pinned to
      // the RECORDED baseline window. Slicing `pre` arbitrarily would compare
      // the baseline against itself and could report a huge, meaningless swing.
      mode = "contiguous";
      const baselineStart = input.experiment.preWindow.start;
      const baselineEnd = input.experiment.preWindow.end;
      preWindow = { start: baselineStart, end: baselineEnd };
      // The post window is the equal-length span immediately after the baseline,
      // which is empty (or nearly so) when nothing was observed. It is nudged
      // forward by a millisecond because `eventsInWindow` is inclusive on both
      // bounds — without this, the baseline's final event would be counted as
      // post-intervention data and the two sides would not be disjoint.
      const postStart = new Date(Date.parse(baselineEnd) + 1).toISOString();
      postWindow = { start: postStart, end: addMinutes(postStart, windowMinutes) };
    } else {
      // The post window runs from the first post-baseline observation, for the
      // same duration as the baseline, so both sides are comparable.
      const start = afterIntervention[0].timestamp;
      postWindow = { start, end: addMinutes(start, windowMinutes) };
      preWindow = {
        start: input.experiment.preWindow.start,
        end: addMinutes(input.experiment.preWindow.start, windowMinutes),
      };
    }

    // If the two windows would overlap, fall back to a contiguous split so the
    // same event can never be counted on both sides.
    if (Date.parse(preWindow.end) > Date.parse(postWindow.start)) {
      mode = "contiguous";
      postWindow = trailingWindow(lastTs, minutes);
      preWindow = {
        start: new Date(Date.parse(postWindow.start) - minutes * 60_000).toISOString(),
        end: postWindow.start,
      };
    }
  } else {
    postWindow = trailingWindow(lastTs, minutes);
    preWindow = {
      start: new Date(Date.parse(postWindow.start) - minutes * 60_000).toISOString(),
      end: postWindow.start,
    };
  }

  const eventsAfter = eventsInWindow(sorted, postWindow, input.experiment.sessionId);
  const eventsBefore = eventsInWindow(sorted, preWindow, input.experiment.sessionId);

  const beforeRepresentation = buildBehaviorRepresentation(eventsBefore);
  const afterRepresentation = buildBehaviorRepresentation(eventsAfter);

  const metric = input.experiment.metric;
  // switchCount is an absolute count; normalise it to a rate so a shorter post
  // window cannot look like an improvement purely by containing fewer events.
  const effectiveMetric = metric === "switchCount" ? "switchRatePerMin" : metric;
  const before = round(metricValue(beforeRepresentation.metrics, effectiveMetric), 3);
  const after = round(metricValue(afterRepresentation.metrics, effectiveMetric), 3);

  const draft: VerificationDraft = {
    metric: effectiveMetric,
    before,
    after,
    sampleSizeBefore: eventsBefore.length,
    sampleSizeAfter: eventsAfter.length,
    windowMinutesBefore: Math.max(1, Math.round(minutesBetween(preWindow.start, preWindow.end))),
    windowMinutesAfter: Math.max(1, Math.round(minutesBetween(postWindow.start, postWindow.end))),
  };

  const insufficient =
    eventsBefore.length < MIN_EXPERIMENT_SAMPLES || eventsAfter.length < MIN_EXPERIMENT_SAMPLES;

  return {
    experiment: {
      ...input.experiment,
      preWindow,
      postWindow,
      baselineValue: draft.before,
      status: insufficient ? "running" : "completed",
    },
    beforeRepresentation,
    afterRepresentation,
    comparison: buildComparison(draft),
    eventsBefore,
    eventsAfter,
    insufficient,
    insufficientReason: insufficient
      ? `Need at least ${MIN_EXPERIMENT_SAMPLES} events in each window (before: ${eventsBefore.length}, after: ${eventsAfter.length})`
      : undefined,
    mode,
  };
}

/**
 * The verdict. Arithmetic only — no model, no judgement call.
 *
 * Note the deliberate asymmetry: an improvement must clear `supportedPct` to be
 * called SUPPORTED, but a regression needs the same margin to be REJECTED. Small
 * movements are INCONCLUSIVE rather than being spun as success.
 */
export function judge(comparison: MetricComparison, opts: { insufficient?: boolean; insufficientReason?: string } = {}): {
  result: VerificationResult;
  reason: string;
} {
  const { before, after, deltaPct, metric } = comparison;

  if (opts.insufficient) {
    return {
      result: "INCONCLUSIVE",
      reason: `${opts.insufficientReason ?? "Insufficient samples"} — a verdict would not be evidence-based.`,
    };
  }
  if (before === 0 && after === 0) {
    return {
      result: "INCONCLUSIVE",
      reason: `${metric} was 0 in both windows, so no change can be demonstrated.`,
    };
  }

  const t = VERDICT_THRESHOLDS;
  const absolute = Math.abs(deltaPct);

  if (absolute < t.noiseBandPct) {
    return {
      result: "INCONCLUSIVE",
      reason: `${metric} moved ${deltaPct}% (${before} → ${after}), inside the ±${t.noiseBandPct}% noise band — not distinguishable from normal variation.`,
    };
  }
  if (deltaPct >= t.supportedPct) {
    return {
      result: "SUPPORTED",
      reason: `${metric} fell from ${before} to ${after} (−${absolute}%), exceeding the ${t.supportedPct}% improvement threshold.`,
    };
  }
  if (deltaPct >= t.noiseBandPct) {
    return {
      result: "WEAKENED",
      reason: `${metric} improved ${deltaPct}% (${before} → ${after}) — real but below the ${t.supportedPct}% threshold, so the hypothesis is weakened rather than confirmed.`,
    };
  }
  if (deltaPct <= -t.rejectedPct) {
    return {
      result: "REJECTED",
      reason: `${metric} worsened by ${absolute}% (${before} → ${after}) after the intervention — the hypothesis is contradicted.`,
    };
  }
  return {
    result: "WEAKENED",
    reason: `${metric} worsened ${absolute}% (${before} → ${after}), below the rejection threshold.`,
  };
}

export function buildVerification(
  experiment: Experiment,
  intervention: Intervention,
  outcome: MeasureOutcome
): Verification {
  const verdict = judge(outcome.comparison, {
    insufficient: outcome.insufficient,
    insufficientReason: outcome.insufficientReason,
  });
  return {
    verificationId: shortId("ver"),
    sessionId: experiment.sessionId,
    experimentId: experiment.experimentId,
    hypothesisId: experiment.hypothesisId,
    interventionId: intervention.interventionId,
    comparison: outcome.comparison,
    result: verdict.result,
    reason: verdict.reason,
    eventIdsBefore: outcome.eventsBefore.map((e) => e.eventId),
    eventIdsAfter: outcome.eventsAfter.map((e) => e.eventId),
    verifiedAt: new Date().toISOString(),
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
  };
}

/** One-line demo summary, e.g. "21 → 8 switches / 30 min (−61.9%)". */
export function summarizeVerification(v: Verification): string {
  const c = v.comparison;
  const arrow = c.deltaPct >= 0 ? "−" : "+";
  return `${c.before} → ${c.after} ${c.metric} / ${c.windowMinutesAfter} min (${arrow}${Math.abs(c.deltaPct)}%) · ${v.result}`;
}

export const __internals = { metricValue };
