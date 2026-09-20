/**
 * Deterministic id + small helpers. No crypto dependency: ids only need to be
 * unique inside one demo session, and determinism makes fixtures reproducible.
 */

export function counterId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(3, "0")}`;
}

let seq = 0;
export function shortId(prefix: string): string {
  seq += 1;
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return `${prefix}_${t}${r}${seq.toString(36)}`;
}

export function uuid(): string {
  // RFC4122 v4 without node:crypto, so shared/ stays environment-agnostic.
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Deep clone that survives structuredClone's absence in older runtimes. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function groupBy<T, K extends string | number>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}
