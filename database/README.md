# Storage model

Behavior Debugger stores everything under one directory — `BEHAVIOR_DEBUGGER_HOME`,
defaulting to `<repo>/.data`. The tests point it at a temp directory, which is how they
get isolation without a test database.

```
$BEHAVIOR_DEBUGGER_HOME/
├── events.jsonl        append-only raw events        ← never updated
├── task-states.json    TaskState per session
├── behaviors.json      BehaviorRepresentation per session
├── hypotheses.json     HypothesisSet per session
├── interventions.json  Intervention per session
├── experiments.json    Experiment per session
├── verifications.json  Verification per session
├── memory.json         learned lessons
└── timelines/
    └── <sessionId>.jsonl   phase transitions, one JSON object per line
```

## Why JSONL for events, JSON for state

**Events are append-only.** A JSONL file can be appended to without reading it, and
`cat`-ing it shows exactly what the system observed. `RawEvent`s are never updated or
deleted — every downstream artifact is a derivation, so the raw log is the ground
truth for every claim the system makes.

**State is small and replaced wholesale.** A `TaskState` is a few hundred bytes and
changes atomically. Reading and rewriting a JSON array is simpler and less error-prone
than a log-structured store at this scale.

Swapping in SQLite would touch only `database/store.ts` — nothing else imports `fs`.

## Idempotent ingest

`appendEvents()` dedupes on **two** keys:

- `eventId` — the same event sent twice is written once
- `batchId` — a replayed batch is a no-op

`IngestResult` reports what happened:

```ts
{ accepted, duplicates, rejected, issues: [{ eventId?, path, message }], sessionId, totalForSession }
```

Ingest is **fail-open on volume**: one malformed event does not lose the batch. The bad
event is counted in `rejected` with a path to the offending field, and the valid events
are kept. The integration test asserts that a batch of 10 with 1 bad event yields
`rejected === 1` and `issues.length >= 1` — one bad event can produce several issues,
so the test asserts attribution rather than an exact count.

### The collision trap

Fixture generators must namespace their event IDs. `buildSession()` derives them from
the session ID **and** the start instant:

```ts
const ns = `${p.sessionId}_${Date.parse(p.startedAt).toString(36)}`;
```

Without the start instant, loading `baseline` twice into one session generates
colliding IDs — and the (correct) dedupe then silently drops an entire batch. This
exactly was the bug that made the closed loop appear broken: the "improved" batch was
dropped as duplicates, and verification reported `INCONCLUSIVE` for the wrong reason.

## Wait recovery reads `task-states.json`

`waitingStates()` filters for `phase === "WAITING" && !!waitUntil`. This is the query
the restart guarantee rests on:

```ts
export function waitingStates(): TaskState[] {
  return allTaskStates().filter((s) => s.phase === "WAITING" && !!s.waitUntil);
}
```

`WaitScheduler.recoverPendingWaits()` iterates it on boot and either re-arms each
session or fires it immediately if the deadline already passed.

Note that this scans **all** sessions in the store, not just one. Tests must therefore
scope their assertions to the session under test — asserting `recovered.length === 1`
would be wrong whenever an earlier test left a session parked.

## Timelines

Each session gets its own `.jsonl` under `timelines/`. `applyEvent()` writes the state
**before** the timeline entry:

```ts
export function applyEvent(state: TaskState, event: PhaseEvent): TaskState {
  const next = transition(state, event);
  saveTaskState(next);                     // ← persisted first
  appendTimeline(next.sessionId, entry);   // ← then recorded
  return next;
}
```

A crash between the two leaves a *recoverable* state with a slightly short audit trail.
The reverse order would risk recording a phase change that never actually took effect —
which is the dangerous direction, because a resume would trust the record.

## Migrations

There is no migration framework: schemas carry an explicit version field
(`EVENT_SCHEMA_VERSION = "1.0"`, etc.). The strategy is **replay, not migrate** —
because raw events are immutable and every derivation is recomputable, a schema change
means deleting the derived files and re-running the evaluation:

```bash
# wipe derived state, keep the raw event log
rm -f "$BEHAVIOR_DEBUGGER_HOME"/{task-states,behaviors,hypotheses,interventions,experiments,verifications}.json
rm -rf "$BEHAVIOR_DEBUGGER_HOME"/timelines
npm start   # re-derives on first request
```

`resetEverything()` in `store.ts` does this programmatically.

The event log itself must never be migrated in place. If the event schema beyond 1.0
ever changes shape incompatibly, the honest approach is a new
`EVENT_SCHEMA_VERSION` and an upcast step at read time — never rewriting history.

## Seed data

```bash
npm run fixtures:generate   # writes tests/fixtures/{baseline,improved,sparse}.json
```

To load a seeded session through the API:

```bash
curl -X POST -H 'content-type: application/json' \
     -d '{"profile":"baseline"}' http://127.0.0.1:4317/api/demo/load
```

Profiles are defined in `collector/src/adapters/synthetic.ts` and mirrored in
`server.ts`. `baseline` reaches `READY`; `improved` is the post-intervention window;
`sparse` deliberately triggers a real `WAIT`.
