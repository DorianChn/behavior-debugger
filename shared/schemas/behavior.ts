/**
 * Behavior representation + Evidence.
 *
 * Responsibility boundary: this layer only DESCRIBES what happened. It never
 * decides why. Root-cause attribution belongs to reasoning/.
 *
 * Every field that makes a claim carries `eventIds` so the claim is traceable
 * to immutable RawEvents.
 */

import type { RawEvent } from "./event.js";

export const BEHAVIOR_SCHEMA_VERSION = "1.0" as const;

export const BEHAVIOR_KINDS = [
  "development",
  "docs_search",
  "ai_assistance",
  "communication",
  "context_switch",
  "idle",
  "unknown",
] as const;

export type BehaviorKind = (typeof BEHAVIOR_KINDS)[number];

/** Human-readable labels for the frontend timeline. */
export const BEHAVIOR_LABELS: Record<BehaviorKind, string> = {
  development: "Development",
  docs_search: "Documentation Search",
  ai_assistance: "AI Assistance",
  communication: "Communication",
  context_switch: "Context Switch",
  idle: "Idle",
  unknown: "Unknown",
};

export interface BehaviorSegment {
  segmentId: string;
  sessionId: string;
  /** Optional task grouping; segmenter may leave this undefined in MVP. */
  taskId?: string;
  kind: BehaviorKind;
  startTs: string;
  endTs: string;
  durationMs: number;
  /** Raw events this segment was derived from — the evidence link. */
  eventIds: string[];
  /** Classification confidence 0..1. */
  confidence: number;
}

export interface BehaviorTransition {
  from: BehaviorKind;
  to: BehaviorKind;
  count: number;
}

/** The metric set that intervention targets and verification measures. */
export interface BehaviorMetrics {
  totalDwellMs: number;
  /** ★ Primary intervention target: number of context switches in the window. */
  switchCount: number;
  switchRatePerMin: number;
  uniqueSources: number;
  avgDwellMs: number;
  /** Fraction of visits that return to an already-visited source. */
  returnRate: number;
  /** Longest uninterrupted development stretch, ms. */
  longestFocusMs: number;
}

export interface BehaviorRepresentation {
  representationId: string;
  sessionId: string;
  windowStart: string;
  windowEnd: string;
  windowMinutes: number;
  segments: BehaviorSegment[];
  /** Compressed kind sequence, e.g. ["development","docs_search","ai_assistance"]. */
  sequence: BehaviorKind[];
  transitions: BehaviorTransition[];
  metrics: BehaviorMetrics;
  /** All raw event ids folded into this representation. */
  evidenceIds: string[];
  schemaVersion: typeof BEHAVIOR_SCHEMA_VERSION;
}

/**
 * Evidence is the atomic unit of justification. `supporting` argues for a
 * hypothesis, `contradicting` argues against it. Both are REQUIRED arrays on
 * Hypothesis — an empty contradicting array is a valid answer, a missing one
 * is a bug.
 */
export interface Evidence {
  evidenceId: string;
  kind: "supporting" | "contradicting";
  /** Human-readable claim, e.g. "21 context switches in 30 minutes". */
  statement: string;
  /** Metric backing the claim, e.g. "switchRatePerMin". */
  metric?: string;
  value?: number;
  /** MUST be non-empty: evidence without provenance is not evidence. */
  eventIds: string[];
  /** 0..1 relative weight when aggregating confidence. */
  weight: number;
}

export interface BehaviorWindowQuery {
  sessionId: string;
  startTs: string;
  endTs: string;
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  lastEventType: BehaviorKind | null;
}

export function emptyMetrics(): BehaviorMetrics {
  return {
    totalDwellMs: 0,
    switchCount: 0,
    switchRatePerMin: 0,
    uniqueSources: 0,
    avgDwellMs: 0,
    returnRate: 0,
    longestFocusMs: 0,
  };
}

/** Convenience: derive the window covered by a raw event list. */
export function windowOf(events: RawEvent[]): { startTs: string; endTs: string; minutes: number } {
  if (events.length === 0) {
    const now = new Date().toISOString();
    return { startTs: now, endTs: now, minutes: 0 };
  }
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const startTs = sorted[0].timestamp;
  const endTs = sorted[sorted.length - 1].timestamp;
  const minutes = Math.max(
    0,
    Math.round(((Date.parse(endTs) - Date.parse(startTs)) / 60000) * 100) / 100
  );
  return { startTs, endTs, minutes };
}
