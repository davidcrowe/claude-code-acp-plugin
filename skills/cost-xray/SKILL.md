---
name: cost-xray
description: Generate a cost X-ray report for your agent from ACP's metering — cache economics, context composition, tool bloat, loop share — before you ship it (or whenever spend surprises you)
user-invocable: true
---

# Cost X-ray

Produce a ranked, evidence-backed report on where this agent's model spend goes and what to change. ACP sits in the request path, so it sees *composition* (cache blend, context breakdown, per-tool output bytes, loop share) — not just totals. Your job: pull the data, run the decompositions below, and deliver a report the user can act on before scaling to production.

## Data sources (in order of preference)

1. **ACP MCP tools** if connected: `acp_optimize` (composition), `acp_trace` (one run's steps), `acp_recommendations` (policy findings), `acp_cost` (spend by model).
2. **REST fallback** with the key in `~/.acp/credentials` (or `~/.acp/proxy-key`):
   - `GET https://api.agenticcontrolplane.com/api/v1/runs?window=7d` — run rollups
   - `GET https://api.agenticcontrolplane.com/api/v1/runs/{runKey}` — one run with ordered steps
   - `GET https://api.agenticcontrolplane.com/api/v1/introspect/cost-insights?window=7d` — ranked recommendations
   Auth: `Authorization: Bearer <key>`.

## Analysis steps

1. **Headline:** total cost, run count, window. If `byoAuth`, label costs "@ API rates" (subscription traffic priced at what it *would* cost).
2. **Cache economics — decompose before concluding.** A low headline hit rate has at least four distinct causes with different fixes. Compute from step data (`model`, `tMs`, `promptTokens`, `cachedTokens`):
   - **per-model hit rate** — Anthropic caches are per-model; if one model is cold, switching is the cause → route or batch by model;
   - **hit rate by gap** since the previous same-model call (<1min / 1–5min / 5–60min) — decay over gaps = TTL expiry → schedule work closer together or accept it;
   - **full-price share immediately after a model switch** — high = switching cost, low = rules it out;
   - **uniform ~50% across models and gaps** = structural: likely cache *writes* of new tool output being counted as misses (heavy tool-result appending), or genuine prefix instability. Say which is more consistent with the context composition, and say what you *cannot* distinguish from the data.
3. **Context composition:** system vs history vs tool-results share. If tool results dominate, name the top tools by re-read bytes (`toolResultBytesByTool`) and the worst offender's MB.
4. **Loop share:** report the number. Only recommend a subagent split for autonomous agents (background/api tier) — for interactive agents the growing loop IS the work.
5. **Failure waste:** only from `runOutcome === "failed"` runs. Runs without a terminal outcome NEVER get a waste claim.
6. **Recommendations:** merge `/cost-insights` items, ranked by `impactUsd`.

## Report rules (honesty is the product)

- **Window-observed dollars only** unless the fix is a deterministic config change (model routing, cap) — only levers project to monthly.
- **State the basis on every claim** ("based on N runs / M steps over D days"). Step arrays cap at 250 — say so when a run is truncated.
- **Name capture gaps instead of showing zeros.** Empty contextBreakdown/topTools = the proxy isn't in the model path → tell the user how to add it (point the model client's base URL at the ACP proxy). Empty costByModel on older runs = pre-capture data.
- **Never claim intent you can't observe** — an errored step a run recovered from is not waste.

## Report shape

```
# Cost X-ray — <agent> — last <window>
<headline: $X across N runs (@ API rates?)>

## What your money buys        ← composition + top tools
## Cache economics             ← decomposed, with the cause you ruled IN and OUT
## What to change before shipping   ← ranked, each with $ at stake + concrete action
## What we couldn't see        ← capture gaps + how to close them
```

Deliver as markdown. Offer to save it to a file if the user wants to share it.
