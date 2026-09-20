/**
 * Persistence.
 *
 * A deliberately small JSON-file store. Rationale: the hackathon MVP needs
 * crash-safe state (so WAITING survives a restart) and zero setup, not a
 * database server. Every method that matters is synchronous, so a state write
 * followed by a response cannot be reordered by the event loop.
 *
 * events.jsonl is APPEND-ONLY (Principle 2). Nothing in this file may rewrite
 * an existing event line.
 */

import fs from "node:fs";
import path from "node:path";
import type { RawEvent, EventBatch } from "../shared/schemas/event.js";
import type { TaskState } from "../shared/schemas/task-state.js";
import type { HypothesisSet } from "../shared/schemas/hypothesis.js";
import type { BehaviorRepresentation } from "../shared/schemas/behavior.js";
import type { Intervention, Experiment } from "../shared/schemas/intervention.js";
import type { Verification, MemoryRecord } from "../shared/schemas/verification.js";
import type { Task } from "../shared/schemas/task.js";
import type { TimelineEntry } from "../shared/types/api.js";

export const DB_ROOT = process.env.BEHAVIOR_DEBUGGER_HOME ?? path.join(process.cwd(), ".data");

const FILES = {
  events: path.join(DB_ROOT, "events.jsonl"),
  taskStates: path.join(DB_ROOT, "task-states.json"),
  behaviors: path.join(DB_ROOT, "behaviors.json"),
  hypotheses: path.join(DB_ROOT, "hypotheses.json"),
  interventions: path.join(DB_ROOT, "interventions.json"),
  experiments: path.join(DB_ROOT, "experiments.json"),
  verifications: path.join(DB_ROOT, "verifications.json"),
  tasks: path.join(DB_ROOT, "tasks.json"),
  memory: path.join(DB_ROOT, "memory.json"),
  timeline: path.join(DB_ROOT, "timeline.json"),
  batches: path.join(DB_ROOT, "batches.json"),
} as const;

export type StoreName = keyof typeof FILES;

function ensureRoot(): void {
  fs.mkdirSync(DB_ROOT, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomic-ish write: temp file + rename. Prevents a half-written state file
 * from being read after a crash — which is exactly when the WAIT timer matters
 * most.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  ensureRoot();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/* ------------------------------- events -------------------------------- */

const eventIndex = new Map<string, Set<string>>(); // sessionId -> eventIds
const batchIndex = new Set<string>();

function hydrateEventIndex(): void {
  if (eventIndex.size > 0) return;
  for (const ev of readAllEvents()) {
    let s = eventIndex.get(ev.sessionId);
    if (!s) eventIndex.set(ev.sessionId, (s = new Set()));
    s.add(ev.eventId);
  }
  for (const b of readJson<string[]>(FILES.batches, [])) batchIndex.add(b);
}

export interface AppendOutcome {
  accepted: RawEvent[];
  duplicates: RawEvent[];
}

/**
 * Append events for a session. Idempotent on eventId — a retrying browser
 * extension must not double-count, or the switch metrics inflate.
 */
export function appendEvents(batch: EventBatch): AppendOutcome {
  hydrateEventIndex();
  ensureRoot();

  if (batch.batchId && batchIndex.has(batch.batchId)) {
    return { accepted: [], duplicates: batch.events };
  }

  let sessionIndex = eventIndex.get(batch.sessionId);
  if (!sessionIndex) eventIndex.set(batch.sessionId, (sessionIndex = new Set()));

  const accepted: RawEvent[] = [];
  const duplicates: RawEvent[] = [];
  for (const ev of batch.events) {
    if (sessionIndex.has(ev.eventId)) duplicates.push(ev);
    else accepted.push(ev);
  }

  if (accepted.length) {
    const lines = accepted.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(FILES.events, lines);
    for (const e of accepted) sessionIndex.add(e.eventId);
  }
  if (batch.batchId) {
    batchIndex.add(batch.batchId);
    writeJsonAtomic(FILES.batches, [...batchIndex]);
  }
  return { accepted, duplicates };
}

export function readAllEvents(): RawEvent[] {
  let raw = "";
  try {
    raw = fs.readFileSync(FILES.events, "utf8");
  } catch {
    return [];
  }
  const out: RawEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RawEvent);
    } catch {
      /* skip a torn line rather than lose the whole log */
    }
  }
  return out;
}

export function readEventsForSession(sessionId: string): RawEvent[] {
  return readAllEvents().filter((e) => e.sessionId === sessionId);
}

export function listSessions(): string[] {
  const ids = new Set(readAllEvents().map((e) => e.sessionId));
  for (const s of readJson<TaskState[]>(FILES.taskStates, [])) ids.add(s.sessionId);
  return [...ids].sort();
}

/* --------------------------- single-row state --------------------------- */

function upsert<T extends { sessionId: string }>(file: string, row: T): T {
  const rows = readJson<T[]>(file, []);
  const i = rows.findIndex((r) => r.sessionId === row.sessionId);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  writeJsonAtomic(file, rows);
  return row;
}

