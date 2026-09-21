import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveContainedPath } from "../../shared/utils/static-path.js";

test("resolveContainedPath accepts files inside the static root", () => {
  const root = path.resolve("tmp", "frontend");
  assert.equal(resolveContainedPath(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(resolveContainedPath(root, "/assets/app.js"), path.join(root, "assets", "app.js"));
});

test("resolveContainedPath rejects traversal and same-prefix sibling paths", () => {
  const root = path.resolve("tmp", "frontend");
  for (const requestPath of [
    "/../package.json",
    "/../../etc/passwd",
    "/../frontend-evil/secret.txt",
    "/..\\frontend-evil\\secret.txt",
  ]) {
    assert.equal(resolveContainedPath(root, requestPath), null, requestPath);
  }
});
