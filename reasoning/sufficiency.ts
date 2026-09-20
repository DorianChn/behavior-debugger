/**
 * Evidence sufficiency — the gate that produces Deferred Intelligence.
 *
 * This is deliberately NOT an LLM call. Asking a model "do you know enough?"
 * produces confident nonsense. Instead we evaluate measurable preconditions on
 * the behavior representation:
 *
 *   1. volume      — enough raw events
 *   2. span        — enough wall-clock observation
 *   3. variety     — more than one behavior kind observed
 *   4. stability   — the leading signal exists in more than one sub-window
 *   5. contrast    — a comparison baseline exists (for later verification)
 *
 * Every failed precondition becomes a human-readable `missingInformation`
 * entry, and the fix becomes a concrete `nextObservation` plan. That mapping is
 * what makes the WAIT state actionable rather than a shrug.
 */

import type { BehaviorRepresentation, BehaviorMetrics } from "../shared/schemas/behavior.js";
import type { RawEvent } from "../shared/schemas/event.js";
import {
  STATE_MACHINE_LIMITS,
  type SufficiencyCheck,
  type SufficiencyReport,
} from "../shared/schemas/task-state.js";
import { minutesBetween, sortByTs, spanOf } from "../shared/utils/window.js";

export interface SufficiencyInput {
  sessionId: string;
  events: RawEvent[];
  behavior: BehaviorRepresentation;
  /** How many re-evaluation cycles have already run. */
  cycle: number;
  at: string;
}

/** Tunables in one place so the demo can be dialled, and tests can pin them. */
export interface SufficiencyThresholds {
  minEvents: number;
  minObservationMinutes: number;
  minDistinctKinds: number;
  /** Required number of sub-windows in which the switch pattern reappears. */
  minStableSubwindows: number;
  /** Switch rate above which "context switching" is worth acting on. */
  highSwitchRatePerMin: number;
  readyConfidence: number;
}

export const DEFAULT_THRESHOLDS: SufficiencyThresholds = {
  minEvents: STATE_MACHINE_LIMITS.minEventsBeforeEvaluate,
  minObservationMinutes: STATE_MACHINE_LIMITS.minObservationMinutes,
  minDistinctKinds: 3,
  minStableSubwindows: 2,
  highSwitchRatePerMin: 0.4,
  readyConfidence: 0.7,
};

export const THRESHOLD_LABELS: Record<keyof SufficiencyThresholds, string> = {
  minEvents: "minimum raw events",
  minObservationMinutes: "minimum observation window",
  minDistinctKinds: "distinct behavior kinds",
  minStableSubwindows: "stable sub-windows",
  highSwitchRatePerMin: "switch rate signal",
  readyConfidence: "confidence threshold",
};

interface Check {
  id: keyof SufficiencyThresholds | "baseline";
  ok: boolean;
  /** What to say to the user when this check fails. */
  missing: string;
  /** What to do about it. */
  observation: string;
  /** Expected metric to become measurable. */
  metric: string;
  /** 0..1 contribution to the confidence score. */
  weight: number;
  /** 0..1 how well this check is satisfied (partial credit). */
  score: number;
}

/**
 * Split the observation span into N equal sub-windows and count how many show
 * the same switch-heavy pattern. A pattern that appears in only one sub-window
 * is a fluke, not a finding.
 */
export function countStableSubwindows(events: RawEvent[], subwindows = 3): number {
  const sorted = sortByTs(events);
  if (sorted.length < 4) return 0;
  const start = Date.parse(sorted[0].timestamp);
  const span = Date.parse(sorted[sorted.length - 1].timestamp) - start;
  if (span <= 0) return 0;
  const size = span / subwindows;

  let hits = 0;
  for (let i = 0; i < subwindows; i++) {
    const lo = start + i * size;
    const hi = i === subwindows - 1 ? start + span + 1 : start + (i + 1) * size;
    const bucket = sorted.filter((e) => {
      const t = Date.parse(e.timestamp);
      return t >= lo && t < hi;
    });
    const switches = bucket.filter((e) => e.eventType === "page_switch").length;
    const distinct = new Set(bucket.map((e) => e.source ?? e.target).filter(Boolean)).size;
    // A sub-window is "active" when it shows both movement and variety.
    if (switches >= 2 && distinct >= 2) hits++;
  }
  return hits;
}

function scoreRatio(value: number, target: number): number {
  if (target <= 0) return 1;
  return Math.min(1, Math.max(0, value / target));
}

