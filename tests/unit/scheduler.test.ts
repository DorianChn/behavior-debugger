/**
 * Scheduler tests — the operational proof that WAIT is a real state.
 *
 * The claim under test: a session parked in WAITING survives a process restart,
 * and its deadline is honoured. If WAIT were implemented as "the model said
 * please give me more information", none of this would be testable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BEHAVIOR_DEBUGGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bd-sched-"));

const { ingest } = await import("../../collector/src/ingest.js");
const store = await import("../../database/store.js");
const { bootstrap } = await import("../../service.js");
const { evaluateSession } = await import("../../reasoning/engine.js");
const { WaitScheduler, bootstrapScheduler } = await import("../../reasoning/scheduler.js");
const { initialState, transition } = await import("../../reasoning/state-machine.js");
const { buildSession, SPARSE_PROFILE, BASELINE_PROFILE } = await import(
  "../../collector/src/adapters/synthetic.js"
);

bootstrap({ ingest, store });

let n = 0;
const sid = (t: string) => `${t}_${++n}`;

describe("WAIT persistence and recovery", () => {
  test("a restarted process re-arms pending WAIT sessions", () => {
    const id = sid("recover");
    ingest({ sessionId: id, events: buildSession({ ...SPARSE_PROFILE, sessionId: id }), batchId: `b_${id}` });
    const parked = evaluateSession(id);

    assert.equal(parked.state.phase, "WAITING");
    const deadline = parked.state.waitUntil!;

    // Simulate a restart: a brand-new scheduler with no in-memory timers.
    // NOTE: recovery scans the whole store, so other WAITING sessions from
    // earlier tests may be present — scope every assertion to THIS session.
    const woken: string[] = [];
    const sched = new WaitScheduler((s) => woken.push(s), { timeScale: 1 });
    const recovered = sched.recoverPendingWaits(new Date(Date.parse(deadline) - 60_000));

    const mine = recovered.find((r) => r.sessionId === id);
    assert.ok(mine, "this session must appear in the recovery report");
    assert.equal(mine.action, "rearmed", "a deadline in the future must be re-armed, not fired");

    // And on the real disk, not just in memory.
    const onDisk = store.waitingStates().find((s) => s.sessionId === id);
    assert.ok(onDisk, "the WAITING state must be on disk for recovery to find it");
    assert.equal(onDisk.waitUntil, deadline);
    assert.equal(woken.length, 0, "must not wake before the deadline");

    sched.cancelAll();
  });

  test("an overdue deadline is fired immediately on boot", () => {
    const id = sid("overdue");
    ingest({ sessionId: id, events: buildSession({ ...SPARSE_PROFILE, sessionId: id }), batchId: `b_${id}` });
    const parked = evaluateSession(id);
    const deadline = parked.state.waitUntil!;

    const woken: string[] = [];
    const sched = new WaitScheduler((s) => woken.push(s), { timeScale: 1 });
    const recovered = sched.recoverPendingWaits(new Date(Date.parse(deadline) + 60_000));

    const mine = recovered.find((r) => r.sessionId === id);
    assert.ok(mine, "this session must appear in the recovery report");
    assert.equal(mine.action, "woke", "a past deadline must wake at boot, not be lost");
    assert.ok(woken.includes(id), "the wake callback must receive this session");

    sched.cancelAll();
  });

  test("the timer fires and drives the loop forward", async () => {
    const id = sid("timer");
    ingest({ sessionId: id, events: buildSession({ ...SPARSE_PROFILE, sessionId: id }), batchId: `b_${id}` });
    const parked = evaluateSession(id);
    assert.equal(parked.state.phase, "WAITING");

    // Arm only THIS session. `recoverPendingWaits()` would arm every parked
    // session in the shared store, and the first one to fire would resolve the
    // promise regardless of which session it was.
    // timeScale 0 collapses the wait so the test runs instantly, without
    // changing the deadline semantics being tested.
    const seen: string[] = [];
    const sched = new WaitScheduler((s) => seen.push(s), { timeScale: 0 });
    const delay = sched.arm(parked.state);
    assert.ok(delay >= 0, "arming a WAITING session must schedule a timer");

    await new Promise((r) => setTimeout(r, 200));
    assert.ok(seen.includes(id), `the scheduler must fire for the parked session, saw ${JSON.stringify(seen)}`);
    sched.cancelAll();
  });

  test("a session already past WAITING is not woken again", () => {
    const id = sid("stale");
    // A READY session: not a recovery candidate at all.
    ingest({ sessionId: id, events: buildSession({ ...BASELINE_PROFILE, sessionId: id }), batchId: `b_${id}` });
    evaluateSession(id);

    const woken: string[] = [];
    const sched = new WaitScheduler((s) => woken.push(s), { timeScale: 1 });
    const recovered = sched.recoverPendingWaits();
    assert.equal(recovered.find((r) => r.sessionId === id), undefined);
    assert.equal(woken.includes(id), false);
    sched.cancelAll();
  });

  test("cancelling a timer prevents the wake", async () => {
    const id = sid("cancel");
    ingest({ sessionId: id, events: buildSession({ ...SPARSE_PROFILE, sessionId: id }), batchId: `b_${id}` });
    const parked = evaluateSession(id);

    const woken: string[] = [];
    const sched = new WaitScheduler((s) => woken.push(s), { timeScale: 0 });
    sched.arm(parked.state);
    sched.cancel(id);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(woken.length, 0, "a cancelled timer must not fire");
  });

  test("only one timer exists per session (arming twice does not double-fire)", async () => {
    const id = sid("dup");
    ingest({ sessionId: id, events: buildSession({ ...SPARSE_PROFILE, sessionId: id }), batchId: `b_${id}` });
    const parked = evaluateSession(id);

    const woken: string[] = [];
    const sched = new WaitScheduler((s) => woken.push(s), { timeScale: 0 });
    sched.arm(parked.state);
    sched.arm(parked.state);
    sched.arm(parked.state);
    assert.equal(sched.pending().filter((p) => p.sessionId === id).length, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(woken.length, 1, `expected exactly one wake, got ${woken.length}`);
  });
});

describe("deadline arithmetic", () => {
  test("waitUntil is derived from the report, not a magic constant", () => {
    const t0 = "2026-09-20T10:00:00.000Z";
    let s = initialState("s", "t", t0);
    s = transition(s, { type: "EVENTS_APPENDED", count: 40, at: t0 });
    s = transition(s, {
      type: "INSUFFICIENT",
      at: t0,
      report: {
        sessionId: "s",
        status: "WAIT",
        confidence: 0.3,
        missingInformation: ["gap"],
        nextObservation: { action: "Continue observing", durationMinutes: 17, targetMetrics: ["eventCount"] },
        evaluatedAt: t0,
        cycle: 0,
      },
    });
    // 17 minutes, taken straight from the report.
    assert.equal(s.waitUntil, "2026-09-20T10:17:00.000Z");
  });

  test("bootstrapScheduler is safe with no pending work", () => {
    const sched = new WaitScheduler(() => {}, { timeScale: 1 });
    assert.doesNotThrow(() => bootstrapScheduler(sched));
    sched.cancelAll();
  });
});
