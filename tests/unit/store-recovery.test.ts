import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.BEHAVIOR_DEBUGGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bd-store-"));

const store = await import("../../database/store.js");

test("resetEverything preserves the timeline store shape", () => {
  fs.mkdirSync(path.dirname(store.PATHS.timeline), { recursive: true });
  store.resetEverything();

  assert.deepEqual(JSON.parse(fs.readFileSync(store.PATHS.timeline, "utf8")), {});

  const entry = {
    at: "2026-09-21T00:00:00.000Z",
    phase: "OBSERVING" as const,
    label: "started",
    detail: "session started",
  };
  store.appendTimeline("session-1", entry);

  assert.deepEqual(store.readTimeline("session-1"), [entry]);
});
