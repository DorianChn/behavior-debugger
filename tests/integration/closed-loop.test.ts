/**
 * Integration test: the complete closed loop.
 *
 * Proves the product claim end to end:
 *   observe → sufficient evidence → WAIT (with a real timer) → re-evaluate →
 *   diagnose competing hypotheses → propose → human approves → verify with
 *   observed data → learn
 *
 * Also covers the things that are easy to get subtly wrong: session isolation,
 * approval gating, and the honesty of the verdict.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BEHAVIOR_DEBUGGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bd-int-"));

const { ingest } = await import("../../collector/src/ingest.js");
const store = await import("../../database/store.js");
const { bootstrap, buildSessionView, createTask, proposeIntervention, approveIntervention, runVerification } =
  await import("../../service.js");
const { evaluateSession } = await import("../../reasoning/engine.js");
const { buildSession, BASELINE_PROFILE, IMPROVED_PROFILE, SPARSE_PROFILE } = await import(
  "../../collector/src/adapters/synthetic.js"
);
const { executeIntervention, ApprovalRequiredError } = await import("../../intervention/executor.js");
const { assertMultiHypothesis } = await import("../../shared/schemas/hypothesis.js");
const { validateTaskState } = await import("../../shared/schemas/validate.js");

bootstrap({ ingest, store });

/** Assert-and-narrow helpers so the test body reads as intent, not null checks. */
function need<T>(v: T | null | undefined, what: string): T {
  assert.ok(v != null, `expected ${what} to be present`);
  return v as T;
}

let n = 0;
function freshSessionId(tag: string): string {
  return `${tag}_${++n}_${Math.random().toString(36).slice(2, 8)}`;
}

function load(id: string, profile: typeof BASELINE_PROFILE, sessionId: string) {
  const events = buildSession({ ...profile, sessionId });
  return ingest({ sessionId, events, batchId: `${sessionId}_${profile.minutes}_${events.length}` });
}

