/**
 * Intervention planner — hypothesis → proposed action.
 *
 * The catalogue maps a cause to concrete, HUMAN-EXECUTABLE steps. There is no
 * "run this shell command" step type on purpose: `executor.ts` only renders
 * checklists. That is the MVP safety contract from the spec ("AI Recommendation
 * → User Approval → Execute") reduced to the only form we can ship safely in a
 * hackathon timeframe.
 */

import type { Hypothesis, HypothesisSet } from "../shared/schemas/hypothesis.js";
import {
  INTERVENTION_LABELS,
  INTERVENTION_SCHEMA_VERSION,
  type Intervention,
  type InterventionKind,
  type InterventionStep,
} from "../shared/schemas/intervention.js";
import type { BehaviorRepresentation } from "../shared/schemas/behavior.js";
import { shortId, counterId } from "../shared/utils/ids.js";

export interface InterventionContext {
  sessionId: string;
  hypothesisSet: HypothesisSet;
  behavior: BehaviorRepresentation;
}

interface Recipe {
  statement: string;
  kind: InterventionKind;
  title: string;
  description: string;
  targetMetric: string;
  expectedEffect: string;
  steps: string[];
}

/** Cause → intervention. Adding a hypothesis means adding a recipe here. */
export const RECIPES: Recipe[] = [
  {
    statement: "Documentation Fragmentation",
    kind: "aggregate_resources",
    title: "Aggregate Frequently Used Documentation",
    description:
      "Pin the documentation sources that actually answered questions into one place so each lookup stops costing a context switch.",
    targetMetric: "switchRatePerMin",
    expectedEffect: "Fewer documentation round-trips per question",
    steps: [
      "List the documentation sources visited more than once this session",
      "Create one reference document with direct links to those sources",
      "Keep that document open in a pinned tab for the session",
      "Record which lookups still required a full search, and add them to the list",
    ],
  },
  {
    statement: "Unclear Task Definition",
    kind: "reorganize_workflow",
    title: "Write a One-Sentence Definition of Done",
    description:
      "Under-specified goals cause exploration to reopen repeatedly. A testable completion condition lets the session actually close.",
    targetMetric: "longestFocusMs",
    expectedEffect: "Longer uninterrupted work blocks",
    steps: [
      "Write the task goal in one sentence",
      "Write the check that proves it is finished (a test, a build, a review)",
      "Post both where they stay visible for the whole session",
      "When switching, ask whether the switch serves that one sentence",
    ],
  },
  {
    statement: "Frequent Context Switching",
    kind: "unify_workspace",
    title: "Create a Unified Developer Workspace",
    description:
      "Scattered tabs and resources invite switching. Consolidating them removes the re-orientation cost per interruption.",
    targetMetric: "switchRatePerMin",
    expectedEffect: "Lower switches per minute over the next window",
    steps: [
      "Group the tabs used by this task into one window",
      "Close tabs unrelated to the current task",
      "Move the editor and the reference documentation side by side",
      "Handle incoming messages in one batched pass instead of per-notification",
    ],
  },
  {
    statement: "Undefined Success Criteria",
    kind: "remove_steps",
    title: "Remove Steps That Do Not Serve Completion",
    description:
      "Work that cannot be declared done tends to accumulate optional steps. Pruning them shortens the loop back to the goal.",
    targetMetric: "switchRatePerMin",
    expectedEffect: "Shorter path from question to decision",
    steps: [
      "List the actions taken this session that produced no lasting artifact",
      "Drop or defer the ones that do not serve the completion check",
      "Re-run the session with only the remaining steps",
    ],
  },
];

export function recipeFor(statement: string): Recipe | null {
  return RECIPES.find((r) => r.statement === statement) ?? null;
}

function stepsOf(recipe: Recipe): InterventionStep[] {
  return recipe.steps.map((instruction, i) => ({
    stepId: counterId("step", i + 1),
    instruction,
    action: "manual",
  }));
}

/** Pick the intervention for the current leading hypothesis. */
export function planIntervention(ctx: InterventionContext): Intervention {
  const lead = ctx.hypothesisSet.hypotheses.find((h) => h.hypothesisId === ctx.hypothesisSet.leadingId)
    ?? ctx.hypothesisSet.hypotheses[0];

  if (!lead) throw new Error("Cannot plan an intervention without a hypothesis");

  const recipe = recipeFor(lead.statement) ?? fallbackRecipe(lead);
  const now = new Date().toISOString();

  return {
    interventionId: shortId("intv"),
    sessionId: ctx.sessionId,
    hypothesisId: lead.hypothesisId,
    kind: recipe.kind,
    title: recipe.title,
    description: recipe.description,
    steps: stepsOf(recipe),
    targetMetric: recipe.targetMetric,
    expectedEffect: recipe.expectedEffect,
    approval: { required: true, status: "pending" },
    createdAt: now,
    schemaVersion: INTERVENTION_SCHEMA_VERSION,
  };
}

/**
 * When a hypothesis has no recipe we still return something honest: a
 * diagnostic step rather than a fake fix.
 */
function fallbackRecipe(h: Hypothesis): Recipe {
  return {
    statement: h.statement,
    kind: "other",
    title: `Investigate: ${h.statement}`,
    description:
      "No packaged intervention exists for this cause yet. Collect the missing evidence listed on the hypothesis before acting.",
    targetMetric: "switchRatePerMin",
    expectedEffect: "Closes an evidence gap rather than changing behavior",
    steps: [
      ...h.missingEvidence.slice(0, 3).map((m) => `Collect evidence: ${m}`),
      "Re-evaluate after the evidence is available",
    ],
  };
}

/**
 * Rank all recipes by how well they address the hypothesis set, so the UI can
 * offer alternatives rather than a single mandate.
 */
export function rankInterventions(ctx: InterventionContext): Array<{ recipe: Recipe; hypothesis: Hypothesis; score: number }> {
  const out: Array<{ recipe: Recipe; hypothesis: Hypothesis; score: number }> = [];
  for (const h of ctx.hypothesisSet.hypotheses) {
    const r = recipeFor(h.statement);
    if (!r) continue;
    out.push({ recipe: r, hypothesis: h, score: Math.round(h.confidence * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function describeIntervention(i: Intervention): string {
  return `${INTERVENTION_LABELS[i.kind]} — targets ${i.targetMetric} (approval: ${i.approval.status})`;
}

export { INTERVENTION_LABELS };
