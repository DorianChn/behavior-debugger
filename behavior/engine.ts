/**
 * Behavior engine — turns immutable raw events into a behavior representation.
 *
 * Responsibility: DESCRIBE, never EXPLAIN. There is deliberately no notion of
 * "cause" anywhere in this module; if you find yourself wanting to add one, it
 * belongs in reasoning/.
 *
 * Pipeline:
 *   raw events → classifier (event → kind) → segmenter (group consecutive
 *   same-kind events) → metrics → representation
 */

import type { RawEvent } from "../shared/schemas/event.js";
import {
  BEHAVIOR_SCHEMA_VERSION,
  windowOf,
  type BehaviorKind,
  type BehaviorMetrics,
  type BehaviorRepresentation,
  type BehaviorSegment,
  type BehaviorTransition,
} from "../shared/schemas/behavior.js";
import { counterId, round, shortId } from "../shared/utils/ids.js";
import { sortByTs } from "../shared/utils/window.js";

export interface BehaviorOptions {
  /** Gap larger than this (ms) forces a new segment even for the same kind. */
  segmentGapMs?: number;
  /** Segments shorter than this are merged into their neighbour. */
  minSegmentMs?: number;
  /** taskId to stamp on segments; optional in MVP. */
  taskId?: string;
}

export const DEFAULT_BEHAVIOR_OPTIONS: Required<Pick<BehaviorOptions, "segmentGapMs" | "minSegmentMs">> = {
  segmentGapMs: 5 * 60_000,
  minSegmentMs: 20_000,
};

/* ----------------------------- classification ---------------------------- */

/** Source-domain → behavior kind. Ordered: first match wins. */
const DOMAIN_RULES: Array<{ match: RegExp; kind: BehaviorKind }> = [
  { match: /^(github|gitlab|bitbucket)\.com$/, kind: "development" },
  { match: /^(localhost|127\.0\.0\.1)$/, kind: "development" },
  { match: /^codesandbox\.io$|^stackblitz\.com$/, kind: "development" },
  { match: /^(chatgpt|chat\.openai)\.com$|^claude\.ai$|^gemini\.google\.com$|^copilot\.microsoft\.com$/, kind: "ai_assistance" },
  { match: /^stackoverflow\.com$|^developer\.mozilla\.org$|^docs\./, kind: "docs_search" },
  { match: /^google\.com$|^bing\.com$|^duckduckgo\.com$|^baidu\.com$/, kind: "docs_search" },
  { match: /^(mail|outlook|gmail)\.|^slack\.com$|^teams\.microsoft\.com$/, kind: "communication" },
  { match: /^notion\.so$|^confluence\./, kind: "communication" },
];

export function classifyDomain(domain: string | undefined): BehaviorKind {
  if (!domain) return "unknown";
  const d = domain.toLowerCase().replace(/^www\./, "");
  for (const r of DOMAIN_RULES) if (r.match.test(d)) return r.kind;
  return "unknown";
}

/**
 * Classify one raw event.
 *
 * `page_switch` is deliberately classified by its DESTINATION kind, not as a
 * generic "context_switch". Rationale: the primary metric (`switchCount`) is
 * already computed arithmetically in computeMetrics(). If every switch became
 * its own segment, the segment stream would be pure noise and "documents
 * dominate" could never be observed — the biggest signal would erase the
 * structure needed to explain it.
 *
 * A switch to a different KIND of destination is still visible as a
 * transition in `sequence` / `transitions`, which is where it belongs.
 */
