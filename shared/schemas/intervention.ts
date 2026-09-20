/**
 * Intervention + Experiment contracts.
 *
 * MVP safety rule: the AI proposes, a human approves, then a *whitelisted*
 * action runs. There is deliberately no "execute arbitrary plan" entry point —
 * `executor.ts` only renders checklists and todo lists.
 */

export const INTERVENTION_SCHEMA_VERSION = "1.0" as const;

export const INTERVENTION_KINDS = [
  "reduce_context_switch",
  "aggregate_resources",
  "unify_workspace",
  "reorganize_workflow",
  "reorder_task_sequence",
  "remove_steps",
  "other",
] as const;

export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export const INTERVENTION_LABELS: Record<InterventionKind, string> = {
  reduce_context_switch: "Reduce Context Switching",
  aggregate_resources: "Aggregate Frequently Used Resources",
  unify_workspace: "Create Unified Developer Workspace",
  reorganize_workflow: "Reorganize Workflow",
  reorder_task_sequence: "Recommend a Different Task Sequence",
  remove_steps: "Remove Unnecessary Steps",
  other: "Other",
};

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  required: true;
  status: ApprovalStatus;
  /** Who approved. MVP: "human". */
  by?: string;
  at?: string;
  note?: string;
}

/** A concrete, human-executable action. Never an arbitrary shell command. */
export interface InterventionStep {
  stepId: string;
  /** Imperative instruction shown in the UI. */
  instruction: string;
  /** Whitelisted action id, or "manual" when the human does it themselves. */
  action: string;
}

export interface Intervention {
  interventionId: string;
  sessionId: string;
  /** MUST reference an existing hypothesis — no orphan interventions. */
  hypothesisId: string;
  kind: InterventionKind;
  title: string;
  description: string;
  steps: InterventionStep[];
  /** Metric this is expected to move, e.g. "switchRatePerMin". */
  targetMetric: string;
  /** Prior belief about effect size, 0..1 (used only for reporting). */
  expectedEffect: string;
  approval: Approval;
  createdAt: string;
  schemaVersion: typeof INTERVENTION_SCHEMA_VERSION;
}

export const EXPERIMENT_SCHEMA_VERSION = "1.0" as const;

export interface TimeWindow {
  start: string;
  end: string;
}

export interface Experiment {
  experimentId: string;
  sessionId: string;
  interventionId: string;
  hypothesisId: string;
  /** Observation window used to establish the baseline. */
  preWindow: TimeWindow;
  /** Observation window collected AFTER the intervention. */
  postWindow: TimeWindow;
  /** Baseline metrics snapshot — frozen at plan time. */
  baselineValue: number;
  metric: string;
  status: "planned" | "running" | "completed" | "aborted";
  createdAt: string;
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
}

/** Minimum samples before a verdict may claim SUPPORTED. */
export const MIN_EXPERIMENT_SAMPLES = 8;

/** Effect-size thresholds (percentage change in the target metric). */
export const VERDICT_THRESHOLDS = {
  /** >= 20% improvement → SUPPORTED */
  supportedPct: 20,
  /** >= 20% worsening → REJECTED */
  rejectedPct: 20,
  /** within ±8% → INCONCLUSIVE (noise band) */
  noiseBandPct: 8,
} as const;
