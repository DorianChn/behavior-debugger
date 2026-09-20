/**
 * Hypothesis Generation.
 *
 * Generates COMPETING explanations from the pattern findings, each with
 * supporting evidence, contradicting evidence, a confidence score, and the
 * evidence it would still need. Never one root cause.
 *
 * The candidate catalogue is fixed (`CANDIDATES`); the scoring is arithmetic
 * over findings. An LLM may later enrich `rationale`, but it never invents a
 * cause that has no supporting finding — that is how "The root cause is X"
 * sneaks back in.
 */

import type { Evidence } from "../shared/schemas/behavior.js";
import {
  clampConfidence,
  type Hypothesis,
  type HypothesisDraft,
  type HypothesisSet,
  HYPOTHESIS_SCHEMA_VERSION,
} from "../shared/schemas/hypothesis.js";
import { shortId } from "../shared/utils/ids.js";
import { PATTERN_CODES, evidenceForFinding, type PatternFinding } from "./analyzer.js";

export interface HypothesisContext {
  sessionId: string;
  /** Findings produced by analyzePatterns(). */
  findings: PatternFinding[];
  /** Metrics of the behavior window, for absence-checks. */
  metrics: {
    switchCount: number;
    switchRatePerMin: number;
    returnRate: number;
    uniqueSources: number;
    longestFocusMs: number;
  };
  windowMinutes: number;
  revision: number;
}

interface Candidate {
  statement: string;
  rationale: string;
  /** Pattern codes that support this cause. */
  supports: string[];
  /** Pattern codes whose ABSENCE argues against this cause. */
  contradictedBy: string[];
  /** Evidence that would settle it. */
  missing: string[];
  /** Baseline confidence before evidence weighting. */
  base: number;
}

/**
 * The causal catalogue. Three to five candidates is the sweet spot: fewer
 * looks like a single-answer system, more is noise for a demo audience.
 */
export const CANDIDATES: Candidate[] = [
  {
    statement: "Documentation Fragmentation",
    rationale:
      "Required information is spread across multiple documentation sources, so each question costs a separate lookup and pulls attention away from the editor.",
    supports: [PATTERN_CODES.DOCS_HEAVY, PATTERN_CODES.REPEATED_SEQUENCE],
    contradictedBy: [PATTERN_CODES.LOW_FOCUS_DURATION],
    missing: [
      "Which documentation sources produced answers vs. dead ends",
      "Whether the same question was re-searched more than once",
      "Behavior from a different time period to confirm the pattern repeats",
    ],
    base: 0.55,
  },
  {
    statement: "Unclear Task Definition",
    rationale:
      "The goal is under-specified, so the user oscillates between exploration and implementation instead of converging.",
    supports: [PATTERN_CODES.LOW_FOCUS_DURATION, PATTERN_CODES.HIGH_CONTEXT_SWITCH],
    contradictedBy: [],
    missing: [
      "The user's own statement of the task goal",
      "Whether a written plan or ticket existed before the session started",
    ],
    base: 0.5,
  },
  {
    statement: "Frequent Context Switching",
    rationale:
      "The workspace itself invites switching — scattered tabs and resources mean every interruption costs a re-orientation.",
    supports: [PATTERN_CODES.HIGH_CONTEXT_SWITCH, PATTERN_CODES.SCATTERED_SOURCES, PATTERN_CODES.HIGH_RETURN_RATE],
    contradictedBy: [],
    missing: [
      "Which switches were user-initiated vs. notification-driven",
      "Longer observation to distinguish habit from one-off load",
    ],
    base: 0.58,
  },
  {
    statement: "Undefined Success Criteria",
    rationale:
      "Without a testable definition of done, the work cannot be declared complete, so the session keeps reopening rather than closing.",
    supports: [PATTERN_CODES.LOW_FOCUS_DURATION, PATTERN_CODES.AI_HEAVY],
    contradictedBy: [PATTERN_CODES.REPEATED_SEQUENCE],
    missing: [
      "Whether any completion check was run (tests, build, review)",
      "Whether the session ended with a shipped change",
    ],
    base: 0.42,
  },
];

function collect(ctx: HypothesisContext, codes: string[]): PatternFinding[] {
  return ctx.findings.filter((f) => codes.includes(f.code));
}