describe("closed loop", () => {
  test("thin evidence → WAITING with a persisted deadline", () => {
    const id = freshSessionId("sparse");
    load(id, SPARSE_PROFILE, id);

    const outcome = evaluateSession(id);
    assert.equal(outcome.state.phase, "WAITING");
    assert.ok(outcome.state.waitUntil, "WAITING must persist a wake time");
    assert.ok(outcome.sufficiency.missingInformation.length > 0);
    assert.ok(Date.parse(outcome.state.waitUntil) > Date.now(), "deadline must be in the future");
    assert.equal(outcome.diagnosed, false, "must not diagnose on thin evidence");

    // And the deadline survives a restart, because it lives in the store.
    const reloaded = need(store.loadTaskState(id), "persisted task state");
    assert.equal(reloaded.phase, "WAITING");
    assert.equal(reloaded.waitUntil, outcome.state.waitUntil);
  });

  test("sufficient evidence → READY → at least two competing hypotheses", () => {
    const id = freshSessionId("full");
    load(id, BASELINE_PROFILE, id);
    const outcome = evaluateSession(id);

    // READY is traversed inside this call, then the machine advances to
    // DIAGNOSING because the hypotheses are produced right here. Both facts
    // are reported, so neither is a hidden side effect.
    assert.equal(outcome.state.phase, "DIAGNOSING", outcome.headline);
    assert.ok(outcome.reachedReady, "the evidence gate should have passed through READY");
    assert.ok(outcome.diagnosed, "READY should trigger diagnosis");
    const set = need(outcome.hypothesisSet, "hypothesis set");
    // ★ The core promise: never a single root cause.
    assert.ok(set.hypotheses.length >= 2);
    assertMultiHypothesis(set, 2);

    for (const h of set.hypotheses) {
      assert.ok(Array.isArray(h.missingEvidence), "every hypothesis must state what it is missing");
      assert.ok(Array.isArray(h.contradictingEvidence));
      assert.ok(h.confidence < 1, "confidence 1.0 would be a lie");
      assert.ok(h.confidence >= 0);
    }
    // The leading hypothesis must be backed by real event ids.
    const lead = set.hypotheses.find((h) => h.hypothesisId === set.leadingId);
    assert.ok(lead);
    assert.ok(lead.supportingEvidence.length > 0 || lead.confidence <= 0.3);
  });

  test("full journey: diagnose → approve → verify → LEARNED", async () => {
    const id = freshSessionId("journey");
    createTask(id, "Ship the auth refactor", ["tests pass", "PR merged"]);

    load(id, BASELINE_PROFILE, id);
    const evaluated = evaluateSession(id);
    assert.equal(evaluated.state.phase, "DIAGNOSING", evaluated.headline);
    assert.ok(evaluated.reachedReady);

    // Baseline metrics must match the spec's scenario: 21 switches / 30 min.
    assert.equal(evaluated.behavior.metrics.switchCount, 21, "baseline should reproduce 21 switches");
    assert.equal(evaluated.behavior.windowMinutes, 30);

    const proposed = await proposeIntervention(id);
    assert.equal(proposed.view.state.phase, "INTERVENING");
    const intervention = need(proposed.view.intervention, "proposed intervention");
    assert.equal(intervention.approval.status, "pending");
    assert.ok(intervention.targetMetric, "intervention must name a target metric");

    // An unapproved intervention cannot be executed.
    assert.throws(() => executeIntervention(intervention), ApprovalRequiredError);

    // Approving without naming a human is refused.
    assert.throws(() => approveIntervention(id, { acknowledgedBy: "   " }), /non-empty human identifier/);

    const approved = approveIntervention(id, { acknowledgedBy: "human" });
    assert.equal(approved.view.state.phase, "VERIFYING");
    const approvedIntervention = need(approved.view.intervention, "approved intervention");
    assert.equal(approvedIntervention.approval.status, "approved");
    assert.equal(approvedIntervention.approval.by, "human");
    assert.ok(approved.execution.markdown.includes("- [ ]"), "execution must be a checklist");
    const experiment = need(approved.view.experiment, "experiment");

    // The baseline is frozen at plan time, not recomputed later.
    assert.equal(experiment.baselineValue, evaluated.behavior.metrics.switchRatePerMin);

    // Now the improved post-window arrives (8 switches / 30 min).
    load(id, { ...IMPROVED_PROFILE, sessionId: id, startedAt: "2026-09-20T11:00:00.000Z" }, id);

    const verified = await runVerification(id, { comparisonMinutes: 30 });
    const v = need(verified.view.verification, "verification");

    assert.equal(v.result, "SUPPORTED", `expected SUPPORTED, got ${v.result}: ${v.reason}`);
    assert.ok(v.comparison.deltaPct > 50, `expected a large improvement, got ${v.comparison.deltaPct}%`);
    assert.equal(v.comparison.windowMinutesBefore, v.comparison.windowMinutesAfter, "windows must be equal length");
    assert.ok(v.eventIdsBefore.length > 0 && v.eventIdsAfter.length > 0, "verdict must cite observed events");
    // The reason must quote the numbers, not an opinion.
    assert.match(v.reason, /\d/);
    assert.equal(verified.view.state.phase, "LEARNED");

    // Learning is persisted.
    const memory = store.readMemory(id);
    assert.equal(memory.length, 1);
    assert.equal(memory[0].result, "SUPPORTED");
  });

  test("sessions are fully isolated", () => {
    const a = freshSessionId("isoA");
    const b = freshSessionId("isoB");

    load(a, SPARSE_PROFILE, a);
    load(b, BASELINE_PROFILE, b);

    const evalA = evaluateSession(a);
    const evalB = evaluateSession(b);

    assert.equal(evalA.state.phase, "WAITING", evalA.headline);
    assert.equal(evalB.state.phase, "DIAGNOSING", evalB.headline);

    // A's parked state must not leak into B.
    assert.equal(need(store.loadTaskState(b), "B state").phase, "DIAGNOSING");
    assert.equal(need(store.loadTaskState(a), "A state").waitUntil !== undefined, true);
    assert.equal(need(store.loadTaskState(b), "B state").waitUntil, undefined);

    // Events and hypotheses stay scoped too.
    assert.equal(store.readEventsForSession(a).every((e) => e.sessionId === a), true);
    assert.equal(store.readEventsForSession(b).every((e) => e.sessionId === b), true);
    // B reached diagnosis, so it has hypotheses; A is still parked and must not.
    assert.equal(store.loadHypothesisSet(a), null, "a WAITING session must not have hypotheses");
    assert.equal(need(store.loadHypothesisSet(b), "B hypotheses").sessionId, b);
    assert.equal(store.readMemory(a).length, 0);
    assert.equal(store.loadVerification(a), null, "A's quarantine/wait must not be affected by B");
  });
});

