/**
 * One-command demo runner.
 *
 * Boots the API on an ephemeral port with a scratch data root and a fast WAIT
 * clock, runs `scripts/demo.ts` against it, then tears everything down.
 *
 *   npm run demo:fast
 *
 * Doing this in one process is deliberate: it means the demo is reproducible
 * from a clean checkout with no ports to pick and no stale data to clear.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// A throwaway data root so the demo never touches real state.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bd-demo-"));
const port = 4000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  PORT: String(port),
  BEHAVIOR_DEBUGGER_HOME: dataRoot,
  // Collapse the WAIT clock so the demo finishes in seconds instead of minutes.
  // The DEADLINE SEMANTICS are unchanged — only the delay is scaled.
  WAIT_TIME_SCALE: process.env.WAIT_TIME_SCALE ?? "0.02",
  FORCE_COLOR: "1",
};

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  return spawn(cmd, args, { cwd: root, env: { ...env, ...opts.env }, stdio: "inherit", shell: false });
}

const server = run(process.execPath, ["--import", "tsx", "server.ts"]);

/** Poll /api/health until the server answers, or give up. */
async function waitForServer(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function cleanup() {
  server.kill("SIGTERM");
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

let exitCode = 1;
try {
  if (!(await waitForServer())) {
    console.error(`\n[demo] the API did not come up on ${base} within 20s.`);
    cleanup();
    process.exit(1);
  }

  exitCode = await new Promise<number>((resolve) => {
    const demo = run(process.execPath, ["--import", "tsx", "scripts/demo.ts", base]);
    demo.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  cleanup();
}

process.exit(exitCode);
