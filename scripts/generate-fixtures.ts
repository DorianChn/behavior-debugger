/**
 * Generate the demo fixtures as JSON.
 *
 *   npm run fixtures:generate
 *
 * Writes `tests/fixtures/*.json` so the synthetic sessions can be inspected,
 * diffed, or replayed without running the generator. The same data is produced
 * in-process by `collector/src/adapters/synthetic.ts`; this script exists so the
 * fixtures are reviewable artifacts rather than something you have to trust.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSession,
  BASELINE_PROFILE,
  IMPROVED_PROFILE,
  SPARSE_PROFILE,
  type SessionProfile,
} from "../collector/src/adapters/synthetic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "tests", "fixtures");

const PROFILES: Array<{ name: string; profile: SessionProfile; note: string }> = [
  { name: "baseline", profile: BASELINE_PROFILE, note: "The problem case: 21 switches / 30 min. Reaches READY." },
  { name: "improved", profile: IMPROVED_PROFILE, note: "The post-intervention case: 8 switches / 30 min." },
  { name: "sparse", profile: SPARSE_PROFILE, note: "Deliberately thin: 8 events / 3 min. Triggers a real WAIT." },
];

fs.mkdirSync(outDir, { recursive: true });

const index: Array<{ name: string; file: string; events: number; note: string }> = [];

for (const { name, profile, note } of PROFILES) {
  const events = buildSession(profile);
  const file = `${name}.json`;
  fs.writeFileSync(
    path.join(outDir, file),
    JSON.stringify(
      {
        name,
        note,
        profile,
        generatedCount: events.length,
        // The first and last timestamps make the observation span obvious at a
        // glance, without having to read the whole array.
        span: { start: events[0]?.timestamp ?? null, end: events[events.length - 1]?.timestamp ?? null },
        events,
      },
      null,
      2
    ) + "\n"
  );
  index.push({ name, file, events: events.length, note });
  console.log(`  ${name.padEnd(10)} ${String(events.length).padStart(4)} events  →  tests/fixtures/${file}`);
}

fs.writeFileSync(
  path.join(outDir, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), fixtures: index }, null, 2) + "\n"
);

console.log(`\n  wrote ${index.length} fixtures to tests/fixtures/`);