export function classifyEvent(ev: RawEvent, prevKind: BehaviorKind | null): { kind: BehaviorKind; confidence: number } {
  switch (ev.eventType) {
    case "page_switch": {
      const kind = classifyDomain(ev.target ?? ev.source);
      if (kind === "unknown") return { kind: "context_switch", confidence: 0.9 };
      // Lower confidence than a dwell: we know where it went, not what happened.
      const changedKind = prevKind !== null && prevKind !== kind;
      return { kind, confidence: changedKind ? 0.85 : 0.8 };
    }
    case "page_visit":
    case "page_dwell": {
      // `url` is authoritative here: page_visit may carry only a url (the
      // browser extension reports `source` for switches, `url` for visits).
      const kind = classifyDomain(hostOfEvent(ev));
      return { kind: kind === "unknown" ? "unknown" : kind, confidence: kind === "unknown" ? 0.4 : 0.85 };
    }
    case "tab_change":
      return { kind: "context_switch", confidence: 0.7 };
    case "app_context": {
      const app = String(ev.metadata?.app ?? ev.source ?? "").toLowerCase();
      if (/code|idea|cursor|vim|terminal|iterm/.test(app)) return { kind: "development", confidence: 0.8 };
      return { kind: classifyDomain(ev.source), confidence: 0.6 };
    }
    case "keyboard":
    case "click":
      return { kind: prevKind ?? "development", confidence: 0.5 };
    case "session_start":
    case "task_declared":
      return { kind: "development", confidence: 0.6 };
    case "session_end":
      return { kind: prevKind ?? "unknown", confidence: 0.6 };
    default:
      return { kind: "unknown", confidence: 0.3 };
  }
}

