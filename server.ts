/**
 * API server — the only surface the frontend talks to.
 *
 * Design notes:
 *  - Plain node:http, no framework. The API is 8 routes; Express would be more
 *    dependency than product.
 *  - Every handler returns a JSON envelope `{ ok, data?, error? }` so the
 *    frontend has exactly one response shape to handle.
 *  - Approval endpoints REQUIRE an explicit `acknowledgedBy`. Without it the
 *    request is rejected — the agent cannot approve its own intervention.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawEvent } from "./shared/schemas/event.js";
import type { DashboardSnapshot } from "./shared/types/api.js";
import { ingest } from "./collector/src/ingest.js";
import * as store from "./database/store.js";
import {
  approveIntervention,
  bootstrap,
  buildSessionView,
  createTask,
  getScheduler,
  ingestAndEvaluate,
  listSessions,
  proposeIntervention,
  readMemory,
  runVerification,
  sessionTimeline,
} from "./service.js";
import { forceExpireWaits } from "./reasoning/state-machine-port.js";
import { buildSession, BASELINE_PROFILE, IMPROVED_PROFILE, SPARSE_PROFILE, type SessionProfile } from "./collector/src/adapters/synthetic.js";

bootstrap();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(HERE, "frontend");

const PORT = Number(process.env.PORT ?? 4317);

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

function ok(res: http.ServerResponse, data: unknown): void {
  json(res, 200, { ok: true, data });
}

function fail(res: http.ServerResponse, code: number, error: string): void {
  json(res, code, { ok: false, error });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const full = path.join(FRONTEND, rel);
  // Path traversal guard: the resolved file must stay inside frontend/.
  if (!full.startsWith(FRONTEND)) return false;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const body = fs.readFileSync(full);
  res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
  res.end(body);
  return true;
}

function snapshot(sessionId: string): DashboardSnapshot {
  const events = store.readEventsForSession(sessionId);
  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    view: buildSessionView(sessionId),
    timeline: sessionTimeline(sessionId),
    events,
  };
}

const PROFILES: Record<string, SessionProfile> = {
  baseline: BASELINE_PROFILE,
  improved: IMPROVED_PROFILE,
  sparse: SPARSE_PROFILE,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  try {
    /* ------------------------------ health ------------------------------ */
    if (p === "/api/health") {
      const states = store.allTaskStates();
      return ok(res, {
        ok: true,
        now: new Date().toISOString(),
        sessions: states.map((s) => ({ sessionId: s.sessionId, phase: s.phase, waitUntil: s.waitUntil ?? null })),
        timers: getScheduler().pending(),
        waitTimeScale: getScheduler().timeScale,
        dataRoot: store.DB_ROOT,
      });
    }

    /* ----------------------------- ingestion ---------------------------- */
    if (p === "/api/events" && req.method === "POST") {
      const body = (await readBody(req)) as { sessionId?: string; events?: RawEvent[]; batchId?: string };
      if (!body.sessionId || !Array.isArray(body.events)) {
        return fail(res, 400, "expected { sessionId, events: RawEvent[] }");
      }
      /* An empty batch is a caller bug, not a no-op. `ingestAndEvaluate`
         derives the session from `events[0].sessionId`, so an empty array
         reaches it with no session at all and throws — surfacing as a 500 for
         what is plainly a malformed request. Reject it here instead. */
      if (body.events.length === 0) {
        return fail(res, 400, "events must not be empty — a batch needs at least one event");
      }

      /* The declared sessionId and the events' sessionId must agree.
         `ingestAndEvaluate` derives the session from `events[0].sessionId`, so
         without this check a request could declare session A, carry session B,
         and be filed under B with a 200 — the caller would never know. The
         mismatch is a caller bug, and it is cheapest to catch it here. */
      const mismatched = body.events.find((e) => e?.sessionId !== body.sessionId);
      if (mismatched) {
        return fail(
          res,
          400,
          `event ${mismatched.eventId ?? "<no eventId>"} has sessionId "${mismatched.sessionId}" ` +
            `but the request declares "${body.sessionId}" — every event in a batch must belong to the declared session`,
        );
      }

      const result = ingestAndEvaluate(body.sessionId, body.events, { batchId: body.batchId });
      if (result.outcome.waiting) getScheduler().arm(result.outcome.state);
      return ok(res, { ingest: result.ingest, phase: result.outcome.state.phase, headline: result.outcome.headline });
    }

    if (p.startsWith("/api/sessions/") && p.endsWith("/events") && req.method === "GET") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length, -"/events".length));
      return ok(res, store.readEventsForSession(sessionId));
    }

    /* ------------------------------ demo -------------------------------- */
    if (p === "/api/demo/load" && req.method === "POST") {
      const body = (await readBody(req)) as { profile?: string; sessionId?: string };
      const key = body.profile ?? "baseline";
      const profile = PROFILES[key];
      if (!profile) return fail(res, 400, `unknown profile "${key}" (baseline | improved | sparse)`);
      const withId: SessionProfile = body.sessionId ? { ...profile, sessionId: body.sessionId } : profile;
      const events = buildSession(withId);
      const result = ingestAndEvaluate(withId.sessionId, events, {
        batchId: `demo_${key}_${withId.sessionId}_${Date.now()}`,
      });
      if (result.outcome.waiting) getScheduler().arm(result.outcome.state);
      return ok(res, {
        sessionId: withId.sessionId,
        loaded: events.length,
        phase: result.outcome.state.phase,
        headline: result.outcome.headline,
      });
    }

    /** Fast-forward: expire WAIT timers now instead of waiting the full duration. */
    if (p === "/api/demo/fast-forward" && req.method === "POST") {
      const body = (await readBody(req)) as { sessionId?: string };
      const woken = forceExpireWaits(getScheduler());
      const target = body.sessionId ?? woken[0];
      if (!target) return ok(res, { woken: [], message: "No sessions were in WAITING." });
      const outcome = await import("./reasoning/engine.js").then((m) => m.evaluateSession(target));
      const next = outcome.state;
      if (next.phase === "WAITING") getScheduler().arm(next);
      // Be explicit when the session simply parked again: fast-forward moves the
      // clock, never the evidence, so a still-thin session must WAIT again.
      const reParked = next.phase === "WAITING";
      return ok(res, {
        woken,
        sessionId: target,
        phase: next.phase,
        headline: outcome.headline,
        reParked,
        message: reParked
          ? "Deadline expired and the session was re-evaluated — still not enough evidence, so it is WAITING again with a fresh deadline."
          : `Deadline expired and the session advanced to ${next.phase}.`,
      });
    }

    /* ---------------------------- session view -------------------------- */
    if (p === "/api/sessions" && req.method === "GET") {
      return ok(
        res,
        listSessions().map((id) => {
          const state = store.loadTaskState(id);
          return {
            sessionId: id,
            phase: state?.phase ?? "OBSERVING",
            waitUntil: state?.waitUntil ?? null,
            events: store.readEventsForSession(id).length,
            confidence: state?.sufficiency?.confidence ?? 0,
          };
        })
      );
    }

    if (p.startsWith("/api/sessions/") && req.method === "GET") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length));
      if (sessionId.includes("/")) return fail(res, 404, "not found");
      return ok(res, snapshot(sessionId));
    }

    if (p.startsWith("/api/sessions/") && p.endsWith("/evaluate") && req.method === "POST") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length, -"/evaluate".length));
      const { evaluateSession } = await import("./reasoning/engine.js");
      const outcome = evaluateSession(sessionId);
      if (outcome.waiting) getScheduler().arm(outcome.state);
      return ok(res, {
        phase: outcome.state.phase,
        headline: outcome.headline,
        sufficiency: outcome.sufficiency,
        diagnosed: outcome.diagnosed,
        hypothesisSet: outcome.hypothesisSet,
      });
    }

    /* ------------------------------ task -------------------------------- */
    if (p.endsWith("/task") && req.method === "POST") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length, -"/task".length));
      const body = (await readBody(req)) as { goal?: string; successCriteria?: string[] };
      if (!body.goal) return fail(res, 400, "expected { goal }");
      return ok(res, createTask(sessionId, body.goal, body.successCriteria));
    }

    /* -------------------------- intervention ---------------------------- */
    if (p.endsWith("/intervention") && req.method === "POST") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length, -"/intervention".length));
      const outcome = await proposeIntervention(sessionId);
      return ok(res, {
        phase: outcome.view.state.phase,
        intervention: outcome.view.intervention,
        alternatives: outcome.alternatives,
        narrative: outcome.narrative,
      });
    }

    if (p.endsWith("/approve") && req.method === "POST") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length, -"/approve".length));
      const body = (await readBody(req)) as { acknowledgedBy?: string; decision?: "approved" | "rejected"; note?: string };
      // ★ No approval without a named human.
      if (!body.acknowledgedBy || !body.acknowledgedBy.trim()) {
        return fail(res, 400, "acknowledgedBy is required — interventions cannot be approved anonymously");
      }
      const outcome = approveIntervention(sessionId, {
        acknowledgedBy: body.acknowledgedBy,
        decision: body.decision,
        note: body.note,
      });
      return ok(res, {
        phase: outcome.view.state.phase,
        message: outcome.message,
        execution: outcome.execution,
        experiment: outcome.view.experiment,
      });
    }

    if (p.endsWith("/verify") && req.method === "POST") {
      const sessionId = decodeURIComponent(p.slice("/api/sessions/".length, -"/verify".length));
      const body = (await readBody(req)) as { comparisonMinutes?: number; now?: string };
      // Nothing to verify is a caller-ordering problem, not a server fault.
      if (!store.loadExperiment(sessionId)) {
        return fail(
          res,
          409,
          `Session ${sessionId} has no approved experiment to verify — propose and approve an intervention first.`
        );
      }
      const outcome = await runVerification(sessionId, {
        comparisonMinutes: body.comparisonMinutes,
        now: body.now,
      });
      return ok(res, {
        phase: outcome.view.state.phase,
        verification: outcome.view.verification,
        summary: outcome.summary,
        narrative: outcome.narrative,
      });
    }

    if (p === "/api/memory" && req.method === "GET") {
      return ok(res, readMemory());
    }

    /* ------------------------------ static ------------------------------ */
    if (req.method === "GET" && serveStatic(res, p)) return;
    return fail(res, 404, `no route for ${req.method} ${p}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /* Distinguish "your request was wrong" from "we broke".
       Without this, every malformed payload surfaced as a 500 — which trains
       callers to ignore 500s, and hides genuine server faults in the noise.
       These are the messages `readBody` and the validators actually throw. */
    const clientError =
      /request body (is not valid JSON|too large)|is required|must be|invalid |not allowed by the .* schema|expected /i.test(
        message,
      );
    const status = clientError ? 400 : 500;
    console.error(`[api] ${req.method} ${p} → ${status} ${message}`);
    return fail(res, status, message);
  }
});

/* Bind address.
 *
 * Defaults to loopback so a local run is never exposed on the network — the API
 * has no authentication, and it stores everything the user's browser did.
 *
 * Containers must override this. A process listening on 127.0.0.1 inside a
 * container is on that container's loopback only, so `ports: "4317:4317"` maps
 * a port nothing is listening on. `HOST=0.0.0.0` is correct inside a container
 * *because* the published port is the actual boundary — but only publish it to
 * the host's loopback (`127.0.0.1:4317:4317`) unless you intend to expose an
 * unauthenticated API to your network. */
const HOST = process.env.HOST ?? "127.0.0.1";

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`behavior-debugger API  →  http://${shown}:${PORT}`);
  console.log(`  dashboard            →  http://${shown}:${PORT}/`);
  console.log(`  bound to             →  ${HOST}:${PORT}${HOST === "0.0.0.0" ? "  (all interfaces — no auth!)" : ""}`);
  console.log(`  data root            →  ${store.DB_ROOT}`);
  console.log(`  WAIT time scale      →  ×${getScheduler().timeScale} (set WAIT_TIME_SCALE=0.05 to demo fast)`);
});

export { server };
