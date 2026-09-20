/**
 * Synthetic session generator.
 *
 * Two jobs:
 *  1. Produce the recorded fixtures the whole team develops against, so nobody
 *     waits on real data. Deterministic given a seed.
 *  2. Drive the hackathon demo without needing a live browser.
 *
 * The "before" profile reproduces the scenario in the spec: 21 page switches
 * in 30 minutes across GitHub / StackOverflow / Google / ChatGPT.
 */

import { EVENT_SCHEMA_VERSION, type RawEvent } from "../../../shared/schemas/event.js";
import { counterId } from "../../../shared/utils/ids.js";

export interface SessionProfile {
  sessionId: string;
  /** Simulated start time (ISO). */
  startedAt: string;
  /** Total simulated minutes. */
  minutes: number;
  /** How many switches per minute to generate. */
  switchesPerMinute: number;
  /** Sources the user moves between. */
  sources: string[];
  /** Insert dwell events (richer data, drives kind classification). */
  withDwell?: boolean;
  /** Insert session_start / session_end bookends. */
  withBookends?: boolean;
}

export const DEFAULT_SOURCES = ["github.com", "stackoverflow.com", "google.com", "chatgpt.com"];

/** The canonical "problem" profile: 21 switches / 30 min. */
export const BASELINE_PROFILE: SessionProfile = {
  sessionId: "session_001",
  startedAt: "2026-09-20T10:00:00.000Z",
  minutes: 30,
  switchesPerMinute: 0.7, // 0.7 * 30 = 21 switches
  sources: DEFAULT_SOURCES,
  withDwell: true,
  withBookends: true,
};

/** The post-intervention profile: 8 switches / 30 min. */
export const IMPROVED_PROFILE: SessionProfile = {
  sessionId: "session_002",
  startedAt: "2026-09-20T11:00:00.000Z",
  minutes: 30,
  switchesPerMinute: 0.2667, // ≈ 8 switches
  sources: DEFAULT_SOURCES,
  withDwell: true,
  withBookends: true,
};

/** A deliberately thin session, to exercise the WAIT branch. */
export const SPARSE_PROFILE: SessionProfile = {
  sessionId: "session_sparse",
  startedAt: "2026-09-20T13:00:00.000Z",
  minutes: 3,
  switchesPerMinute: 0.6,
  sources: ["github.com", "google.com"],
  withDwell: true,
  withBookends: false,
};

/** Multiple sessions to prove session isolation. */
export const ISOLATION_PROFILES: SessionProfile[] = [
  { ...BASELINE_PROFILE, sessionId: "session_A" },
  { ...IMPROVED_PROFILE, sessionId: "session_B" },
];

function at(startedAt: string, offsetMinutes: number): string {
  return new Date(Date.parse(startedAt) + offsetMinutes * 60_000).toISOString();
}

/**
 * Build a session. Events are emitted in timestamp order and every event is
 * shape-valid against the frozen RawEvent contract.
 *
 * Event ids are namespaced with the session id AND the start time. Two batches
 * for the same session must not collide, or the ingestor's idempotency check
 * (correctly) treats the second batch as a replay and drops it — which looks
 * exactly like "the improved data never arrived".
 */
export function buildSession(p: SessionProfile): RawEvent[] {
  const events: RawEvent[] = [];
  let n = 0;
  // Stable per-batch namespace: session + start instant.
  const ns = `${p.sessionId}_${Date.parse(p.startedAt).toString(36)}`;
  const next = () => `${ns}_${counterId("ev", ++n)}`;

  const push = (e: Omit<RawEvent, "schemaVersion">) => {
    events.push({ ...e, schemaVersion: EVENT_SCHEMA_VERSION });
  };

  if (p.withBookends) {
    push({
      eventId: next(),
      timestamp: at(p.startedAt, 0),
      eventType: "task_declared",
      sessionId: p.sessionId,
      source: p.sources[0],
      metadata: { goal: "Ship the auth refactor", declaredBy: "user" },
    });
  }

  const totalSwitches = Math.max(1, Math.round(p.switchesPerMinute * p.minutes));
  const step = p.minutes / totalSwitches;

  for (let i = 0; i < totalSwitches; i++) {
    const t = p.startedAt ? at(p.startedAt, i * step) : "";
    const from = p.sources[i % p.sources.length];
    const to = p.sources[(i + 1) % p.sources.length];

    push({
      eventId: next(),
      timestamp: t,
      eventType: "page_visit",
      sessionId: p.sessionId,
      url: `https://${to}/`,
      title: `Page on ${to}`,
    });

    push({
      eventId: next(),
      timestamp: t,
      eventType: "page_switch",
      sessionId: p.sessionId,
      source: from,
      target: to,
      durationMs: Math.round(step * 60_000),
    });

    if (p.withDwell) {
      push({
        eventId: next(),
        timestamp: at(p.startedAt, i * step + step * 0.5),
        eventType: "page_dwell",
        sessionId: p.sessionId,
        source: to,
        target: to,
        durationMs: Math.round(step * 60_000 * 0.5),
      });
    }

    push({
      eventId: next(),
      timestamp: at(p.startedAt, i * step + step * 0.6),
      eventType: "click",
      sessionId: p.sessionId,
      source: to,
      metadata: { element: "link" },
    });
  }

  if (p.withBookends) {
    push({
      eventId: next(),
      timestamp: at(p.startedAt, p.minutes),
      eventType: "session_end",
      sessionId: p.sessionId,
      source: p.sources[p.sources.length - 1],
    });
  }

  return events;
}

export function buildAllFixtures(): RawEvent[] {
  return [...buildSession(BASELINE_PROFILE), ...buildSession(IMPROVED_PROFILE), ...buildSession(SPARSE_PROFILE)];
}
