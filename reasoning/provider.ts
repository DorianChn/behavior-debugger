/**
 * LLM provider abstraction.
 *
 * Deliberately tiny and optional. The reasoning core works fully without a
 * model — sufficiency, hypothesis scoring and verdicts are all arithmetic.
 * A provider is used ONLY to phrase things in natural language, and the
 * default implementation is a deterministic template so the demo never depends
 * on network availability or an API key.
 *
 * This keeps the "evidence-based" promise intact: a model can never win an
 * argument with the metrics.
 */

import type { BehaviorRepresentation } from "../shared/schemas/behavior.js";
import type { HypothesisSet } from "../shared/schemas/hypothesis.js";
import type { SufficiencyReport } from "../shared/schemas/task-state.js";
import type { PatternFinding } from "./analyzer.js";
import { round } from "../shared/utils/ids.js";

export interface NarrativeRequest {
  kind: "sufficiency" | "diagnosis" | "intervention" | "verification";
  behavior: BehaviorRepresentation;
  findings: PatternFinding[];
  sufficiency?: SufficiencyReport;
  hypothesisSet?: HypothesisSet | null;
  extra?: Record<string, unknown>;
}

export interface Narrative {
  text: string;
  /** How it was produced — surfaced in the UI so nobody mistakes it for evidence. */
  source: "template" | "llm";
  model?: string;
}

export interface LlmProvider {
  readonly name: string;
  /** Reported model id, when the provider talks to a real model. */
  readonly model?: string;
  /** Returns null when the provider is unavailable; callers fall back. */
  narrate(req: NarrativeRequest): Promise<Narrative | null>;
}

/* ------------------------------- templates ------------------------------- */

export function templateNarrative(req: NarrativeRequest): Narrative {
  const m = req.behavior.metrics;
  switch (req.kind) {
    case "sufficiency": {
      const s = req.sufficiency;
      if (!s) return { text: "No sufficiency assessment available.", source: "template" };
      if (s.status === "READY") {
        return {
          text:
            `Collected ${req.behavior.evidenceIds.length} events over ${req.behavior.windowMinutes} minutes, ` +
            `covering ${m.uniqueSources} sources and ${m.switchCount} context switches. ` +
            `Confidence in the current evidence set is ${round(s.confidence * 100, 1)}%, above the threshold.`,
          source: "template",
        };
      }
      return {
        text:
          `Evidence is not yet sufficient (${round(s.confidence * 100, 1)}%). ` +
          `${s.missingInformation.length} gap(s) remain: ${s.missingInformation.join("; ")}. ` +
          (s.nextObservation ? `Plan: ${s.nextObservation.action} (~${s.nextObservation.durationMinutes} min).` : ""),
        source: "template",
      };
    }
    case "diagnosis": {
      const set = req.hypothesisSet;
      if (!set) return { text: "No hypotheses generated yet.", source: "template" };
      const lines = set.hypotheses.slice(0, 4).map(
        (h) =>
          `- ${h.statement}: ${round(h.confidence * 100, 1)}% ` +
          `(${h.supportingEvidence.length} supporting, ${h.contradictingEvidence.length} contradicting, ` +
          `${h.missingEvidence.length} evidence gaps)`
      );
      return {
        text: `Competing explanations, ranked by evidence weight:\n${lines.join("\n")}\n\nNo single root cause is asserted; the leading hypothesis is not yet confirmed.`,
        source: "template",
      };
    }
    case "intervention": {
      const lead = req.hypothesisSet?.hypotheses[0];
      const target = round(m.switchRatePerMin, 2);
      return {
        text:
          `Target metric: switchRatePerMin (currently ${target}/min over ${req.behavior.windowMinutes} min). ` +
          (lead ? `Intervention addresses "${lead.statement}". ` : "") +
          `Expected effect is an estimate, not a promise — the verification step measures whether it actually happened.`,
        source: "template",
      };
    }
    case "verification": {
      const c = req.extra?.comparison as { before: number; after: number; deltaPct: number; metric: string } | undefined;
      const result = String(req.extra?.result ?? "INCONCLUSIVE");
      if (!c) return { text: "No comparison available.", source: "template" };
      return {
        text:
          `${c.metric}: ${c.before} before → ${c.after} after (${c.deltaPct > 0 ? "-" : "+"}${Math.abs(c.deltaPct)}%). ` +
          `Verdict ${result}, computed from observed data only.`,
        source: "template",
      };
    }
    default:
      return { text: "", source: "template" };
  }
}

/** Always-available provider. This is the default. */
export const templateProvider: LlmProvider = {
  name: "template",
  async narrate(req) {
    return templateNarrative(req);
  },
};

/**
 * OpenAI-compatible provider. Only used when explicitly configured, and it can
 * ONLY rewrite the language — the caller keeps the arithmetic result and
 * rejects any answer that tries to change it.
 */
export function openAiCompatibleProvider(opts: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): LlmProvider {
  const baseUrl = (opts.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  const model = opts.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";

  const SYSTEM =
    "You are the language layer of a behavior-debugging system. You are given ALREADY-COMPUTED results. " +
    "Rewrite them into clear, neutral English for a dashboard. RULES: (1) never change any number; " +
    "(2) never add a cause that is not listed; (3) never claim a single root cause; " +
    "(4) always mention what evidence is still missing when the status is WAIT; " +
    "(5) max 90 words.";

  return {
    name: "openai-compatible",
    model,
    async narrate(req: NarrativeRequest): Promise<Narrative | null> {
      if (!apiKey) return null;
      const facts = {
        kind: req.kind,
        metrics: req.behavior.metrics,
        windowMinutes: req.behavior.windowMinutes,
        findings: req.findings.map((f) => ({ code: f.code, detail: f.detail, severity: f.severity })),
        sufficiency: req.sufficiency
          ? {
              status: req.sufficiency.status,
              confidence: req.sufficiency.confidence,
              missingInformation: req.sufficiency.missingInformation,
              nextObservation: req.sufficiency.nextObservation,
            }
          : null,
        hypotheses: req.hypothesisSet?.hypotheses.map((h) => ({
          statement: h.statement,
          confidence: h.confidence,
          supporting: h.supportingEvidence.map((e) => e.statement),
          contradicting: h.contradictingEvidence.map((e) => e.statement),
          missing: h.missingEvidence,
        })),
        extra: req.extra ?? null,
      };
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 300,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: JSON.stringify(facts, null, 2) },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = j.choices?.[0]?.message?.content?.trim();
        if (!text) return null;
        // Guard rail: numbers must survive the round trip untouched.
        return { text: guardNarrative(text, req) , source: "llm", model };
      } catch {
        return null;
      }
    },
  };
}

/** Rejects an LLM narrative that contradicts the computed facts. */
export function guardNarrative(text: string, req: NarrativeRequest): string {
  const banned = [/the root cause is/i, /definitively/i, /100% (certain|sure)/i, /proves that/i];
  for (const b of banned) {
    if (b.test(text)) return templateNarrative(req).text;
  }
  return text;
}

/** Pick a provider from config, falling back to templates on any failure. */
export function resolveProvider(explicit?: LlmProvider | null): LlmProvider {
  if (explicit) return explicit;
  if (process.env.LLM_ENABLE === "1") return openAiCompatibleProvider({});
  return templateProvider;
}

export async function narrate(req: NarrativeRequest, explicit?: LlmProvider | null): Promise<Narrative> {
  const p = resolveProvider(explicit);
  try {
    const result = await p.narrate(req);
    if (result) return result;
  } catch {
    /* fall through */
  }
  return templateNarrative(req);
}
