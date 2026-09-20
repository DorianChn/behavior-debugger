/**
 * Hypothesis — the multi-hypothesis contract.
 *
 * HARD RULE (Principle 3, Evidence-Based AI): the system never emits a single
 * root cause while evidence is thin. It emits an array of competing
 * hypotheses, each carrying supporting evidence, contradicting evidence,
 * a confidence score, and — critically — the evidence it is MISSING.
 *
 * `missingEvidence` is what drives the Deferred Intelligence state machine:
 * non-empty missingEvidence on the leading hypothesis is the signal to WAIT.
 */

import type { Evidence } from "./behavior.js";

export const HYPOTHESIS_SCHEMA_VERSION = "1.0" as const;

export const HYPOTHESIS_STATES = [
  "draft",
  "under_review",
  "supported",
  "weakened",
  "rejected",
] as const;

export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];

export interface Hypothesis {
  hypothesisId: string;
  sessionId: string;
  /** Short cause name, e.g. "Documentation Fragmentation". */
  statement: string;
  /** Longer explanation for humans. */
  rationale?: string;
  supportingEvidence: Evidence[];
  /** REQUIRED. May be empty, may never be absent. */
  contradictingEvidence: Evidence[];
  /** 0..1 calibrated confidence. Never 1.0. */
  confidence: number;
  /** REQUIRED. Empty array == no known gaps. Non-empty drives WAITING. */
  missingEvidence: string[];
  state: HypothesisState;
  createdAt: string;
  updatedAt: string;
  schemaVersion: typeof HYPOTHESIS_SCHEMA_VERSION;
}

/** Marks which hypothesis the system currently believes most. */
export interface HypothesisSet {
  sessionId: string;
  hypotheses: Hypothesis[];
  /** hypothesisId of the leading candidate. */
  leadingId: string | null;
  generatedAt: string;
  /** How many re-evaluation cycles produced this set. */
  revision: number;
}

export interface HypothesisDraft {
  statement: string;
  rationale?: string;
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];
  confidence: number;
  missingEvidence: string[];
}

export const MAX_CONFIDENCE = 0.95;

export function clampConfidence(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_CONFIDENCE, Math.max(0, Math.round(v * 1000) / 1000));
}

/**
 * Validation gate used by the API layer. Rejects output shaped like
 * "The root cause is X." — the single-assertion failure mode this project
 * exists to prevent.
 */
export function assertMultiHypothesis(set: HypothesisSet, minCount = 2): void {
  if (set.hypotheses.length < minCount) {
    throw new Error(
      `Evidence-based AI violation: expected >= ${minCount} competing hypotheses, got ${set.hypotheses.length}`
    );
  }
  for (const h of set.hypotheses) {
    if (!Array.isArray(h.missingEvidence)) {
      throw new Error(`Hypothesis "${h.statement}" is missing the missingEvidence field`);
    }
    if (!Array.isArray(h.contradictingEvidence)) {
      throw new Error(`Hypothesis "${h.statement}" is missing the contradictingEvidence field`);
    }
    if (h.confidence >= 1) {
      throw new Error(`Hypothesis "${h.statement}" claims confidence 1.0 — not calibratable`);
    }
  }
}

export function leadingHypothesis(set: HypothesisSet): Hypothesis | null {
  if (!set.leadingId) return null;
  return set.hypotheses.find((h) => h.hypothesisId === set.leadingId) ?? null;
}
