/**
 * RawEvent — the immutable factual layer.
 *
 * Principle 2 (Immutable Raw Events): once an event is persisted it is NEVER
 * updated. Corrections are appended as new events. Every downstream module
 * (behavior / reasoning / verification) cites `eventId` values to prove its
 * claims, so the evidence chain always resolves back to a fact.
 *
 * This module must never import from collector/, behavior/ or reasoning/.
 */

export const EVENT_SCHEMA_VERSION = "1.0" as const;

/** Event taxonomy. Keep small and stable; new kinds require a schema RFC. */
export const EVENT_TYPES = [
  "page_visit",
  "page_switch",
  "page_dwell",
  "click",
  "keyboard",
  "tab_change",
  "app_context",
  "session_start",
  "session_end",
  "task_declared",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** High-signal events that drive behavior segmentation. */
export const BEHAVIORAL_EVENTS: readonly EventType[] = [
  "page_visit",
  "page_switch",
  "page_dwell",
  "tab_change",
  "app_context",
];

export interface RawEvent {
  /** uuid v4 — also the idempotency key for ingest. */
  eventId: string;
  /** ISO 8601 UTC, e.g. 2026-09-20T10:01:23.000Z */
  timestamp: string;
  eventType: EventType;
  sessionId: string;
  /** Origin of the event, e.g. "github.com" (already normalized). */
  source?: string;
  /** Destination of the event, e.g. "stackoverflow.com". */
  target?: string;
  /** Dwell duration in milliseconds. */
  durationMs?: number;
  /** Normalized URL — tracking params stripped by collector/normalizer. */
  url?: string;
  title?: string;
  /** Free-form, module-scoped. Never store secrets or raw keystrokes. */
  metadata?: Record<string, unknown>;
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
}

/** JSON Schema (draft 2020-12) mirror — used for runtime validation. */
export const RawEventJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "behavior-debugger/RawEvent",
  title: "RawEvent",
  type: "object",
  required: ["eventId", "timestamp", "eventType", "sessionId", "schemaVersion"],
  additionalProperties: false,
  properties: {
    eventId: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    eventType: { type: "string", enum: [...EVENT_TYPES] },
    sessionId: { type: "string", minLength: 1 },
    source: { type: "string" },
    target: { type: "string" },
    durationMs: { type: "number", minimum: 0 },
    url: { type: "string" },
    title: { type: "string" },
    metadata: { type: "object" },
    schemaVersion: { type: "string", const: EVENT_SCHEMA_VERSION },
  },
} as const;

export interface EventBatch {
  sessionId: string;
  events: RawEvent[];
  /** Client-supplied batch id; a repeated batchId is dropped by the ingestor. */
  batchId?: string;
}

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}
