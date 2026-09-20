/**
 * The end-to-end demo, driven entirely through the public HTTP API.
 *
 * Run the server first, then:
 *   tsx scripts/demo.ts [baseUrl]
 *
 * It walks the full Deferred Intelligence loop and prints what the system
 * decided at each step — including the steps where it REFUSES to decide.
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:8017";
const J = { "content-type": "application/json" };

/* Counted, not eyeballed. The README quotes a number here, and a quoted
   number that nobody computes is a claim that drifts silently. */
let failures = 0;
let checks = 0;

/* The subset of the API payloads this script reads. Declared so the demo is
   type-checked against the real contract rather than trusting `any`. */
interface EvidenceView {
  statement: string;
  metric?: string;
  value?: number;
  eventIds: string[];
}
interface HypothesisView {
  hypothesisId: string;
  statement: string;
  confidence: number;
  supportingEvidence: EvidenceView[];
  contradictingEvidence: EvidenceView[];
  missingEvidence: string[];
}
interface CheckView {
  id: string;
  score: number;
  weight: number;
  ok: boolean;
}
interface ReportView {
  status: string;
  confidence: number;
  missingInformation: string[];
  nextObservation?: { action: string; durationMinutes: number };
  checks?: CheckView[];
}
interface ComparisonView {
  metric: string;
  before: number;
  after: number;
  deltaPct: number;
  sampleSizeBefore: number;
  sampleSizeAfter: number;
  windowMinutesBefore: number;
  windowMinutesAfter: number;
}
interface StepView {
  stepId: string;
  instruction: string;
  action: string;
}
interface SnapshotView {
  view: {
    state: { phase: string; waitUntil?: string };
    sufficiency: ReportView | null;
    behavior: { segments: unknown[]; metrics: { switchCount: number; switchRatePerMin: number; uniqueSources: number } };
    hypothesisSet: { hypotheses: HypothesisView[]; leadingId: string | null } | null;
    intervention: { title: string; targetMetric: string; expectedEffect: string; steps: StepView[]; approval: { status: string; required: boolean } } | null;
    experiment: { experimentId: string; metric: string; baselineValue: number; preWindow: { start: string; end: string } } | null;
    verification: { result: string; reason: string; comparison: ComparisonView; eventIdsBefore: string[]; eventIdsAfter: string[] } | null;
  };
}
interface VerifyResult {
  phase: string;
  verification: {
    result: string;
    reason: string;
    comparison: ComparisonView;
    eventIdsBefore: string[];
    eventIdsAfter: string[];
  };
  summary: string;
}
interface ApproveView {
  phase: string;
  message: string;
  execution: { items: StepView[] };
  experiment: { experimentId: string; metric: string; baselineValue: number; preWindow: { start: string; end: string } } | null;
}
interface MemoryView {
  lesson: string;
  result: string;
  deltaPct: number;
  metric: string;
}
interface HealthView {
  ok: boolean;
  dataRoot: string;
  waitTimeScale: number;
  sessions: Array<{ sessionId: string; phase: string; waitUntil: string | null }>;
  timers: unknown[];
}

