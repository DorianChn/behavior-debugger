/**
 * Task + Goal contracts. A Task is what the user SAYS they are doing;
 * it is the reference point intervention tries to optimize against.
 */

export const TASK_SCHEMA_VERSION = "1.0" as const;

export interface Task {
  taskId: string;
  sessionId: string;
  title: string;
  /** What the user wants to achieve, in their words. */
  goal: string;
  /** Declared at session start; may be refined by `task_declared` events. */
  declaredAt: string;
  status: "active" | "paused" | "completed" | "abandoned";
  /** Optional success criteria the user typed in. */
  successCriteria?: string[];
  schemaVersion: typeof TASK_SCHEMA_VERSION;
}

/** Everything the API returns for one debugging session (the demo payload). */
export interface SessionDebugView {
  sessionId: string;
  task: Task | null;
  state: import("./task-state.js").TaskState;
  behavior: import("./behavior.js").BehaviorRepresentation | null;
  hypothesisSet: import("./hypothesis.js").HypothesisSet | null;
  sufficiency: import("./task-state.js").SufficiencyReport | null;
  intervention: import("./intervention.js").Intervention | null;
  experiment: import("./intervention.js").Experiment | null;
  verification: import("./verification.js").Verification | null;
}
