# Demo script — Behavior Debugger

A 5-minute walkthrough. Everything here is reproducible from a clean checkout.

## Setup

```bash
npm install
npm test                # 36 tests — establishes the groundwork claims
```

## Option A — one command

```bash
npm run demo:fast
```

Boots the API on a scratch data root, drives the full loop, and prints a pass/fail per
claim. Expect **34 checks, 0 failures**, ending with:

```
  result  SUPPORTED
  summary 0.7 → 0.267 switchRatePerMin / 30 min (−61.9%) · SUPPORTED
  phase   LEARNED
  ✓ only a SUPPORTED verdict writes memory — 1 record(s)
     lesson: Aggregate Frequently Used Documentation reduced switchRatePerMin by 61.9%

  ALL 34 CHECKS PASSED — the loop is closed and honest at every step.
```

## Option B — drive the dashboard

```bash
WAIT_TIME_SCALE=0.05 npm start
# → http://127.0.0.1:4317
```

### Act 1 — the system refuses to guess (≈60s)

1. Select **`sparse · 3min (triggers WAIT)`** and click **载入会话 Load**.
2. Watch the **状态机** strip land on `WAITING` (amber).
3. The countdown ticks. The progress bar fills. Below it, the system states exactly
   what it is missing:

   ```
   · Only 8 of 12 required behavioral events collected
   · Observed for 2.4 of 5 required minutes
   · Only 2 distinct behavior types seen; 3 needed to compare patterns
   · Behavior pattern reproduced in only 0 sub-window(s); 2 needed to rule out a one-off
   ```

4. In **证据充分性**, the five weighted gates show partial credit — confidence 52%,
   and a note that the ceiling is 95%.

> **The line to say:** "It hasn't got enough evidence, so it's waiting. Not because a
> model wrote 'I need more information' — but because five arithmetic gates failed, and
> there's a real deadline on disk. We can restart the process and it will still be here."

Prove it:

```bash
curl -s http://127.0.0.1:4317/api/health | grep -o '"phase":"[^"]*"'
```

Kill the server, restart it, check again. The session is still `WAITING` with the same
`waitUntil`.

5. Click **快进 Fast-forward**. The deadline expires — and the session **parks again in
   WAITING with a fresh deadline**, because time passing is not evidence.

> "Fast-forward moves the clock, not the evidence. It re-evaluated and still couldn't
> justify a diagnosis, so it waited again."

### Act 2 — competing hypotheses (≈90s)

1. Select **`baseline · 21 switches / 30min`** and click **载入会话 Load**.
2. The state machine runs `OBSERVING → READY → DIAGNOSING`.
3. **行为表征**: 21 switches, 0.7/min, 16 segments. The segment map shows a clean
   repeating loop, and the compressed sequence reads:

   ```
   docs_search ×4  ai_assistance ×4  development ×4  ...
   ```

4. **竞争假设**: **four** candidates, not one:

   ```
   LEADING   81%  Documentation Fragmentation    sup 3 · con 0 · missing 3
             71%  Frequent Context Switching      sup 2 · con 0 · missing 2
             50%  Unclear Task Definition         sup 1 · con 0 · missing 2
             31%  Undefined Success Criteria      sup 1 · con 2 · missing 2
   ```

> **The line to say:** "Four explanations, not one. Each carries supporting evidence,
> contradicting evidence, and — this is the important column — the evidence it's
> *missing*. And nothing above 81%, because 95% is the ceiling. Confidence 100% would
> be a lie."

Click any `eventId` chip — it resolves to the raw event behind the claim.

### Act 3 — approval is a human act (≈60s)

1. Click **生成干预 Propose**. A checklist appears: aggregate the documentation sources
   that keep being revisited.
2. Note the steps: all `manual`. The executor's whitelist means it **cannot run
   commands** — it renders a checklist and stops.
3. Leave the name field empty and click **批准 Approve**. It is refused:

   ```
   acknowledgedBy is required — interventions cannot be approved anonymously
   ```

4. Type a name, approve. The phase moves to `VERIFYING` and the baseline is frozen.

> "The system proposed the change. A human named themselves and approved it. That
> signature is in the record."

### Act 4 — the verdict is arithmetic (≈90s)

1. Click **运行验证 Verify** *before* any post-intervention data exists.
2. Result: **`INCONCLUSIVE`**.

   ```
   reason  Need at least 8 events in each window (before: 86, after: 0)
           — a verdict would not be evidence-based.
   before  0.7  (86 events over 30min)
   after   0     (0 events over 30min)
   ```

3. **记忆 Memory** stays empty.

> "It refuses to declare victory. There's no post-intervention window, so there's no
> verdict. And because nothing was SUPPORTED, nothing is written to memory."

4. Now load `improved` to supply the post-intervention window, then verify again:

   ```
   result  SUPPORTED
   summary 0.7 → 0.267 switchRatePerMin / 30 min (−61.9%) · SUPPORTED
   phase   LEARNED
   ```

5. **记忆 Memory** now holds one record:
   `Aggregate Frequently Used Documentation reduced switchRatePerMin by 61.9%`

> "Only now does it learn — and it learned from numbers it actually observed, not from
> the model's opinion."

## Reading the verdicts

| verdict | meaning | what the system does |
|---|---|---|
| `SUPPORTED` | improvement ≥ 20% | → `LEARNED`, writes memory |
| `WEAKENED` | improvement 8–20% | → `RE_EVALUATING`, real but below the bar |
| `INCONCLUSIVE` | within ±8%, or too few samples | → `RE_EVALUATING`, learns nothing |
| `REJECTED` | regression ≥ 20% | → `RE_EVALUATING`, hypothesis contradicted |

`INCONCLUSIVE` is a normal outcome, not a failure of the demo. With fixture-sized
samples the ±8% noise band is often wider than the effect — which is exactly why the
verdict can't be left to a model's judgement.

## Optional — the interactive API

```bash
curl -s http://127.0.0.1:4317/api/health | jq
curl -s -X POST -H 'content-type: application/json' \
     -d '{"profile":"sparse"}' http://127.0.0.1:4317/api/demo/load | jq
curl -s http://127.0.0.1:4317/api/sessions/session_sparse | jq '.data.view.sufficiency'
curl -s http://127.0.0.1:4317/api/memory | jq
```

## FAQ

**Why is the demo so fast?**
`WAIT_TIME_SCALE=0.05` multiplies wait durations. It changes the delay, never the
persisted `waitUntil`. Without it, the sparse session waits 4 minutes.

**Why 4 hypotheses instead of 1?**
`assertMultiHypothesis()` rejects a single-cause diagnosis. Committing to one answer is
the failure mode this project exists to avoid.

**Why did my verify return INCONCLUSIVE?**
Either the post window had fewer than 8 events, or the change was inside ±8%. Both are
correct behaviour — see the table above.

**The verdict says SUPPORTED but the numbers look small.**
Check `windowMinutesBefore` equals `windowMinutesAfter`. If they differ, the comparison
isn't measuring equal periods, and that's a bug worth reporting.
