import path from "node:path";

/** Resolve a URL path only when it stays inside the requested directory. */
export function resolveContainedPath(root: string, requestPath: string): string | null {
  const rootPath = path.resolve(root);
  const relativeRequest = requestPath === "/" ? "index.html" : requestPath.replace(/^[/\\]+/, "");
  const candidate = path.resolve(rootPath, relativeRequest);
  const relative = path.relative(rootPath, candidate);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}
