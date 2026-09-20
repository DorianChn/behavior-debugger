/**
 * The ONLY place time windows are computed.
 *
 * Integration risk R7: if behavior/ and verification/ each roll their own
 * window function, before/after numbers stop being comparable. Every module
 * must import from here.
 */

import type { RawEvent } from "../schemas/event.js";
import type { TimeWindow } from "../schemas/intervention.js";

export const MINUTE_MS = 60_000;

export function minutesBetween(a: string, b: string): number {
  return Math.round(((Date.parse(b) - Date.parse(a)) / MINUTE_MS) * 100) / 100;
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}

export function isWithin(ts: string, w: TimeWindow): boolean {
  const t = Date.parse(ts);
  return t >= Date.parse(w.start) && t <= Date.parse(w.end);
}

export function eventsInWindow(events: RawEvent[], w: TimeWindow, sessionId?: string): RawEvent[] {
  return events.filter(
    (e) => isWithin(e.timestamp, w) && (sessionId === undefined || e.sessionId === sessionId)
  );
}

export function eventsInRange(events: RawEvent[], start: string, end: string, sessionId?: string): RawEvent[] {
  return eventsInWindow(events, { start, end }, sessionId);
}

/**
 * Split a span into a fixed-length window so before/after comparisons are
 * always made over the SAME duration — otherwise a shorter post window looks
 * like an improvement purely because it contains fewer events.
 */
export function trailingWindow(endTs: string, minutes: number): TimeWindow {
  return { start: addMinutes(endTs, -minutes), end: endTs };
}

/** Normalize a comparison to a span of exactly `minutes`, anchored at `anchor`. */
export function normalizeWindow(w: TimeWindow, minutes: number, anchor: "start" | "end" = "end"): TimeWindow {
  return anchor === "end" ? trailingWindow(w.end, minutes) : { start: w.start, end: addMinutes(w.start, minutes) };
}

export function sortByTs(events: RawEvent[]): RawEvent[] {
  return [...events].sort((a, b) => {
    const d = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return d !== 0 ? d : a.eventId.localeCompare(b.eventId);
  });
}

export function spanOf(events: RawEvent[]): number {
  if (events.length < 2) return 0;
  const s = sortByTs(events);
  return Date.parse(s[s.length - 1].timestamp) - Date.parse(s[0].timestamp);
}

/** Human label used by the frontend, e.g. "30 minutes". */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