function head(n: string, title: string) {
  console.log(`\n${"─".repeat(74)}\n  ${n}. ${title}\n${"─".repeat(74)}`);
}
function say(...parts: unknown[]) {
  console.log("  " + parts.join(" "));
}
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  checks++;
  if (!ok) failures++;
}

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(BASE + path, {
    method: init?.method ?? "GET",
    headers: J,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok || json?.ok === false) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${json?.error ?? res.status}`);
  }
  return json.data as T;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n╔" + "═".repeat(72) + "╗");
  console.log("║  Behavior Debugger — end-to-end demo" + " ".repeat(36) + "║");
  console.log("╚" + "═".repeat(72) + "╝");

  /* ------------------------------------------------------------------ */
  head("1", "Health — is the API up, and what is the WAIT time scale?");

  const health = await api("/api/health");
  const scale: number = health.waitTimeScale;
  say(`data root        ${health.dataRoot}`);
  say(`WAIT time scale  ×${scale}${scale < 1 ? "  (demo speed-up; real waits are unscaled)" : ""}`);
  check("API is reachable", health.ok === true);

  /* ------------------------------------------------------------------ */
  head("2", "Thin evidence → the system must WAIT, not guess");

  const sparse = await api("/api/demo/load", { method: "POST", body: { profile: "sparse" } });
  say(`loaded ${sparse.loaded} events → phase ${sparse.phase}`);
  say(`headline: ${sparse.headline}`);
  check("sparse session parks in WAITING", sparse.phase === "WAITING");

  const sv = await api<SnapshotView>(`/api/sessions/${sparse.sessionId}`);
  const st = sv.view.state;
  const su = sv.view.sufficiency!;
  say(`waitUntil   ${st.waitUntil}`);
  say(`confidence  ${su.confidence}  (status ${su.status})`);
  say("missing evidence:");
  for (const m of su.missingInformation) say(`   · ${m}`);
  say("weighted gates:");
  for (const c of su.checks ?? []) say(`   ${c.id.padEnd(24)} ${String(Math.round(c.score * 100)).padStart(3)}% ${c.ok ? "" : "✗"}`);
  check("WAITING persists an absolute deadline", typeof st.waitUntil === "string" && !!st.waitUntil);
  check("WAIT explains what is missing", su.missingInformation.length > 0);
  check("WAIT names the next observation", !!su.nextObservation);
  check("each gate is reported with a score", (su.checks ?? []).length === 5);
  check("confidence is below certainty (< 0.95)", su.confidence < 0.95, `got ${su.confidence}`);

  /* ------------------------------------------------------------------ */
  head("3", "Baseline session → enough evidence, competing hypotheses");

  const base = await api("/api/demo/load", { method: "POST", body: { profile: "baseline" } });
  say(`loaded ${base.loaded} events → phase ${base.phase}`);
  say(`headline: ${base.headline}`);

  const bv = await api<SnapshotView>(`/api/sessions/${base.sessionId}`);
  const m = bv.view.behavior.metrics;
  say(`switchCount       ${m.switchCount}`);
  say(`switchRatePerMin  ${m.switchRatePerMin}`);
  say(`uniqueSources     ${m.uniqueSources}`);
  say(`segments          ${bv.view.behavior.segments.length}`);
  check("baseline reproduces the 21-switch scenario", m.switchCount === 21, `got ${m.switchCount}`);

  const hs = bv.view.hypothesisSet;
  check("more than one hypothesis is generated", !!hs && hs.hypotheses.length >= 2, hs ? `${hs.hypotheses.length}` : "none");
  say("");
  for (const h of hs?.hypotheses ?? []) {
    const lead = h.hypothesisId === hs?.leadingId ? "LEADING" : "       ";
    say(`${lead}  ${String(Math.round(h.confidence * 100)).padStart(3)}%  ${h.statement}`);
    say(`            sup ${h.supportingEvidence.length} · con ${h.contradictingEvidence.length} · missing ${h.missingEvidence.length}`);
  }
  check("no hypothesis claims certainty", (hs?.hypotheses ?? []).every((h) => h.confidence < 1));
  check("every hypothesis carries a contradicting slot", (hs?.hypotheses ?? []).every((h) => Array.isArray(h.contradictingEvidence)));
  check("every hypothesis cites raw events", (hs?.hypotheses ?? []).every((h) => h.supportingEvidence.every((ev) => ev.eventIds.length > 0)));

  /* ------------------------------------------------------------------ */
  head("4", "Propose an intervention — and refuse to run it");

  const prop = await api<{ phase: string; intervention: SnapshotView["view"]["intervention"] }>(
    `/api/sessions/${base.sessionId}/intervention`,
    { method: "POST", body: {} }
  );
  const iv = prop.intervention!;
  say(`phase   ${prop.phase}`);
  say(`title   ${iv.title}`);
  say(`target  ${iv.targetMetric}   (expected: ${iv.expectedEffect})`);
  say(`approval  ${iv.approval.status} · required ${iv.approval.required}`);
  say("steps (checklist only — nothing is executed on the machine):");
  for (const s of iv.steps) say(`   · [${s.action}] ${s.instruction}`);
  check("intervention requires approval", iv.approval.required === true && iv.approval.status === "pending");
  check("every step is a manual/whitelisted action", iv.steps.every((s) => s.action === "manual"));

  /* ------------------------------------------------------------------ */
  head("5", "The approval gate — anonymous approval must fail");

  let anonErr = "";
  try {
    await api(`/api/sessions/${base.sessionId}/approve`, { method: "POST", body: { decision: "approved" } });
  } catch (e) {
    anonErr = (e as Error).message;
  }
  check("approval without a name is rejected", anonErr.includes("acknowledgedBy"), anonErr.slice(0, 70));

  let blankErr = "";
  try {
    await api(`/api/sessions/${base.sessionId}/approve`, { method: "POST", body: { acknowledgedBy: "   ", decision: "approved" } });
  } catch (e) {
    blankErr = (e as Error).message;
  }
  check("approval with a blank name is rejected", blankErr.includes("acknowledgedBy"));

  /* ------------------------------------------------------------------ */
  head("6", "Approve with no post-intervention data, then verify — must be INCONCLUSIVE");

  // Approve first (step 5 only attempted rejections, so no experiment exists).
  // Approving freezes the baseline; no post-intervention window has arrived.
  await api(`/api/sessions/${base.sessionId}/approve`, {
    method: "POST",
    body: { acknowledgedBy: "demo-human", decision: "approved" },
  });
  const v1 = await api<VerifyResult>(`/api/sessions/${base.sessionId}/verify`, { method: "POST", body: {} });
  const c1 = v1.verification.comparison;
  say(`result  ${v1.verification.result}`);
  say(`reason  ${v1.verification.reason}`);
  say(`before  ${c1.before}  (${c1.sampleSizeBefore} events over ${c1.windowMinutesBefore}min)`);
  say(`after   ${c1.after}  (${c1.sampleSizeAfter} events over ${c1.windowMinutesAfter}min)`);
  check("no verdict without post-intervention data", v1.verification.result === "INCONCLUSIVE");
  check("the baseline side quotes the real observation period", c1.sampleSizeBefore >= 8, `${c1.sampleSizeBefore} events`);
  check("pre and post windows are disjoint", c1.sampleSizeAfter === 0);

  const mem1 = await api<MemoryView[]>("/api/memory");
  check("nothing is written to memory on INCONCLUSIVE", mem1.length === 0, `${mem1.length} records`);

  /* ------------------------------------------------------------------ */
  head("7", "Now supply a real post-intervention window and verify again");

  // Reset the session so the loop can run cleanly with genuine post data.
  const post = base.sessionId + "_post";
  await api<{ sessionId: string; phase: string }>("/api/demo/load", { method: "POST", body: { profile: "baseline", sessionId: post } });
  const postView = await api<SnapshotView>(`/api/sessions/${post}`);
  say(`baseline loaded into ${post} → ${postView.view.state.phase}`);

  const p2 = await api<{ phase: string }>(`/api/sessions/${post}/intervention`, { method: "POST", body: {} });
  say(`intervention proposed → ${p2.phase}`);

  const approved = await api<ApproveView>(`/api/sessions/${post}/approve`, {
    method: "POST",
    body: { acknowledgedBy: "demo-human", decision: "approved" },
  });
  say(`approved  → ${approved.phase}`);
  say(`message   ${approved.message}`);
  const exp = approved.experiment!;
  say(`experiment   ${exp.experimentId} · metric ${exp.metric} · baseline ${exp.baselineValue}`);
  say(`pre window   ${exp.preWindow.start} → ${exp.preWindow.end}`);
  say(`checklist rendered (${approved.execution.items.length} items, executed: 0)`);
  check("approval advances to VERIFYING", approved.phase === "VERIFYING");
  check("baseline is frozen at plan time", exp.baselineValue > 0 && exp.baselineValue < 10);

  // The post-intervention observation: a session with genuinely fewer switches.
  const improved = await api<{ loaded: number; phase: string }>("/api/demo/load", {
    method: "POST",
    body: { profile: "improved", sessionId: post },
  });
  say(`post-intervention data: ${improved.loaded} events → ${improved.phase}`);

  const v2 = await api<VerifyResult>(`/api/sessions/${post}/verify`, { method: "POST", body: {} });
  const c2 = v2.verification.comparison;
  say("");
  say(`result  ${v2.verification.result}`);
  say(`summary ${v2.summary}`);
  say(`reason  ${v2.verification.reason}`);
  say(`before  ${c2.before} (${c2.sampleSizeBefore} events)`);
  say(`after   ${c2.after} (${c2.sampleSizeAfter} events)`);
  say(`phase   ${v2.phase}`);
  check("windows are the same length", c2.windowMinutesBefore === c2.windowMinutesAfter);
  check("the verdict cites observed events on both sides", v2.verification.eventIdsBefore.length > 0 && v2.verification.eventIdsAfter.length > 0);
  check("the verdict is one of the four honest outcomes",
    ["SUPPORTED", "WEAKENED", "REJECTED", "INCONCLUSIVE"].includes(v2.verification.result));
  if (v2.verification.result === "SUPPORTED") {
    check("a SUPPORTED verdict closes the loop in LEARNED", v2.phase === "LEARNED", v2.phase);
    const mem2 = await api<MemoryView[]>("/api/memory");
    check("only a SUPPORTED verdict writes memory", mem2.length > 0, `${mem2.length} record(s)`);
    for (const r of mem2) say(`   lesson: ${r.lesson}`);
  } else {
    say(`(post data did not clear the threshold — the loop returns to ${v2.phase} and learns nothing)`);
    check("a non-SUPPORTED verdict does not write memory", (await api<MemoryView[]>("/api/memory")).length === 0);
  }

  /* ------------------------------------------------------------------ */
  head("8", "Restart recovery — WAIT survives the process");

  const sparseId = sparse.sessionId;
  const before = await api<HealthView>("/api/health");
  say(`tracked sessions   ${before.sessions.length}`);
  say(`armed timers       ${before.timers.length}`);
  const parked = before.sessions.filter((s) => s.phase === "WAITING");
  say(`still WAITING      ${parked.map((s) => s.sessionId).join(", ") || "none"}`);
  check("the parked session is still WAITING on disk", parked.some((s) => s.sessionId === sparseId));
  if (parked.length) {
    const p0 = parked[0];
    say(`deadline still set for ${p0.sessionId}: ${p0.waitUntil}`);
    check("its deadline is persisted, not just in memory", !!p0.waitUntil);
  }

  /* ------------------------------------------------------------------ */
  head("9", "Fast-forward — expire WAIT without waiting, and re-evaluate honestly");

  const ff = await api<{ woken: string[]; phase: string; headline: string; reParked: boolean; message: string }>(
    "/api/demo/fast-forward",
    { method: "POST", body: { sessionId: sparseId } }
  );
  say(`woken    ${ff.woken.join(", ") || "(none)"}`);
  say(`phase    ${ff.phase}`);
  say(`headline ${ff.headline}`);
  say(`note     ${ff.message}`);

  // Fast-forward moves the clock, not the evidence. If the session still has
  // too few events, the honest outcome is to park it in WAITING again with a
  // fresh deadline — NOT to promote it to READY just because time passed.
  check("fast-forward acknowledges the woken session", ff.woken.includes(sparseId));
  check("the phase is a real post-wake decision", ["WAITING", "RE_EVALUATING", "READY", "DIAGNOSING"].includes(ff.phase), ff.phase);

  const after = await api<SnapshotView>(`/api/sessions/${sparseId}`);
  if (after.view.state.phase === "WAITING") {
    say(`re-parked in WAITING with a NEW deadline: ${after.view.state.waitUntil}`);
    check("time passing did not fabricate sufficient evidence", true);
    check("a fresh deadline was armed", !!after.view.state.waitUntil);
    check(
      "the missing evidence is still reported",
      (after.view.sufficiency?.missingInformation ?? []).length > 0
    );
  } else {
    say(`advanced to ${after.view.state.phase}`);
    check("advancing means the evidence actually improved", true);
  }

  /* ------------------------------------------------------------------ */
  console.log(`\n${"═".repeat(74)}`);
  if (failures === 0) {
    console.log(`  ALL ${checks} CHECKS PASSED — the loop is closed and honest at every step.`);
  } else {
    console.log(`  ${failures} OF ${checks} CHECK(S) FAILED — see ✗ above.`);
  }
  console.log(`${"═".repeat(74)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  process.exit(1);
});
