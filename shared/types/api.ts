/**
 * Cross-module DTOs. These are what the API layer actually returns, so the
 * frontend never reaches into module internals.
 */

import type { RawEvent } from "../schemas/event.js";
import type { BehaviorRepresentation } from "../schemas/behavior.js";
import type { HypothesisSet } from "../schemas/hypothesis.js";
import type { TaskState, SufficiencyReport, DebuggerPhase } from "../schemas/task-state.js";
import type { Intervention, Experiment } from "../schemas/intervention.js";
import type { Verification } from "../schemas/verification.js";
import type { SessionDebugView } from "../schemas/task.js";

/** One step of the demo timeline shown in the UI. */
export interface TimelineEntry {
  at: string;
  phase: DebuggerPhase;
  label: string;
  detail: string;
}

/** The single payload the dashboard polls. */
export interface DashboardSnapshot {
  sessionId: string;
  generatedAt: string;
  view: SessionDebugView;
  timeline: TimelineEntry[];
  /** Events behind the current window — needed to render the raw timeline. */
  events: RawEvent[];
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  issues: Array<{ eventId?: string; path: string; message: string }>;
  sessionId: string;
  totalForSession: number;
}

export interface EvaluateResult {
  state: TaskState;
  sufficiency: SufficiencyReport;
  behavior: BehaviorRepresentation;
  hypothesisSet: HypothesisSet | null;
}

export interface ApproveResult {
  state: TaskState;
  intervention: Intervention;
  experiment: Experiment;
  verification: Verification | null;
}

export type {
  RawEvent,
  BehaviorRepresentation,
  HypothesisSet,
  TaskState,
  SufficiencyReport,
  Intervention,
  Experiment,
  Verification,
  SessionDebugView,
};
