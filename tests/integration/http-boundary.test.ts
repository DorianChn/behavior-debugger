/**
 * HTTP boundary tests.
 *
 * The integration suite drives the service layer directly, which is right for
 * testing the loop — but it means anything that only exists in `server.ts`
 * goes untested. These tests spin up the real server and talk to it over
 * HTTP, so request-level validation is actually covered.
 *
 * The case that motivated this file: a batch whose events declare a different
 * sessionId than the request does. `ingestAndEvaluate` derives the session from
 * `events[0].sessionId`, so before the fix a request could declare session A,
 * carry session B, and be filed under B with a 200 — and a phantom session was
 * created and parked in WAITING for a request that should have been refused.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

let server: ChildProcess;
let base = "";
let dataRoot = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

function post(pathname: string, body: unknown) {
  return fetch(base + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Schema-valid events so a rejection can only be about the sessionId. */
function eventsFor(sessionId: string, n = 14, startIso = "2026-09-20T10:00:00.000Z") {
  const dests = ["github.com", "stackoverflow.com", "docs.example.com", "localhost"];
  return Array.from({ length: n }, (_, i) => {
    const target = dests[i % dests.length]!;
    return {
      eventId: `${sessionId}_ev_${String(i).padStart(3, "0")}`,
      sessionId,
      eventType: i === 0 ? "session_start" : "page_switch",
      timestamp: new Date(Date.parse(startIso) + i * 20_000).toISOString(),
      source: "localhost",
      target,
      durationMs: 20_000,
      url: `https://${target}/p/${i}`,
      title: `Page ${i}`,
      schemaVersion: "1.0",
    };
  });
}

describe("HTTP boundary", () => {
  before(async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bd-http-"));
    const port = 4800 + Math.floor(Math.random() * 200);
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), BEHAVIOR_DEBUGGER_HOME: dataRoot },
      stdio: "ignore",
    });
    const up = await waitForServer();
    assert.ok(up, `server did not come up on ${base}`);
  });

  after(() => {
    server?.kill("SIGTERM");
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test("a batch whose events belong to another session is rejected", async () => {
    const before = ((await (await fetch(`${base}/api/sessions`)).json()) as any).data.length;

    const res = await post("/api/events", {
      sessionId: "declared_session",
      events: eventsFor("actual_session"),
      batchId: "mismatch_1",
    });

    assert.equal(res.status, 400, "a sessionId mismatch must be refused, not filed elsewhere");
    const body: any = await res.json();
    assert.match(JSON.stringify(body), /declared_session/);
    assert.match(JSON.stringify(body), /actual_session/);

    const after = ((await (await fetch(`${base}/api/sessions`)).json()) as any).data;
    assert.equal(after.length, before, "no session may be created for a refused batch");
    const ids = after.map((s: any) => s.sessionId);
    assert.ok(!ids.includes("actual_session"), "the events' session must not appear");
    assert.ok(!ids.includes("declared_session"), "the declared session must not appear");
  });

  test("a matching batch is accepted and filed under the declared session", async () => {
    const id = "matched_session";
    const res = await post("/api/events", {
      sessionId: id,
      events: eventsFor(id),
      batchId: "match_1",
    });
    assert.equal(res.status, 200);

    const payload: any = await res.json();
    assert.equal(payload.data.ingest.accepted, 14);
    assert.equal(payload.data.ingest.rejected, 0, "schema-valid events must not be rejected");

    const stored: any = await (await fetch(`${base}/api/sessions/${id}/events`)).json();
    assert.equal(stored.data.length, 14);
    assert.ok(
      stored.data.every((e: any) => e.sessionId === id),
      "every stored event belongs to the declared session",
    );
  });

  test("a request missing sessionId is still rejected", async () => {
    const res = await post("/api/events", { events: eventsFor("whatever") });
    assert.equal(res.status, 400);
  });

  test("an empty event batch is rejected, not crashed into a 500", async () => {
    const res = await post("/api/events", { sessionId: "empty_session", events: [], batchId: "empty_1" });
    assert.equal(
      res.status,
      400,
      "an empty batch reaches ingestAndEvaluate with no sessionId at all — reject it as a bad request",
    );
  });

  test("verify without an experiment reports 409, not 500", async () => {
    const res = await post("/api/sessions/never_verified/verify", {});
    assert.equal(
      res.status,
      409,
      "a well-formed request against a not-ready state is a conflict, not a server error",
    );
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const res = await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    assert.equal(
      res.status,
      400,
      "a caller sending broken JSON is a client error — 500 would hide real server faults in the noise",
    );
  });

  test("a malformed event is reported as a client error, valid ones still land", async () => {
    const id = "partial_batch";
    const events = eventsFor(id, 12);
    const res = await post("/api/events", {
      sessionId: id,
      events: [...events, { eventId: "broken", sessionId: id, eventType: "nope", timestamp: "not-a-date" }],
      batchId: "partial_1",
    });
    assert.equal(res.status, 200, "a partially-valid batch is case-by-case, not fatal");
    const payload: any = await res.json();
    assert.equal(payload.data.ingest.accepted, 12);
    assert.ok(payload.data.ingest.rejected >= 1, "the bad event is counted, not silently dropped");
  });

  test("anonymous approval is refused", async () => {
    const id = "matched_session";
    await post(`/api/sessions/${id}/intervention`, {});
    const res = await post(`/api/sessions/${id}/approve`, { by: "   " });
    assert.equal(res.status, 400, "a whitespace-only approver is not a name");
  });
});
