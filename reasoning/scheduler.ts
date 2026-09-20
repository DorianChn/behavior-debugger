/**
 * The scheduler — persistence and timers for the Deferred Intelligence loop.
 *
 * Split deliberately from state-machine.ts: that file decides WHAT the next
 * phase is (pure, testable), this file decides WHEN to wake up (IO, clock).
 *
 * The critical behaviour is `recoverPendingWaits()`. On boot it scans for
 * sessions parked in WAITING and resumes them. That is the operational proof
 * that WAIT is a real state: kill the process mid-wait, restart, and the system
 * picks up where it left off instead of forgetting the whole thread.
 */

import type { DebuggerPhase, PhaseEvent, TaskState } from "../shared/schemas/task-state.js";
import type { TimelineEntry } from "../shared/types/api.js";
import { appendTimeline, allTaskStates, loadTaskState, saveTaskState, waitingStates } from "../database/store.js";
import { transition } from "./state-machine.js";

const PHASE_LABELS_ZH: Record<DebuggerPhase, string> = {
  OBSERVING: "观测中 Observing",
  INSUFFICIENT: "证据不足 Insufficient",
  WAITING: "等待更多证据 WAITING",
  RE_EVALUATING: "重新评估 Re-evaluating",
  READY: "可以诊断 READY",
  DIAGNOSING: "诊断中 Diagnosing",
  INTERVENING: "干预中 Intervening",
  VERIFYING: "验证中 Verifying",
  LEARNED: "已学习 Learned",
};

function label(phase: DebuggerPhase): string {
  return PHASE_LABELS_ZH[phase] ?? phase;
}

/**
 * Apply a phase event, persist, and record a timeline entry.
 *
 * Ordering matters: state is written to disk BEFORE the timeline entry and
 * before any listener is notified, so a crash cannot leave the two out of sync
 * in a way that hides a quarantine-style state change.
 */
export function applyEvent(state: TaskState, event: PhaseEvent): TaskState {
  const next = transition(state, event);
  saveTaskState(next);
  const entry: TimelineEntry = {
    at: event.at,
    phase: next.phase,
    label: label(next.phase),
    detail: next.note ?? event.type,
  };
  appendTimeline(next.sessionId, entry);
  return next;
}

/** Safe variant: returns null instead of throwing on an illegal transition. */
export function tryApplyEvent(state: TaskState, event: PhaseEvent): { state: TaskState; applied: boolean; error?: string } {
  try {
    return { state: applyEvent(state, event), applied: true };
  } catch (err) {
    return { state, applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ----------------------------- timer registry ---------------------------- */

type WakeCallback = (sessionId: string) => void;

interface TimerHandle {
  sessionId: string;
  dueAt: number;
  timer: NodeJS.Timeout;
}

export class WaitScheduler {
  private timers = new Map<string, TimerHandle>();
  private readonly onWake: WakeCallback;
  /** Multiplier applied to wait durations — the demo sets this < 1 to speed up. */
  readonly timeScale: number;

  constructor(onWake: WakeCallback, opts: { timeScale?: number } = {}) {
    this.onWake = onWake;
    this.timeScale = opts.timeScale ?? Number(process.env.WAIT_TIME_SCALE ?? "1");
  }

  /** Arm a timer for a session currently in WAITING. Idempotent per session. */
  arm(state: TaskState, now: Date = new Date()): number {
    if (state.phase !== "WAITING" || !state.waitUntil) return -1;
    this.cancel(state.sessionId);

    const realDue = Date.parse(state.waitUntil);
    const scaledDelay = Math.max(0, (realDue - now.getTime()) * this.timeScale);
    const delay = Math.max(0, Math.min(scaledDelay, 2_147_483_647));

    const timer = setTimeout(() => {
      this.timers.delete(state.sessionId);
      const current = loadTaskState(state.sessionId);
      if (!current || current.phase !== "WAITING") return; // already moved on
      // Re-check the wall clock: on a scaled clock the deadline may not be due
      // yet in logical time, in which case we simply re-arm.
      const due = Date.parse(current.waitUntil ?? "");
      if (Number.isFinite(due) && due > Date.now() && this.timeScale >= 1) {
        this.arm(current);
        return;
      }
      this.onWake(state.sessionId);
    }, delay);

    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(state.sessionId, { sessionId: state.sessionId, dueAt: realDue, timer });
    return delay;
  }

  cancel(sessionId: string): void {
    const h = this.timers.get(sessionId);
    if (h) {
      clearTimeout(h.timer);
      this.timers.delete(sessionId);
    }
  }

  cancelAll(): void {
    for (const h of this.timers.values()) clearTimeout(h.timer);
    this.timers.clear();
  }

  /** Sessions with a live timer — surfaced by /api/health for the demo. */
  pending(): Array<{ sessionId: string; dueAt: string; inMs: number }> {
    const now = Date.now();
    return [...this.timers.values()].map((h) => ({
      sessionId: h.sessionId,
      dueAt: new Date(h.dueAt).toISOString(),
      inMs: Math.max(0, Math.round((h.dueAt - now) * this.timeScale)),
    }));
  }

  /**
   * ★ Restart recovery. Any session left in WAITING by a previous process is
   * re-armed (or woken immediately if its deadline already passed).
   */
  recoverPendingWaits(now: Date = new Date()): Array<{ sessionId: string; action: "woke" | "rearmed" }> {
    const out: Array<{ sessionId: string; action: "woke" | "rearmed" }> = [];
    for (const state of waitingStates()) {
      const due = Date.parse(state.waitUntil ?? "");
      if (!Number.isFinite(due)) {
        out.push({ sessionId: state.sessionId, action: "rearmed" });
        continue;
      }
      const overdue = due <= now.getTime();
      if (overdue && this.timeScale >= 1) {
        this.onWake(state.sessionId);
        out.push({ sessionId: state.sessionId, action: "woke" });
      } else {
        this.arm(state, now);
        out.push({ sessionId: state.sessionId, action: "rearmed" });
      }
    }
    return out;
  }
}

/** Force-wake every WAITING session — used by the demo's "fast forward". */
export function forceExpireWaits(scheduler: WaitScheduler): string[] {
  const woken: string[] = [];
  for (const state of waitingStates()) {
    scheduler.cancel(state.sessionId);
    try {
      const next = applyEvent(state, { type: "WAIT_EXPIRED", at: new Date().toISOString() });
      void next;
      woken.push(state.sessionId);
    } catch {
      /* not in a state that allows expiry; skip */
    }
  }
  return woken;
}

/** Re-arm everything after a restart, logging what was recovered. */
export function bootstrapScheduler(scheduler: WaitScheduler): void {
  const recovered = scheduler.recoverPendingWaits();
  if (recovered.length) {
    console.error(
      `[reasoning] recovered ${recovered.length} pending WAIT state(s): ` +
        recovered.map((r) => `${r.sessionId}(${r.action})`).join(", ")
    );
  }
  const total = allTaskStates().length;
  console.error(`[reasoning] scheduler online — ${total} tracked session(s), WAIT time scale ×${scheduler.timeScale}`);
}

export { PHASE_LABELS_ZH };
