/**
 * Runtime validation for the frozen contracts.
 *
 * Deliberately a tiny hand-rolled checker instead of a dependency: the whole
 * point of Phase 0 is that all three branches agree on shapes, and a 120-line
 * validator is cheaper to review than a schema library. Zero runtime deps in
 * `shared/` is a hard rule (see docs/architecture.md).
 */

import { RawEventJsonSchema, isEventType, type RawEvent } from "./event.js";
import { BEHAVIOR_KINDS, type BehaviorRepresentation } from "./behavior.js";
import { HYPOTHESIS_STATES, type Hypothesis, type HypothesisSet } from "./hypothesis.js";
import { DEBUGGER_PHASES, SUFFICIENCY_STATUSES, type SufficiencyReport, type TaskState } from "./task-state.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class SchemaError extends Error {
  readonly issues: ValidationIssue[];
  constructor(label: string, issues: ValidationIssue[]) {
    super(`${label} failed validation: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
    this.name = "SchemaError";
    this.issues = issues;
  }
}

function isIso(s: unknown): boolean {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates a RawEvent including the additionalProperties:false rule. */
export function validateRawEvent(input: unknown): RawEvent {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) throw new SchemaError("RawEvent", [{ path: "$", message: "must be an object" }]);

  for (const k of Object.keys(input)) {
    if (!(k in RawEventJsonSchema.properties)) {
      issues.push({ path: k, message: "is not allowed by the RawEvent schema" });
    }
  }
  if (typeof input.eventId !== "string" || input.eventId.length === 0) {
    issues.push({ path: "eventId", message: "must be a non-empty string" });
  }
  if (!isIso(input.timestamp)) issues.push({ path: "timestamp", message: "must be an ISO 8601 timestamp" });
  if (!isEventType(input.eventType)) {
    issues.push({ path: "eventType", message: `must be one of ${RawEventJsonSchema.properties.eventType.enum.join("|")}` });
  }
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    issues.push({ path: "sessionId", message: "must be a non-empty string" });
  }
  if (input.durationMs !== undefined && (typeof input.durationMs !== "number" || input.durationMs < 0)) {
    issues.push({ path: "durationMs", message: "must be a number >= 0" });
  }
  if (input.schemaVersion !== "1.0") {
    issues.push({ path: "schemaVersion", message: 'must be "1.0"' });
  }
  if (issues.length) throw new SchemaError("RawEvent", issues);
  return input as unknown as RawEvent;
}

export function validateSufficiencyReport(r: SufficiencyReport): SufficiencyReport {
  const issues: ValidationIssue[] = [];
  if (!SUFFICIENCY_STATUSES.includes(r.status)) {
    issues.push({ path: "status", message: `must be one of ${SUFFICIENCY_STATUSES.join("|")}` });
  }
  if (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1) {
    issues.push({ path: "confidence", message: "must be a number in [0,1]" });
  }
  // The rule that makes Deferred Intelligence un-fakeable:
  if (r.status === "WAIT") {
    if (r.missingInformation.length === 0) {
      issues.push({ path: "missingInformation", message: "WAIT requires a non-empty missingInformation list" });
    }
    if (!r.nextObservation) {
      issues.push({ path: "nextObservation", message: "WAIT requires a concrete nextObservation plan" });
    } else if (!(r.nextObservation.durationMinutes > 0)) {
      issues.push({ path: "nextObservation.durationMinutes", message: "must be > 0" });
    }
  }
  if (r.status === "READY" && !r.reason) {
    issues.push({ path: "reason", message: "READY requires a reason" });
  }
  // The optional evidence ladder, when present, must be self-consistent.
  if (r.checks !== undefined) {
    if (!Array.isArray(r.checks)) {
      issues.push({ path: "checks", message: "must be an array when present" });
    } else {
      for (const [i, c] of r.checks.entries()) {
        if (typeof c.score !== "number" || c.score < 0 || c.score > 1) {
          issues.push({ path: `checks[${i}].score`, message: "must be a number in [0,1]" });
        }
        if (typeof c.weight !== "number" || c.weight < 0 || c.weight > 1) {
          issues.push({ path: `checks[${i}].weight`, message: "must be a number in [0,1]" });
        }
        if (c.ok === false && !c.missing) {
          issues.push({ path: `checks[${i}].missing`, message: "a failed check must explain what is missing" });
        }
      }
    }
  }
  if (issues.length) throw new SchemaError("SufficiencyReport", issues);
  return r;
}

export function validateTaskState(s: TaskState): TaskState {
  const issues: ValidationIssue[] = [];
  if (!DEBUGGER_PHASES.includes(s.phase)) {
    issues.push({ path: "phase", message: `must be one of ${DEBUGGER_PHASES.join("|")}` });
  }
  if (s.phase === "WAITING") {
    if (!isIso(s.waitUntil)) {
      issues.push({ path: "waitUntil", message: "WAITING requires an ISO waitUntil timestamp" });
    }
  }
  if (s.sufficiency) {
    try {
      validateSufficiencyReport(s.sufficiency);
    } catch (err) {
      for (const i of (err as SchemaError).issues) {
        issues.push({ path: `sufficiency.${i.path}`, message: i.message });
      }
    }
  }
  if (s.phase !== "WAITING" && s.waitUntil !== undefined) {
    issues.push({ path: "waitUntil", message: "must be cleared outside WAITING" });
  }
  if (issues.length) throw new SchemaError("TaskState", issues);
  return s;
}

export function validateBehaviorRepresentation(b: BehaviorRepresentation): BehaviorRepresentation {
  const issues: ValidationIssue[] = [];
  for (const [i, seg] of b.segments.entries()) {
    if (!BEHAVIOR_KINDS.includes(seg.kind)) {
      issues.push({ path: `segments[${i}].kind`, message: `unknown behavior kind "${seg.kind}"` });
    }
    if (seg.eventIds.length === 0) {
      issues.push({ path: `segments[${i}].eventIds`, message: "segment must cite at least one raw event" });
    }
    if (seg.confidence < 0 || seg.confidence > 1) {
      issues.push({ path: `segments[${i}].confidence`, message: "must be in [0,1]" });
    }
  }
  if (issues.length) throw new SchemaError("BehaviorRepresentation", issues);
  return b;
}

export function validateHypothesisSet(set: HypothesisSet): HypothesisSet {
  const issues: ValidationIssue[] = [];
  if (set.hypotheses.length < 2) {
    issues.push({ path: "hypotheses", message: "must contain at least 2 competing hypotheses" });
  }
  const ids = new Set<string>();
  for (const [i, h] of set.hypotheses.entries()) {
    if (ids.has(h.hypothesisId)) issues.push({ path: `hypotheses[${i}].hypothesisId`, message: "duplicate id" });
    ids.add(h.hypothesisId);
    if (!HYPOTHESIS_STATES.includes(h.state)) {
      issues.push({ path: `hypotheses[${i}].state`, message: `unknown state "${h.state}"` });
    }
    if (!Array.isArray(h.missingEvidence)) {
      issues.push({ path: `hypotheses[${i}].missingEvidence`, message: "required" });
    }
    if (!Array.isArray(h.contradictingEvidence)) {
      issues.push({ path: `hypotheses[${i}].contradictingEvidence`, message: "required" });
    }
    if (h.confidence >= 1) {
      issues.push({ path: `hypotheses[${i}].confidence`, message: "must be < 1" });
    }
  }
  if (set.leadingId && !ids.has(set.leadingId)) {
    issues.push({ path: "leadingId", message: "does not reference a hypothesis in the set" });
  }
  if (issues.length) throw new SchemaError("HypothesisSet", issues);
  return set;
}