export function evaluateSufficiency(
  input: SufficiencyInput,
  thresholds: SufficiencyThresholds = DEFAULT_THRESHOLDS
): SufficiencyReport {
  const { events, behavior, sessionId, cycle, at } = input;
  const m: BehaviorMetrics = behavior.metrics;

  const observationMinutes = Math.max(
    minutesBetween(behavior.windowStart, behavior.windowEnd),
    spanOf(events) / 60000
  );
  const distinctKinds = new Set(behavior.segments.map((s) => s.kind).filter((k) => k !== "idle")).size;
  const stableSubwindows = countStableSubwindows(events);

  const checks: Check[] = [
    {
      id: "minEvents",
      ok: events.length >= thresholds.minEvents,
      missing: `Only ${events.length} of ${thresholds.minEvents} required behavioral events collected`,
      observation: `Continue observing until at least ${thresholds.minEvents} events are captured`,
      metric: "eventCount",
      weight: 0.25,
      score: scoreRatio(events.length, thresholds.minEvents),
    },
    {
      id: "minObservationMinutes",
      ok: observationMinutes >= thresholds.minObservationMinutes,
      missing: `Observed for ${observationMinutes.toFixed(1)} of ${thresholds.minObservationMinutes} required minutes`,
      observation: `Continue observing for another ${Math.max(
        1,
        Math.ceil(thresholds.minObservationMinutes - observationMinutes)
      )} minutes`,
      metric: "observationMinutes",
      weight: 0.25,
      score: scoreRatio(observationMinutes, thresholds.minObservationMinutes),
    },
    {
      id: "minDistinctKinds",
      ok: distinctKinds >= thresholds.minDistinctKinds,
      missing: `Only ${distinctKinds} distinct behavior types seen; ${thresholds.minDistinctKinds} needed to compare patterns`,
      observation: "Continue observing to capture additional kinds of activity",
      metric: "distinctKinds",
      weight: 0.2,
      score: scoreRatio(distinctKinds, thresholds.minDistinctKinds),
    },
    {
      id: "minStableSubwindows",
      ok: stableSubwindows >= thresholds.minStableSubwindows,
      missing: `Behavior pattern reproduced in only ${stableSubwindows} sub-window(s); ${thresholds.minStableSubwindows} needed to rule out a one-off`,
      observation: "Continue observing across a later time period to confirm the pattern repeats",
      metric: "stableSubwindows",
      weight: 0.2,
      score: scoreRatio(stableSubwindows, thresholds.minStableSubwindows),
    },
    {
      id: "baseline",
      ok: m.switchCount >= 2,
      missing: "No baseline switching signal yet, so before/after verification would be meaningless",
      observation: "Continue observing until context switches can be counted",
      metric: "switchCount",
      weight: 0.1,
      score: scoreRatio(m.switchCount, 2),
    },
  ];

  const rawConfidence = checks.reduce((s, c) => s + c.weight * c.score, 0);
  // Never report certainty. Every check passing means "enough to act on", not
  // "proven", and a UI that shows 100% invites false trust.
  const confidence = Math.round(Math.min(0.95, rawConfidence) * 1000) / 1000;
  const failed = checks.filter((c) => !c.ok);
  const missingInformation = failed.map((c) => c.missing);
  // Machine-readable mirror of the ladder, for the dashboard's evidence gauge.
  const checkView: SufficiencyCheck[] = checks.map((c) => ({
    id: c.id,
    score: Math.round(c.score * 1000) / 1000,
    weight: c.weight,
    ok: c.ok,
    ...(c.ok ? {} : { missing: c.missing }),
  }));

  if (failed.length === 0 && confidence >= thresholds.readyConfidence) {
    return {
      sessionId,
      status: "READY",
      confidence,
      missingInformation: [],
      reason:
        `Enough behavioral evidence collected: ${events.length} events over ${observationMinutes.toFixed(1)} minutes, ` +
        `${behavior.sequence.length} behavior transitions, ${m.switchCount} context switches, ` +
        `pattern reproduced in ${stableSubwindows}/${3} sub-windows.`,
      checks: checkView,
      evaluatedAt: at,
      cycle,
    };
  }

  // The primary gap drives the wait plan; the rest are listed for context.
  const primary = failed[0];
  const duration = proposeWaitMinutes(failed, observationMinutes, thresholds);

  return {
    sessionId,
    status: "WAIT",
    confidence,
    missingInformation,
    nextObservation: {
      action: primary.observation,
      durationMinutes: duration,
      targetMetrics: [...new Set(failed.map((c) => c.metric))],
    },
    checks: checkView,
    evaluatedAt: at,
    cycle,
  };
}

/**
 * How long to wait. Never a magic number: derived from the largest shortfall,
 * clamped to a sane band so a hackathon demo doesn't stall for an hour.
 */
export function proposeWaitMinutes(
  failed: Check[],
  observationMinutes: number,
  thresholds: SufficiencyThresholds
): number {
  const shortfall = Math.ceil(thresholds.minObservationMinutes - observationMinutes);
  const base = Math.max(shortfall, 0);
  const withStability = failed.some((c) => c.id === "minStableSubwindows")
    ? Math.max(base, Math.ceil(thresholds.minObservationMinutes))
    : base;
  const wanted = Math.max(withStability, 5);
  return Math.min(45, Math.max(5, wanted));
}

/** Machine-readable snapshot of the checks, for the UI's evidence gauge. */
export function explainSufficiency(
  input: SufficiencyInput,
  thresholds: SufficiencyThresholds = DEFAULT_THRESHOLDS
): Array<{ id: string; label: string; ok: boolean; detail: string }> {
  const report = evaluateSufficiency(input, thresholds);
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string; ok: boolean; detail: string }> = [];
  for (const info of report.missingInformation) {
    if (seen.has(info)) continue;
    seen.add(info);
    out.push({ id: `missing_${out.length}`, label: "Evidence gap", ok: false, detail: info });
  }
  if (out.length === 0) {
    out.push({ id: "ready", label: "Sufficient evidence", ok: true, detail: report.reason ?? "ready" });
  }
  return out;
}
