/**
 * Verification contract.
 *
 * The verdict is computed from observed numbers only. An LLM may be used to
 * phrase `reason`, but it may never choose `result` — `judge.ts` decides that
 * arithmetically, and `INCONCLUSIVE` is a first-class outcome for thin samples.
 */

import type { VerificationResult } from "./task-state.js";

export const VERIFICATION_SCHEMA_VERSION = "1.0" as const;

export interface MetricComparison {
  metric: string;
  /** Value measured before the intervention. */
  before: number;
  /** Value measured after the intervention. */
  after: number;
  /** (before - after) / before * 100. Positive means improvement. */
  deltaPct: number;
  sampleSizeBefore: number;
  sampleSizeAfter: number;
  /** Window each side was measured over, in minutes — must match to compare. */
  windowMinutesBefore: number;
  windowMinutesAfter: number;
}

export interface Verification {
  verificationId: string;
  sessionId: string;
  experimentId: string;
  hypothesisId: string;
  interventionId: string;
  comparison: MetricComparison;
  result: VerificationResult;
  /** Machine-generated explanation citing the observed numbers. */
  reason: string;
  /** Raw event ids from both windows, so the verdict is auditable. */
  eventIdsBefore: string[];
  eventIdsAfter: string[];
  verifiedAt: string;
  schemaVersion: typeof VERIFICATION_SCHEMA_VERSION;
}

/** Memory entry written when a verification reaches a verdict. */
export interface MemoryRecord {
  memoryId: string;
  sessionId: string;
  hypothesisId: string;
  interventionId: string;
  result: VerificationResult;
  /** Distilled lesson, e.g. "workspace unification reduced switching". */
  lesson: string;
  deltaPct: number;
  metric: string;
  createdAt: string;
}

export interface VerificationDraft {
  metric: string;
  before: number;
  after: number;
  sampleSizeBefore: number;
  sampleSizeAfter: number;
  windowMinutesBefore: number;
  windowMinutesAfter: number;
}

export function pctChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : -100;
  return Math.round(((before - after) / before) * 1000) / 10;
}

export function buildComparison(d: VerificationDraft): MetricComparison {
  return {
    metric: d.metric,
    before: d.before,
    after: d.after,
    deltaPct: pctChange(d.before, d.after),
    sampleSizeBefore: d.sampleSizeBefore,
    sampleSizeAfter: d.sampleSizeAfter,
    windowMinutesBefore: d.windowMinutesBefore,
    windowMinutesAfter: d.windowMinutesAfter,
  };
}
