/**
 * Unit tests for the Deferred Intelligence state machine.
 *
 * These are the tests that make Principle 4 enforceable: if someone later
 * "simplifies" WAIT into an if-statement that returns a sentence, these fail.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { initialState, transition, IllegalTransitionError, VALID_EVENTS, TRANSITIONS } = await import(
  "../../reasoning/state-machine.js"
);
const { evaluateSufficiency } = await import("../../reasoning/sufficiency.js");
const { buildBehaviorRepresentation } = await import("../../behavior/engine.js");
const { buildSession, BASELINE_PROFILE, SPARSE_PROFILE } = await import(
  "../../collector/src/adapters/synthetic.js"
);
const { isDue, STATE_MACHINE_LIMITS } = await import("../../shared/schemas/task-state.js");
const { addMinutes } = await import("../../shared/utils/window.js");

const T0 = "2026-09-20T10:00:00.000Z";

function report(
  status: "INSUFFICIENT" | "WAIT" | "READY",
  missing: string[],
  minutes = 30
): import("../../shared/schemas/task-state.js").SufficiencyReport {
  return {
    sessionId: "s1",
    status,
    confidence: status === "READY" ? 0.85 : 0.4,
    missingInformation: missing,
    nextObservation:
      status === "WAIT" ? { action: "Continue observing", durationMinutes: minutes, targetMetrics: ["eventCount"] } : undefined,
    reason: status === "READY" ? "Enough behavioral evidence." : undefined,
    evaluatedAt: T0,
    cycle: 0,
  };
}

describe("state machine: nominal path", () => {
  test("starts in OBSERVING with no waitUntil", () => {
    const s = initialState("s1", "t1", T0);
    assert.equal(s.phase, "OBSERVING");
    assert.equal(s.waitUntil, undefined);
    assert.equal(s.reEvalCount, 0);
  });

  test("OBSERVING → INSUFFICIENT → WAITING sets a concrete wake time", () => {
    let s = initialState("s1", "t1", T0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    assert.equal(s.phase, "INSUFFICIENT");

    s = transition(s, { type: "INSUFFICIENT", at: T0, report: report("WAIT", ["More development-session data"], 30) });
    assert.equal(s.phase, "WAITING");
    // ★ The whole point: WAIT carries a real deadline, not a sentence.
    assert.equal(s.waitUntil, addMinutes(T0, 30));
    assert.equal(isDue(s, new Date(T0)), false, "should not be due at the moment it parked");
    assert.equal(isDue(s, new Date(addMinutes(T0, 30))), true, "should be due at the deadline");
  });

  test("WAIT_ELAPSED → RE_EVALUATING → WAITING loops while evidence is thin", () => {
    let s = initialState("s1", "t1", T0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    s = transition(s, { type: "INSUFFICIENT", at: T0, report: report("WAIT", ["gap"]) });
    s = transition(s, { type: "WAIT_ELAPSED", at: addMinutes(T0, 30) });
    assert.equal(s.phase, "RE_EVALUATING");

    s = transition(s, { type: "INSUFFICIENT", at: addMinutes(T0, 30), report: report("WAIT", ["gap"]) });
    assert.equal(s.phase, "WAITING");
    assert.equal(s.reEvalCount, 1, "re-evaluation must be counted");
  });

  test("RE_EVALUATING → READY when evidence becomes sufficient", () => {
    let s = initialState("s1", "t1", T0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    s = transition(s, { type: "INSUFFICIENT", at: T0, report: report("WAIT", ["gap"]) });
    s = transition(s, { type: "WAIT_ELAPSED", at: addMinutes(T0, 30) });
    s = transition(s, { type: "SUFFICIENT", at: addMinutes(T0, 31), report: report("READY", []) });
    assert.equal(s.phase, "READY");
    assert.equal(s.waitUntil, undefined, "waitUntil must be cleared when leaving WAITING");
    assert.equal(s.sufficiency?.status, "READY");
  });

  test("full happy path reaches LEARNED via intervention and verification", () => {
    let s = initialState("s1", "t1", T0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    s = transition(s, { type: "SUFFICIENT", at: T0, report: report("READY", []) });
    s = transition(s, { type: "DIAGNOSED", at: T0, hypothesisIds: ["h1", "h2"] });
    assert.equal(s.phase, "DIAGNOSING");
    s = transition(s, { type: "INTERVENTION_PROPOSED", at: T0, interventionId: "i1" });
    assert.equal(s.phase, "INTERVENING");
    s = transition(s, { type: "INTERVENTION_APPROVED", at: T0, experimentId: "e1" });
    assert.equal(s.phase, "VERIFYING");
    s = transition(s, { type: "VERIFICATION_COMPLETE", at: T0, result: "SUPPORTED" });
    assert.equal(s.phase, "LEARNED");
    assert.ok(s.learnedAt);
  });
});

describe("state machine: guards and limits", () => {
  test("illegal transitions throw instead of silently stalling", () => {
    const s = initialState("s1", "t1", T0);
    assert.throws(() => transition(s, { type: "INTERVENTION_APPROVED", at: T0, experimentId: "e" }), IllegalTransitionError);
    assert.throws(() => transition(s, { type: "VERIFICATION_COMPLETE", at: T0, result: "SUPPORTED" }), IllegalTransitionError);
  });

  test("LEARNED is terminal — only RESET escapes", () => {
    let s = initialState("s1", "t1", T0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    s = transition(s, { type: "SUFFICIENT", at: T0, report: report("READY", []) });
    s = transition(s, { type: "DIAGNOSED", at: T0, hypothesisIds: ["h1", "h2"] });
    s = transition(s, { type: "INTERVENTION_PROPOSED", at: T0, interventionId: "i1" });
    s = transition(s, { type: "INTERVENTION_APPROVED", at: T0, experimentId: "e1" });
    s = transition(s, { type: "VERIFICATION_COMPLETE", at: T0, result: "SUPPORTED" });

    assert.throws(() => transition(s, { type: "EVENTS_APPENDED", count: 5, at: T0 }), IllegalTransitionError);
    const reset = transition(s, { type: "RESET", at: T0 });
    assert.equal(reset.phase, "OBSERVING");
  });

  test("re-evaluation budget is bounded", () => {
    let s = initialState("s1", "t1", T0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    s = transition(s, { type: "INSUFFICIENT", at: T0, report: report("WAIT", ["gap"]) });
    s = transition(s, { type: "WAIT_ELAPSED", at: addMinutes(T0, 30) });

    for (let i = 0; i < STATE_MACHINE_LIMITS.maxReEvalCycles + 2; i++) {
      const out = transition(s, { type: "INSUFFICIENT", at: addMinutes(T0, 30 * (i + 2)), report: report("WAIT", ["gap"]) });
      s = out;
      if (s.phase === "RE_EVALUATING") break;
      s = transition(s, { type: "WAIT_ELAPSED", at: addMinutes(T0, 30 * (i + 3)) });
    }
    assert.equal(s.phase, "RE_EVALUATING", "must stop re-waiting once the budget is spent");
    assert.ok(s.reEvalCount >= STATE_MACHINE_LIMITS.maxReEvalCycles);

    // The escape hatch: a degraded READY, so the demo can always progress.
    const degraded = transition(s, { type: "MAX_CYCLES_REACHED", at: addMinutes(T0, 999) });
    assert.equal(degraded.phase, "READY");
    assert.match(degraded.sufficiency?.reason ?? "", /budget exhausted/i);
  });

  test("every phase has at least one legal event (no dead ends)", () => {
    for (const phase of Object.keys(VALID_EVENTS) as Array<keyof typeof VALID_EVENTS>) {
      assert.ok(VALID_EVENTS[phase].length > 0, `phase ${phase} has no legal transitions`);
    }
  });

  test("RESET is available from every phase — an operator can always unstick a session", () => {
    const phases = Object.keys(VALID_EVENTS) as Array<keyof typeof VALID_EVENTS>;
    for (const phase of phases) {
      assert.ok(
        VALID_EVENTS[phase].includes("RESET"),
        `phase ${phase} cannot be reset by an operator`
      );
    }
  });

  test("transition table only references phases that exist", () => {
    const phases = new Set<string>(Object.keys(VALID_EVENTS));
    for (const t of TRANSITIONS) {
      assert.ok(phases.has(t.from), `unknown from-phase ${t.from}`);
      assert.ok(phases.has(t.to), `unknown to-phase ${t.to}`);
    }
  });

  test("state machine is pure — the input object is never mutated", () => {
    const s = initialState("s1", "t1", T0);
    const snapshot = JSON.stringify(s);
    transition(s, { type: "EVENTS_APPENDED", count: 40, at: T0 });
    assert.equal(JSON.stringify(s), snapshot, "transition() mutated its input");
  });
});

describe("sufficiency judge", () => {
  test("a short session is judged WAIT with actionable missing evidence", () => {
    const events = buildSession(SPARSE_PROFILE);
    const behavior = buildBehaviorRepresentation(events);
    const r = evaluateSufficiency({ sessionId: SPARSE_PROFILE.sessionId, events, behavior, cycle: 0, at: T0 });

    assert.equal(r.status, "WAIT");
    assert.ok(r.missingInformation.length > 0, "WAIT must state what is missing");
    assert.ok(r.nextObservation, "WAIT must carry a next-observation plan");
    assert.ok(r.nextObservation.durationMinutes > 0);
    assert.ok(r.confidence < 0.7);
  });

  test("a full 30-minute session is judged READY", () => {
    const events = buildSession(BASELINE_PROFILE);
    const behavior = buildBehaviorRepresentation(events);
    const r = evaluateSufficiency({ sessionId: BASELINE_PROFILE.sessionId, events, behavior, cycle: 2, at: T0 });

    assert.equal(r.status, "READY");
    assert.equal(r.missingInformation.length, 0);
    assert.ok(r.reason, "READY must explain itself");
    assert.ok(r.confidence >= 0.7, `expected confidence >= 0.7, got ${r.confidence}`);
  });

  test("confidence rises monotonically as the sparse session grows", () => {
    const short = buildBehaviorRepresentation(buildSession({ ...SPARSE_PROFILE, minutes: 2 }));
    const medium = buildBehaviorRepresentation(buildSession({ ...SPARSE_PROFILE, minutes: 6 }));
    const long = buildBehaviorRepresentation(buildSession(BASELINE_PROFILE));

    const c = (
      b: import("../../shared/schemas/behavior.js").BehaviorRepresentation,
      e: import("../../shared/schemas/event.js").RawEvent[]
    ) => evaluateSufficiency({ sessionId: "s", events: e, behavior: b, cycle: 0, at: T0 }).confidence;
    const cShort = c(short, buildSession({ ...SPARSE_PROFILE, minutes: 2 }));
    const cMedium = c(medium, buildSession({ ...SPARSE_PROFILE, minutes: 6 }));
    const cLong = c(long, buildSession(BASELINE_PROFILE));

    assert.ok(cShort < cMedium, `${cShort} !< ${cMedium}`);
    assert.ok(cMedium < cLong, `${cMedium} !< ${cLong}`);
  });
});
