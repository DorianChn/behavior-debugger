/**
 * Contract guard: every field the dashboard reads must exist in the API payload.
 *
 * The frontend is plain JS with no build step, so a renamed schema field fails
 * silently — the panel just renders blank. This script drives a session through
 * the whole loop and asserts the payload shape the dashboard depends on.
 *
 *   tsx scripts/check-ui-contract.ts [baseUrl]
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:4317";

let failures = 0;
function has(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function keys(o: unknown): string[] {
  return o && typeof o === "object" ? Object.keys(o as object) : [];
}

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(BASE + path, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok || json?.ok === false) throw new Error(`${path} → ${json?.error ?? res.status}`);
  return json.data as T;
}

async function main() {
  console.log(`\nUI contract check against ${BASE}\n`);

  const sid = `ui_${Date.now().toString(36)}`;

  /* ---- a WAITING session (exercises the countdown + evidence ladder) ---- */
  await api("/api/demo/load", { method: "POST", body: { profile: "sparse", sessionId: sid } });
  const waiting = await api<any>(`/api/sessions/${sid}`);
  const wv = waiting.view;

  console.log("WAITING payload");
  for (const k of ["sessionId", "phase", "enteredAt", "reEvalCount", "sufficiency"]) {
    has(`state.${k}`, k in wv.state);
  }
  has("state.waitUntil is set while WAITING", typeof wv.state.waitUntil === "string");
  const su = wv.sufficiency;
  for (const k of ["status", "confidence", "missingInformation", "evaluatedAt", "cycle", "checks", "nextObservation"]) {
    has(`sufficiency.${k}`, k in su);
  }
  has("sufficiency.checks is an array of 5 gates", Array.isArray(su.checks) && su.checks.length === 5);
  has("each check has id/score/weight/ok", su.checks.every((c: any) => c.id && typeof c.score === "number" && typeof c.weight === "number" && typeof c.ok === "boolean"));
  has("a failed check explains what is missing", su.checks.filter((c: any) => !c.ok).every((c: any) => !!c.missing));
  has("nextObservation has action/durationMinutes/targetMetrics",
    su.nextObservation?.action && typeof su.nextObservation.durationMinutes === "number" && Array.isArray(su.nextObservation.targetMetrics));

  /* ---- a diagnosed session (exercises behavior + hypotheses panels) ---- */
  await api("/api/demo/load", { method: "POST", body: { profile: "baseline", sessionId: sid } });
  const diag = await api<any>(`/api/sessions/${sid}`);
  const dv = diag.view;

  console.log("\nDIAGNOSING payload");
  for (const k of ["windowStart", "windowEnd", "windowMinutes", "segments", "sequence", "transitions", "metrics", "evidenceIds"]) {
    has(`behavior.${k}`, k in dv.behavior);
  }
  has("behavior.metrics has all 7 metrics",
    ["totalDwellMs", "switchCount", "switchRatePerMin", "uniqueSources", "avgDwellMs", "returnRate", "longestFocusMs"]
      .every((k) => k in dv.behavior.metrics));
  has("segments carry kind/durationMs/eventIds/startTs/endTs",
    dv.behavior.segments.every((s: any) => s.kind && typeof s.durationMs === "number" && Array.isArray(s.eventIds) && s.startTs && s.endTs));
  has("hypothesisSet has hypotheses/leadingId/revision",
    ["hypotheses", "leadingId", "revision"].every((k) => k in dv.hypothesisSet));
  has("at least 2 competing hypotheses", dv.hypothesisSet.hypotheses.length >= 2);
  has("hypotheses carry statement/confidence/state/rationale",
    dv.hypothesisSet.hypotheses.every((h: any) => h.statement && typeof h.confidence === "number" && h.state && "rationale" in h));
  has("supportingEvidence carries statement/metric/value/eventIds/weight",
    dv.hypothesisSet.hypotheses.every((h: any) =>
      h.supportingEvidence.every((e: any) => e.statement && "metric" in e && "value" in e && Array.isArray(e.eventIds) && typeof e.weight === "number")));
  has("contradictingEvidence is ALWAYS an array (never absent)",
    dv.hypothesisSet.hypotheses.every((h: any) => Array.isArray(h.contradictingEvidence)));
  has("missingEvidence is ALWAYS an array",
    dv.hypothesisSet.hypotheses.every((h: any) => Array.isArray(h.missingEvidence)));
  has("view.intervention is null before proposing", dv.intervention === null);
  has("view.experiment is null before approving", dv.experiment === null);
  has("view.verification is null before verifying", dv.verification === null);

  console.log("\ntimeline payload");
  has("timeline is a non-empty array", Array.isArray(diag.timeline) && diag.timeline.length > 0);
  has("every entry has at/phase/label/detail",
    diag.timeline.every((t: any) => t.at && t.phase && t.label && t.detail));

  /* ---- the full loop (exercises intervention/verification/memory) ---- */
  await api(`/api/sessions/${sid}/intervention`, { method: "POST", body: {} });
  await api(`/api/sessions/${sid}/approve`, {
    method: "POST",
    body: { acknowledgedBy: "contract-check", decision: "approved" },
  });
  await api("/api/demo/load", { method: "POST", body: { profile: "improved", sessionId: sid } });
  await api(`/api/sessions/${sid}/verify`, { method: "POST", body: {} });

  const full = await api<any>(`/api/sessions/${sid}`);
  const fv = full.view;

  console.log("\npost-intervention payload");
  has("intervention carries title/description/kind/targetMetric/expectedEffect",
    ["title", "description", "kind", "targetMetric", "expectedEffect"].every((k) => k in fv.intervention));
  has("intervention.steps carry stepId/instruction/action",
    fv.intervention.steps.every((s: any) => s.stepId && s.instruction && s.action));
  // ★ The dashboard reads `by` and `at` — these names come straight from the
  //   Approval schema. Reading `acknowledgedBy` here would render blank.
  has("approval carries required/status/by/at",
    ["required", "status", "by", "at"].every((k) => k in fv.intervention.approval));
  has("approval.status is approved", fv.intervention.approval.status === "approved");
  has("experiment carries experimentId/metric/baselineValue/status/preWindow/postWindow",
    ["experimentId", "metric", "baselineValue", "status", "preWindow", "postWindow"].every((k) => k in fv.experiment));
  has("verification carries result/reason/comparison/eventIdsBefore/eventIdsAfter",
    ["result", "reason", "comparison", "eventIdsBefore", "eventIdsAfter"].every((k) => k in fv.verification));
  has("comparison carries before/after/deltaPct/sampleSize+windowMinutes both sides",
    ["before", "after", "deltaPct", "sampleSizeBefore", "sampleSizeAfter", "windowMinutesBefore", "windowMinutesAfter"]
      .every((k) => k in fv.verification.comparison));
  has("verification.result is one of the four honest outcomes",
    ["SUPPORTED", "WEAKENED", "REJECTED", "INCONCLUSIVE"].includes(fv.verification.result));

  const mem = await api<any[]>("/api/memory");
  console.log("\nmemory payload");
  has("memory is an array", Array.isArray(mem));
  if (mem.length) {
    has("memory records carry lesson/result/deltaPct/metric",
      ["lesson", "result", "deltaPct", "metric"].every((k) => k in mem[0]));
  }

  const health = await api<any>("/api/health");
  console.log("\nhealth payload");
  has("health carries ok/dataRoot/waitTimeScale/sessions/timers",
    ["ok", "dataRoot", "waitTimeScale", "sessions", "timers"].every((k) => k in health));

  console.log(`\n${failures === 0 ? "  ALL FIELDS PRESENT — the dashboard can render every panel." : `  ${failures} FIELD(S) MISSING.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n[FATAL]", e.message);
  process.exit(1);
});

export {};