describe("verification honesty", () => {
  test("a tiny change is INCONCLUSIVE, not a victory", async () => {
    const id = freshSessionId("noise");
    load(id, BASELINE_PROFILE, id);
    evaluateSession(id);
    await proposeIntervention(id);
    approveIntervention(id, { acknowledgedBy: "human" });

    // Practically the same behavior after the change.
    load(id, { ...BASELINE_PROFILE, sessionId: id, startedAt: "2026-09-20T11:00:00.000Z", switchesPerMinute: 0.7 }, id);

    const out = await runVerification(id, { comparisonMinutes: 30 });
    const v = need(out.view.verification, "verification");
    assert.ok(
      ["INCONCLUSIVE", "WEAKENED"].includes(v.result),
      `got ${v.result}: ${v.reason}`
    );
    assert.notEqual(v.result, "SUPPORTED");
    assert.equal(store.readMemory(id).length, 0, "an unsupported result must not be written to memory");
  });

  test("a regression is REJECTED and loops back to re-evaluation", async () => {
    const id = freshSessionId("regress");
    load(id, BASELINE_PROFILE, id);
    evaluateSession(id);
    await proposeIntervention(id);
    approveIntervention(id, { acknowledgedBy: "human" });

    // Worse than baseline: many more switches.
    load(id, { ...BASELINE_PROFILE, sessionId: id, startedAt: "2026-09-20T11:00:00.000Z", switchesPerMinute: 2.2 }, id);

    const out = await runVerification(id, { comparisonMinutes: 30 });
    const v = need(out.view.verification, "verification");
    assert.equal(v.result, "REJECTED", v.reason);
    assert.equal(out.view.state.phase, "RE_EVALUATING", "a rejected hypothesis must send us back to reasoning");
  });

  test("too few samples cannot produce a verdict", async () => {
    const id = freshSessionId("thin");
    load(id, BASELINE_PROFILE, id);
    evaluateSession(id);
    await proposeIntervention(id);
    approveIntervention(id, { acknowledgedBy: "human" });

    const out = await runVerification(id, { comparisonMinutes: 1 });
    const v = need(out.view.verification, "verification");
    assert.equal(v.result, "INCONCLUSIVE");
    assert.match(v.reason, /at least \d+ events|0 in both/);
  });

  /**
   * Regression: a stray late event must not invent a post-intervention window.
   *
   * The approval audit trail writes an event at approval time, hours after the
   * real observation period ended. The verifier used to anchor the post window
   * to the LAST event, producing a window containing three events bunched into
   * a few milliseconds — which read as a ~99% improvement that never happened.
   * The honest answer when no post-intervention observation exists is a
   * contiguous split, and INCONCLUSIVE when that split is thin.
   */
  test("a stray late event cannot fabricate a post-intervention improvement", async () => {
    const id = freshSessionId("stray");
    load(id, BASELINE_PROFILE, id);
    const first = evaluateSession(id);

    // A plausible baseline rate, measured over the real observation window.
    const baselineRate = need(first.behavior.metrics, "baseline metrics").switchRatePerMin;
    assert.ok(baselineRate > 0 && baselineRate < 10, `baseline rate should be sane, got ${baselineRate}`);

    await proposeIntervention(id);
    approveIntervention(id, { acknowledgedBy: "human" });

    // One stray event, long after the observation period closed.
    ingest({
      sessionId: id,
      batchId: `stray_${id}`,
      events: [
        {
          eventId: `stray_${id}`,
          sessionId: id,
          timestamp: new Date(Date.now() + 3 * 3600_000).toISOString(),
          eventType: "page_switch",
          source: "late.example.com",
          target: "later.example.com",
        } as never,
      ],
    });

    const out = await runVerification(id, { comparisonMinutes: 30 });
    const v = need(out.view.verification, "verification");
    const c = v.comparison;

    // The verdict is what matters: an empty post window can never be a win.
    assert.equal(
      v.result,
      "INCONCLUSIVE",
      `a session with no post-intervention data must not produce a verdict, got ${v.result} (${c.before} → ${c.after})`
    );
    // The baseline side must quote the real observation period, not a sliver.
    assert.ok(
      c.before < 10,
      `the "before" rate must reflect the real observation period, not a handful of stray events — got ${c.before}`
    );
    assert.ok(
      c.sampleSizeBefore >= 8,
      `the baseline window must retain its real sample, got ${c.sampleSizeBefore}`
    );
    // And the two windows must not share events.
    assert.equal(c.sampleSizeAfter, 0, `nothing was observed after the baseline, got ${c.sampleSizeAfter}`);
    const before = new Set(v.eventIdsBefore);
    assert.equal(
      v.eventIdsAfter.some((id) => before.has(id)),
      false,
      "pre and post windows must be disjoint — an event cannot be counted on both sides"
    );
  });
});

