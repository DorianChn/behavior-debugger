/**
 * Pattern Analysis — describes recurring structure in the behavior stream.
 *
 * Consumes BehaviorRepresentation (never raw events directly), produces
 * PatternFinding objects that hypotheses cite as evidence. No LLM here: these
 * are arithmetic facts, and facts must not be hallucinatable.
 */

import type { BehaviorKind, BehaviorRepresentation, Evidence } from "../shared/schemas/behavior.js";
import { BEHAVIOR_LABELS } from "../shared/schemas/behavior.js";
import { round, shortId } from "../shared/utils/ids.js";

export interface PatternFinding {
  findingId: string;
  /** Stable machine id, e.g. "high_context_switch". */
  code: string;
  title: string;
  detail: string;
  metric: string;
  value: number;
  /** 0..1 — how strongly the finding stands out from its neutral baseline. */
  severity: number;
  /** Raw event ids backing the finding. */
  eventIds: string[];
}

/** Named pattern codes so hypotheses and the UI can refer to them stably. */
export const PATTERN_CODES = {
  HIGH_CONTEXT_SWITCH: "high_context_switch",
  REPEATED_SEQUENCE: "repeated_sequence",
  LOW_FOCUS_DURATION: "low_focus_duration",
  HIGH_RETURN_RATE: "high_return_rate",
  SCATTERED_SOURCES: "scattered_sources",
  DOCS_HEAVY: "docs_heavy",
  AI_HEAVY: "ai_heavy",
  NO_LONG_FOCUS: "no_long_focus",
} as const;

export type PatternCode = (typeof PATTERN_CODES)[keyof typeof PATTERN_CODES];

function evidenceFrom(f: PatternFinding): Evidence {
  return {
    evidenceId: shortId("ev"),
    kind: "supporting",
    statement: `${f.title}: ${f.detail}`,
    metric: f.metric,
    value: f.value,
    eventIds: f.eventIds,
    weight: round(f.severity, 2),
  };
}

export function evidenceForFinding(f: PatternFinding): Evidence {
  return evidenceFrom(f);
}

/** Count how often the same ordered pair appears — the raw material for "loops". */
export function detectRepeatedSequences(
  repr: BehaviorRepresentation,
  minCount = 3
): Array<{ pattern: BehaviorKind[]; count: number; segmentIds: string[] }> {
  const seq = repr.segments.map((s) => s.kind);
  const idByIndex = repr.segments.map((s) => s.segmentId);
  const found = new Map<string, { pattern: BehaviorKind[]; count: number; segmentIds: string[] }>();

  // Look for 3-grams first (a real loop), then 2-grams (a bounce).
  for (const n of [3, 2]) {
    for (let i = 0; i + n <= seq.length; i++) {
      const window = seq.slice(i, i + n);
      if (window.every((k) => k === "idle")) continue;
      const key = window.join(">");
      const cur = found.get(key) ?? { pattern: window, count: 0, segmentIds: [] };
      cur.count += 1;
      cur.segmentIds.push(...idByIndex.slice(i, i + n));
      found.set(key, cur);
    }
    const hits = [...found.values()].filter((v) => v.pattern.length === n && v.count >= minCount);
    if (hits.length) return hits.sort((a, b) => b.count - a.count);
  }
  return [];
}

export function analyzePatterns(repr: BehaviorRepresentation, opts: { minSwitchRate?: number } = {}): PatternFinding[] {
  const minSwitchRate = opts.minSwitchRate ?? 0.4;
  const m = repr.metrics;
  const findings: PatternFinding[] = [];
  const allIds = repr.evidenceIds;

  if (m.switchRatePerMin >= minSwitchRate || m.switchCount >= 8) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.HIGH_CONTEXT_SWITCH,
      title: "High context switching",
      detail: `${m.switchCount} switches in ${repr.windowMinutes} minutes (${m.switchRatePerMin}/min)`,
      metric: "switchRatePerMin",
      value: m.switchRatePerMin,
      severity: round(Math.min(1, m.switchRatePerMin / (minSwitchRate * 2)), 2),
      eventIds: allIds,
    });
  }

  const repeated = detectRepeatedSequences(repr, 3);
  for (const r of repeated.slice(0, 2)) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.REPEATED_SEQUENCE,
      title: "Repeated behavioral loop",
      detail: `${r.pattern.map((k) => BEHAVIOR_LABELS[k]).join(" → ")} repeated ${r.count} times`,
      metric: "repeatCount",
      value: r.count,
      severity: round(Math.min(1, r.count / 6), 2),
      eventIds: r.segmentIds.length ? r.segmentIds : allIds,
    });
  }

  const focusMinutes = m.longestFocusMs / 60000;
  if (focusMinutes < 3) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.LOW_FOCUS_DURATION,
      title: "No sustained focus block",
      detail: `Longest uninterrupted development stretch was only ${focusMinutes.toFixed(1)} minutes`,
      metric: "longestFocusMs",
      value: m.longestFocusMs,
      severity: round(Math.min(1, 1 - focusMinutes / 3), 2),
      eventIds: allIds,
    });
  }

  if (m.returnRate >= 0.4) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.HIGH_RETURN_RATE,
      title: "Frequent return to the same sources",
      detail: `${Math.round(m.returnRate * 100)}% of visits returned to an already-visited source`,
      metric: "returnRate",
      value: m.returnRate,
      severity: round(Math.min(1, m.returnRate), 2),
      eventIds: allIds,
    });
  }

  if (m.uniqueSources >= 5) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.SCATTERED_SOURCES,
      title: "Work scattered across many sources",
      detail: `${m.uniqueSources} distinct sources in one window`,
      metric: "uniqueSources",
      value: m.uniqueSources,
      severity: round(Math.min(1, m.uniqueSources / 8), 2),
      eventIds: allIds,
    });
  }

  const kindCount = (k: BehaviorKind) => repr.segments.filter((s) => s.kind === k).length;
  if (kindCount("docs_search") >= 3) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.DOCS_HEAVY,
      title: "Documentation lookups dominate",
      detail: `${kindCount("docs_search")} separate documentation-search segments`,
      metric: "docsSegments",
      value: kindCount("docs_search"),
      severity: round(Math.min(1, kindCount("docs_search") / 6), 2),
      eventIds: repr.segments.filter((s) => s.kind === "docs_search").flatMap((s) => s.eventIds),
    });
  }

  if (kindCount("ai_assistance") >= 2) {
    findings.push({
      findingId: shortId("pat"),
      code: PATTERN_CODES.AI_HEAVY,
      title: "Repeated AI assistance requests",
      detail: `${kindCount("ai_assistance")} AI-assistance segments interleaved with development`,
      metric: "aiSegments",
      value: kindCount("ai_assistance"),
      severity: round(Math.min(1, kindCount("ai_assistance") / 5), 2),
      eventIds: repr.segments.filter((s) => s.kind === "ai_assistance").flatMap((s) => s.eventIds),
    });
  }

  return findings.sort((a, b) => b.severity - a.severity);
}

/** A one-line factual headline for the UI. */
export function summarizePatterns(findings: PatternFinding[]): string {
  if (findings.length === 0) return "No notable behavioral pattern detected yet.";
  return findings
    .slice(0, 3)
    .map((f) => f.title)
    .join(" · ");
}