function readOne<T extends { sessionId: string }>(file: string, sessionId: string): T | null {
  return readJson<T[]>(file, []).find((r) => r.sessionId === sessionId) ?? null;
}

/** ★ The single write that makes WAITING survive a process restart. */
export function saveTaskState(state: TaskState): TaskState {
  return upsert(FILES.taskStates, state);
}

export function loadTaskState(sessionId: string): TaskState | null {
  return readOne<TaskState>(FILES.taskStates, sessionId);
}

export function allTaskStates(): TaskState[] {
  return readJson<TaskState[]>(FILES.taskStates, []);
}

/** Sessions currently parked in WAITING — the scheduler's recovery scan. */
export function waitingStates(): TaskState[] {
  return allTaskStates().filter((s) => s.phase === "WAITING" && !!s.waitUntil);
}

export function saveBehavior(repr: BehaviorRepresentation): BehaviorRepresentation {
  return upsert(FILES.behaviors, repr);
}

export function loadBehavior(sessionId: string): BehaviorRepresentation | null {
  return readOne<BehaviorRepresentation>(FILES.behaviors, sessionId);
}

export function saveHypothesisSet(set: HypothesisSet): HypothesisSet {
  return upsert(FILES.hypotheses, set);
}

export function loadHypothesisSet(sessionId: string): HypothesisSet | null {
  return readOne<HypothesisSet>(FILES.hypotheses, sessionId);
}

export function saveTask(task: Task): Task {
  return upsert(FILES.tasks, task);
}

export function loadTask(sessionId: string): Task | null {
  return readOne<Task>(FILES.tasks, sessionId);
}

/* -------------------------- append-only records -------------------------- */

function appendRow<T>(file: string, row: T): T {
  const rows = readJson<T[]>(file, []);
  rows.push(row);
  writeJsonAtomic(file, rows);
  return row;
}

function replaceRow<T extends Record<string, unknown>>(
  file: string,
  match: (r: T) => boolean,
  row: T
): T {
  const rows = readJson<T[]>(file, []);
  const i = rows.findIndex(match);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  writeJsonAtomic(file, rows);
  return row;
}

export function saveIntervention(i: Intervention): Intervention {
  return upsert(FILES.interventions, i as unknown as Intervention & { sessionId: string });
}

export function loadIntervention(sessionId: string): Intervention | null {
  return readOne<Intervention>(FILES.interventions, sessionId);
}

export function saveExperiment(e: Experiment): Experiment {
  return replaceRow<Experiment & Record<string, unknown>>(
    FILES.experiments,
    (r) => r.experimentId === e.experimentId,
    e as Experiment & Record<string, unknown>
  );
}

export function loadExperiment(sessionId: string): Experiment | null {
  const rows = readJson<Experiment[]>(FILES.experiments, []);
  return rows.filter((r) => r.sessionId === sessionId).pop() ?? null;
}

export function saveVerification(v: Verification): Verification {
  return replaceRow<Verification & Record<string, unknown>>(
    FILES.verifications,
    (r) => r.verificationId === v.verificationId,
    v as Verification & Record<string, unknown>
  );
}

export function loadVerification(sessionId: string): Verification | null {
  const rows = readJson<Verification[]>(FILES.verifications, []);
  return rows.filter((r) => r.sessionId === sessionId).pop() ?? null;
}

export function appendMemory(m: MemoryRecord): MemoryRecord {
  return appendRow(FILES.memory, m);
}

export function readMemory(sessionId?: string): MemoryRecord[] {
  const rows = readJson<MemoryRecord[]>(FILES.memory, []);
  return sessionId ? rows.filter((r) => r.sessionId === sessionId) : rows;
}

export function appendTimeline(sessionId: string, entry: TimelineEntry): void {
  const all = readJson<Record<string, TimelineEntry[]>>(FILES.timeline, {});
  (all[sessionId] ??= []).push(entry);
  writeJsonAtomic(FILES.timeline, all);
}

export function readTimeline(sessionId: string): TimelineEntry[] {
  return readJson<Record<string, TimelineEntry[]>>(FILES.timeline, {})[sessionId] ?? [];
}

/** Test/demo helper: wipe a session's derived state without touching events. */
export function resetDerivedState(sessionId: string): void {
  const states = readJson<TaskState[]>(FILES.taskStates, []).filter((s) => s.sessionId !== sessionId);
  writeJsonAtomic(FILES.taskStates, states);
  const t = readJson<Record<string, TimelineEntry[]>>(FILES.timeline, {});
  delete t[sessionId];
  writeJsonAtomic(FILES.timeline, t);
}

export function resetEverything(): void {
  for (const f of Object.values(FILES)) {
    try {
      if (f.endsWith(".jsonl")) fs.writeFileSync(f, "");
      else fs.writeFileSync(f, "[]\n");
    } catch {
      /* best effort */
    }
  }
  eventIndex.clear();
  batchIndex.clear();
}

export const PATHS = FILES;