describe("contract enforcement", () => {
  test("persisted task state always satisfies the frozen schema", () => {
    const id = freshSessionId("schema");
    load(id, BASELINE_PROFILE, id);
    evaluateSession(id);
    const state = need(store.loadTaskState(id), "persisted task state");
    assert.doesNotThrow(() => validateTaskState(state));
  });

  test("a persisted WAITING state cannot exist without a deadline", () => {
    const id = freshSessionId("deadline");
    load(id, SPARSE_PROFILE, id);
    const out = evaluateSession(id);
    if (out.state.phase === "WAITING") {
      assert.doesNotThrow(() => validateTaskState(out.state), "WAITING without waitUntil must be rejected");
      const broken = { ...out.state };
      delete broken.waitUntil;
      assert.throws(() => validateTaskState(broken), /waitUntil/);
    }
  });

  test("ingest is idempotent on batchId", () => {
    const id = freshSessionId("idem");
    const events = buildSession({ ...BASELINE_PROFILE, sessionId: id });
    const first = ingest({ sessionId: id, events, batchId: `fixed_${id}` });
    const second = ingest({ sessionId: id, events, batchId: `fixed_${id}` });
    assert.equal(first.accepted, events.length);
    assert.equal(second.accepted, 0, "a replayed batch must not be double-counted");
    assert.equal(store.readEventsForSession(id).length, events.length);
  });

  test("malformed events are rejected without losing the valid ones", () => {
    const id = freshSessionId("bad");
    const good = buildSession({ ...BASELINE_PROFILE, sessionId: id });
    const result = ingest({
      sessionId: id,
      events: [...good, { eventId: "x", timestamp: "not-a-date", eventType: "nope", sessionId: id } as never],
    });
    assert.equal(result.accepted, good.length, "valid events must still land");
    assert.ok(result.issues.length >= 1, "the bad event must be reported");
    // Every issue is attributed to the offending event, not to the batch.
    assert.ok(result.issues.every((i) => i.eventId === "x" || i.eventId === undefined));
    // And nothing malformed reached the immutable log.
    const stored = store.readEventsForSession(id);
    assert.equal(stored.length, good.length);
    assert.ok(stored.every((e) => e.schemaVersion === "1.0"));
  });

  test("buildSessionView always returns a usable payload, even for an unknown session", () => {
    const view = buildSessionView("never_seen_before");
    assert.equal(view.sessionId, "never_seen_before");
    assert.equal(view.state.phase, "OBSERVING");
    assert.equal(view.behavior, null);
    assert.equal(view.hypothesisSet, null);
  });
});
