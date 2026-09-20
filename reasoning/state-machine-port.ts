/**
 * Re-export shim so reasoning/engine.ts and service/ can import phase helpers
 * without creating a cycle through state-machine.ts → scheduler.ts.
 */
export {
  transition,
  initialState,
  onEventsAppended,
  describe,
  IllegalTransitionError,
  TRANSITIONS,
  VALID_EVENTS,
} from "./state-machine.js";
export { applyEvent, tryApplyEvent, WaitScheduler, bootstrapScheduler, forceExpireWaits } from "./scheduler.js";