function scoreCandidate(c: Candidate, ctx: HypothesisContext): { confidence: number; missing: string[] } {
  const support = collect(ctx, c.supports);
  const contra = collect(ctx, c.contradictedBy);

  // Support adds, contradiction subtracts, but never below the floor — an
  // absent pattern is weak evidence of absence over a short window.
  const supportBoost = support.reduce((s, f) => s + 0.12 * f.severity, 0);
  const contraPenalty = contra.reduce((s, f) => s + 0.1 * f.severity, 0);
  // Observations that did NOT match the candidate's expected signature.
  const unmatched = ctx.findings.filter((f) => !c.supports.includes(f.code) && !c.contradictedBy.includes(f.code));

  let confidence = c.base + supportBoost - contraPenalty - unmatched.length * 0.02;

  // Hard evidence requirements: a candidate with zero supporting findings must
  // not be presented with meaningful confidence.
  if (support.length === 0) confidence = Math.min(confidence, 0.3);

  return {
    confidence: clampConfidence(confidence),
    missing: c.missing,
  };
}

export function generateHypotheses(ctx: HypothesisContext): HypothesisSet {
  const now = new Date().toISOString();
  const hypotheses: Hypothesis[] = [];

  for (const c of CANDIDATES) {
    const support = collect(ctx, c.supports);
    const contra = collect(ctx, c.contradictedBy);
    const { confidence, missing } = scoreCandidate(c, ctx);

    const supportingEvidence: Evidence[] = support.map(evidenceForFinding).filter((e) => e.eventIds.length > 0);

    const contradictingEvidence: Evidence[] = contra.map((f) => ({
      ...evidenceForFinding(f),
      kind: "contradicting" as const,
      statement: `Argues against "${c.statement}": ${f.title} (${f.detail})`,
    }));

    // If nothing supports it, that absence is itself stated honestly.
    if (supportingEvidence.length === 0) {
      contradictingEvidence.push({
        evidenceId: shortId("ev"),
        kind: "contradicting",
        statement: `No supporting behavioral signal observed for "${c.statement}" in this window`,
        metric: "supportingFindings",
        value: 0,
        eventIds: ctx.findings.flatMap((f) => f.eventIds).slice(0, 5),
        weight: 0.5,
      });
    }

    hypotheses.push({
      hypothesisId: shortId("hyp"),
      sessionId: ctx.sessionId,
      statement: c.statement,
      rationale: c.rationale,
      supportingEvidence,
      contradictingEvidence,
      confidence,
      missingEvidence: missing,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      schemaVersion: HYPOTHESIS_SCHEMA_VERSION,
    });
  }

  const present = hypotheses.filter((h) => h.supportingEvidence.length > 0);
  const ranked = (present.length >= 2 ? present : hypotheses).sort((a, b) => b.confidence - a.confidence);

  return {
    sessionId: ctx.sessionId,
    hypotheses: ranked,
    leadingId: ranked[0]?.hypothesisId ?? null,
    generatedAt: now,
    revision: ctx.revision,
  };
}

/** Update a hypothesis set after a verification came back negative. */
export function reviseAfterFailure(set: HypothesisSet, failedHypothesisId: string, deltaPct: number): HypothesisSet {
  const now = new Date().toISOString();
  const revised = set.hypotheses.map((h) => {
    if (h.hypothesisId !== failedHypothesisId) return h;
    // The intervention did not move the metric: demote the cause and record it.
    return {
      ...h,
      confidence: clampConfidence(h.confidence * 0.6),
      state: "weakened" as const,
      contradictingEvidence: [
        ...h.contradictingEvidence,
        {
          evidenceId: shortId("ev"),
          kind: "contradicting" as const,
          statement: `Intervention targeting this cause produced only ${deltaPct}% change, below the significance threshold`,
          metric: "deltaPct",
          value: deltaPct,
          eventIds: [],
          weight: 0.6,
        },
      ],
      updatedAt: now,
    };
  });

  const ranked = [...revised].sort((a, b) => b.confidence - a.confidence);
  return { ...set, hypotheses: ranked, leadingId: ranked[0]?.hypothesisId ?? null, generatedAt: now, revision: set.revision + 1 };
}

/** Human-facing one-liner used in the demo. */
export function describeSet(set: HypothesisSet): string {
  const lead = set.hypotheses.find((h) => h.hypothesisId === set.leadingId);
  if (!lead) return "No hypothesis available.";
  const others = set.hypotheses.filter((h) => h.hypothesisId !== lead.hypothesisId).length;
  return `${lead.statement} (${Math.round(lead.confidence * 100)}%) with ${others} competing explanation(s)`;
}

export type { HypothesisDraft };
