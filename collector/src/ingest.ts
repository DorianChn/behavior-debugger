/**
 * Raw event collector.
 *
 * Boundary rule (Principle 1, Loose Coupling): this module NEVER imports an
 * LLM client. It validates, normalizes, dedupes, and appends. Nothing here
 * interprets what the events mean.
 *
 * Replaceable by design: `adapters/` holds transport-specific shims (browser
 * extension, SDK, log file) and all of them funnel through `ingest()`.
 */

import {
  EVENT_SCHEMA_VERSION,
  type EventBatch,
  type RawEvent,
} from "../../shared/schemas/event.js";
import { SchemaError, validateRawEvent } from "../../shared/schemas/validate.js";
import type { IngestResult } from "../../shared/types/api.js";
import { appendEvents, readEventsForSession } from "../../database/store.js";

/** Tracking parameters whose removal keeps metrics stable across a session. */
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "ref", "ref_src", "_ga", "spm", "from",
];

/**
 * Normalize a URL for grouping: strip hash, tracking params, trailing slash,
 * and lowercase the host. Without this, the same page counts as three sources
 * and `uniqueSources` — which drives a hypothesis — becomes meaningless.
 */
export function normalizeUrl(input: string | undefined): string | undefined {
  if (!input) return undefined;
  try {
    const u = new URL(input);
    u.hash = "";
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let s = u.toString();
    s = s.replace(/\/$/, "");
    return s;
  } catch {
    return input;
  }
}

/** Hostname of a URL, used as the default `source`/`target` label. */
export function hostOf(input: string | undefined): string | undefined {
  if (!input) return undefined;
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return input;
  }
}

/**
 * Fill in derived fields without ever overwriting a caller-supplied value.
 * Deterministic, so replaying the same fixture yields identical output.
 */
export function normalizeEvent(raw: RawEvent): RawEvent {
  const url = normalizeUrl(raw.url);
  const derivedSource = raw.source ?? hostOf(url) ?? hostOf(raw.target);
  const out: RawEvent = {
    eventId: raw.eventId,
    timestamp: new Date(raw.timestamp).toISOString(),
    eventType: raw.eventType,
    sessionId: raw.sessionId,
    schemaVersion: EVENT_SCHEMA_VERSION,
  };
  if (derivedSource !== undefined) out.source = derivedSource;
  if (raw.target !== undefined) out.target = hostOf(raw.target) ?? raw.target;
  if (raw.durationMs !== undefined) out.durationMs = raw.durationMs;
  if (url !== undefined) out.url = url;
  if (raw.title !== undefined) out.title = raw.title;
  if (raw.metadata !== undefined) out.metadata = raw.metadata;
  return out;
}

export interface IngestOptions {
  /**
   * When true (default) a malformed event is recorded as a rejected issue and
   * the rest of the batch still lands. Set false for strict CI fixtures.
   */
  skipInvalid?: boolean;
}

/**
 * The single entry point for all transports.
 *
 * Fail-closed on shape, fail-open on volume: one bad event must not lose the
 * evidence from the other 200 in the same batch.
 */
export function ingest(batch: EventBatch, opts: IngestOptions = {}): IngestResult {
  const skipInvalid = opts.skipInvalid ?? true;
  const issues: IngestResult["issues"] = [];
  const valid: RawEvent[] = [];

  for (const candidate of batch.events) {
    try {
      valid.push(normalizeEvent(validateRawEvent(candidate)));
    } catch (err) {
      if (err instanceof SchemaError) {
        for (const i of err.issues) issues.push({ eventId: (candidate as RawEvent)?.eventId, path: i.path, message: i.message });
      } else {
        issues.push({ path: "$", message: err instanceof Error ? err.message : String(err) });
      }
      if (!skipInvalid) break;
    }
  }

  const accepted = appendEvents({
    sessionId: batch.sessionId,
    batchId: batch.batchId,
    events: valid,
  });

  return {
    accepted: accepted.accepted.length,
    duplicates: accepted.duplicates.length,
    rejected: issues.length,
    issues,
    sessionId: batch.sessionId,
    totalForSession: readEventsForSession(batch.sessionId).length,
  };
}

/** Convenience for the browser extension and demo scripts. */
export function ingestOne(event: RawEvent, opts?: IngestOptions): IngestResult {
  return ingest({ sessionId: event.sessionId, events: [event] }, opts);
}