/** Hostname for an event, preferring source/target then falling back to url. */
function hostOfEvent(ev: RawEvent): string | undefined {
  return ev.source ?? ev.target ?? hostFromUrl(ev.url);
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/* ------------------------------ segmentation ----------------------------- */

/**
 * Group consecutive events of the same kind into segments.
 *
 * A segment break happens when EITHER the kind changes OR the gap exceeds
 * `segmentGapMs`. Both matter: the first gives us "docs lookups dominate", the
 * second gives us "this focus block was only 40 seconds long".
 */
export function segment(events: RawEvent[], opts: BehaviorOptions = {}): BehaviorSegment[] {
  const { segmentGapMs, minSegmentMs } = { ...DEFAULT_BEHAVIOR_OPTIONS, ...opts };
  const sorted = sortByTs(events).filter(
    (e) => e.eventType !== "session_start" && e.eventType !== "session_end" && e.eventType !== "task_declared"
  );
  if (sorted.length === 0) return [];

  const sessionId = sorted[0].sessionId;
  const raw: BehaviorSegment[] = [];
  let current: BehaviorSegment | null = null;
  let prevKind: BehaviorKind | null = null;
  let n = 0;

  for (const ev of sorted) {
    const { kind, confidence } = classifyEvent(ev, prevKind);
    const ts = ev.timestamp;
    const gap = current ? Date.parse(ts) - Date.parse(current.endTs) : Number.POSITIVE_INFINITY;

    if (current && current.kind === kind && gap <= segmentGapMs) {
      current.endTs = ts;
      current.durationMs = Date.parse(current.endTs) - Date.parse(current.startTs);
      current.eventIds.push(ev.eventId);
      // Rolling confidence: more agreeing events → more confident.
      const n0 = current.eventIds.length;
      current.confidence = round(Math.min(0.95, (current.confidence * (n0 - 1) + confidence) / n0), 3);
    } else {
      current = {
        segmentId: counterId("seg", ++n),
        sessionId,
        taskId: opts.taskId,
        kind,
        startTs: ts,
        endTs: ts,
        durationMs: 0,
        eventIds: [ev.eventId],
        confidence: round(confidence, 3),
      };
      raw.push(current);
    }
    // Inactivity does not define the next thing that happens, so `idle` and
    // `unknown` should not erase what we last actually understood.
    if (kind !== "context_switch" && kind !== "idle" && kind !== "unknown") prevKind = kind;
  }

  return mergeTinySegments(raw, minSegmentMs);
}

/** Fold segments below the noise floor into the previous segment. */
function mergeTinySegments(segments: BehaviorSegment[], minMs: number): BehaviorSegment[] {
  if (segments.length <= 1) return segments;
  const out: BehaviorSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && seg.durationMs < minMs && prev.kind !== "context_switch") {
      prev.endTs = seg.endTs;
      prev.durationMs = Date.parse(prev.endTs) - Date.parse(prev.startTs);
      prev.eventIds.push(...seg.eventIds);
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** Session boundaries: a gap > 30 min splits sessions. */
export function splitSessions(events: RawEvent[], gapMs = 30 * 60_000): RawEvent[][] {
  const sorted = sortByTs(events);
  const out: RawEvent[][] = [];
  let cur: RawEvent[] = [];
  for (const ev of sorted) {
    if (cur.length && Date.parse(ev.timestamp) - Date.parse(cur[cur.length - 1].timestamp) > gapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(ev);
  }
  if (cur.length) out.push(cur);
  return out;
}

/* -------------------------------- metrics -------------------------------- */

export function computeMetrics(events: RawEvent[], segments: BehaviorSegment[]): BehaviorMetrics {
  const sorted = sortByTs(events);
  if (sorted.length === 0) {
    return {
      totalDwellMs: 0,
      switchCount: 0,
      switchRatePerMin: 0,
      uniqueSources: 0,
      avgDwellMs: 0,
      returnRate: 0,
      longestFocusMs: 0,
    };
  }

  const spanMs = Math.max(1, Date.parse(sorted[sorted.length - 1].timestamp) - Date.parse(sorted[0].timestamp));
  const spanMin = spanMs / 60_000;

  const switches = sorted.filter((e) => e.eventType === "page_switch" || e.eventType === "tab_change");

  const visits: string[] = sorted
    .filter((e) => e.eventType === "page_visit" || e.eventType === "page_switch")
    .map((e) => e.target ?? e.source ?? "unknown");
  const seen = new Set<string>();
  const repeatedAfterSeen = visits.filter((v) => {
    if (seen.has(v)) return true;
    seen.add(v);
    return false;
  }).length;

  const dwells = sorted.filter((e) => e.durationMs !== undefined && e.durationMs > 0).map((e) => e.durationMs!);
  const totalDwellMs = dwells.reduce((a, b) => a + b, 0);

  // Longest uninterrupted development-ish stretch, derived from segments.
  let longestFocusMs = 0;
  let run = 0;
  for (const s of segments) {
    if (s.kind === "development" || s.kind === "ai_assistance" || s.kind === "docs_search") {
      run += s.durationMs;
      longestFocusMs = Math.max(longestFocusMs, run);
    } else if (s.kind === "context_switch" || s.kind === "idle") {
      run = 0;
    }
  }

  return {
    totalDwellMs,
    switchCount: switches.length,
    switchRatePerMin: round(switches.length / Math.max(spanMin, 0.01), 3),
    uniqueSources: new Set(visits).size,
    avgDwellMs: dwells.length ? Math.round(totalDwellMs / dwells.length) : 0,
    returnRate: visits.length ? round(repeatedAfterSeen / visits.length, 3) : 0,
    longestFocusMs,
  };
}

export function computeTransitions(sequence: BehaviorKind[]): BehaviorTransition[] {
  const m = new Map<string, BehaviorTransition>();
  for (let i = 0; i + 1 < sequence.length; i++) {
    const from = sequence[i];
    const to = sequence[i + 1];
    if (from === to) continue;
    const key = `${from}>${to}`;
    const cur = m.get(key) ?? { from, to, count: 0 };
    cur.count += 1;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/* ------------------------------ entry point ------------------------------ */

export function buildBehaviorRepresentation(
  events: RawEvent[],
  opts: BehaviorOptions = {}
): BehaviorRepresentation {
  const sorted = sortByTs(events);
  const sessionId = sorted[0]?.sessionId ?? "unknown";
  const w = windowOf(sorted);
  const segments = segment(sorted, { ...opts, taskId: opts.taskId });
  const metrics = computeMetrics(sorted, segments);
  const sequence = compress(segments.map((s) => s.kind));

  return {
    representationId: shortId("br"),
    sessionId,
    windowStart: w.startTs,
    windowEnd: w.endTs,
    windowMinutes: w.minutes,
    segments,
    sequence,
    transitions: computeTransitions(sequence),
    metrics,
    evidenceIds: sorted.map((e) => e.eventId),
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
  };
}

/** Collapse consecutive duplicates — "GitHub GitHub GitHub" is one step. */
export function compress(seq: BehaviorKind[]): BehaviorKind[] {
  const out: BehaviorKind[] = [];
  for (const k of seq) if (out[out.length - 1] !== k) out.push(k);
  return out;
}

export const __internals = { mergeTinySegments, compress };
