---
name: acp-spawn
description: Spawn a governed subagent with a scope-narrowed child API key minted by ACP. Use when a Claude Code session needs to dispatch a task to a subagent that should run with narrower permissions than the parent — and have the audit trail link back to the originating human.
user-invocable: true
---

# acp-spawn — governed subagent spawning via ACP delegation chain

This skill is the keystone for **agents-building-agents** in Claude Code. When a parent Claude Code session needs to delegate work to a subagent, this skill mints a scope-narrowed **child API key** via ACP, then runs the subagent with that key bound. The result:

- Every tool call the subagent makes is governed under the child key
- Audit logs trace through the chain back to the originating human (`originSub`)
- The subagent's effective scopes are a strict subset of the parent's
- Budget for the subagent is capped at min(parent remaining, profile cap, request cap)
- TTL is short (default 1h, never longer than parent's lifetime)

The acp skill (`/skills/acp/SKILL.md` in this plugin) handles the *parent* session's governance. This skill (`acp-spawn`) handles spawning *child* sessions with chain-aware credentials.

## When to use

The user (or the parent agent) asks to:

- "spawn a subagent for X with narrower scopes"
- "delegate this to a researcher agent and audit it back to me"
- "run this task as a child agent with read-only access"
- "fork off a Task() call but with restricted permissions"

If the user just says "use Task to do X" without governance/scope language, use Claude Code's normal Task tool — don't reach for this skill.

## Prerequisites

1. The parent's ACP credentials must be set up (run the `acp` skill first if not).
2. The target tenant must have an **agent profile** with `delegatable: true`. Profiles are created via the dashboard (`https://cloud.agenticcontrolplane.com/app/<slug>/agents`) or via `POST /api/v1/agents`.
3. The gateway must have `KEYS_CHILD_API_ENABLED=true` (default off; check the deploy if minting fails with 404).

## Flow

### 1. Read the parent's token

```bash
PARENT_TOKEN=$(cat ~/.acp/credentials 2>/dev/null)
[ -z "$PARENT_TOKEN" ] && echo "ACP not configured — run /skills/acp first" && exit 1
```

### 2. Mint a child key for the target profile

Replace `<profile-id>` with the agent profile in the user's tenant. Adjust scopes/budget/TTL as the task requires — narrower is always better.

```bash
RESPONSE=$(curl -sS -X POST "https://api.agenticcontrolplane.com/api/v1/keys/child" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "<profile-id>",
    "scopes": ["github.repos.read"],
    "ttlSeconds": 600,
    "maxBudgetCents": 50,
    "reason": "summarizing inbound lead xyz"
  }')

CHILD_KEY=$(echo "$RESPONSE" | jq -r .apiKey)
EXPIRES=$(echo "$RESPONSE" | jq -r .expiresAt)
EFFECTIVE=$(echo "$RESPONSE" | jq -r '.effectiveScopes | join(",")')
```

If the response has `"error": "profile_not_delegatable"`, edit the profile and set `delegatable: true`. If `"delegation_cycle"`, a parent in this chain already invokes the same profile — pick a different profile or restructure. If `"delegation_depth_exceeded"`, the chain is at the cap (5).

### 3. Run the subagent with the child key

For a one-shot subagent invocation, write the child key to a session-scoped credentials path and invoke `claude` with that path. **Do not overwrite `~/.acp/credentials`** — that holds the parent's key and is read by the rest of the user's Claude Code sessions.

```bash
SESSION_CREDS=$(mktemp -t acp-child)
echo "$CHILD_KEY" > "$SESSION_CREDS"

# Invoke a subagent. Prefer Claude Code's Task tool when available;
# otherwise spawn a fresh `claude` process with the child token.
ACP_BEARER_TOKEN="$CHILD_KEY" \
  claude --print "Find the README of <repo> and summarize the architecture in 5 bullets" \
  > /tmp/subagent-output.txt

rm -f "$SESSION_CREDS"
```

`ACP_BEARER_TOKEN` overrides the credentials file — every PreToolUse hook in the spawned process uses the child key, so every tool call the subagent makes is governed under the chain.

### 4. Inspect the audit trail (optional)

After the subagent completes, the parent can verify the chain via the audit log:

```bash
curl -sS "https://api.agenticcontrolplane.com/<slug>/admin/audit?limit=20&tool=<the-tool-the-subagent-called>" \
  -H "Authorization: Bearer $PARENT_TOKEN" | jq '.entries[] | {ts, sub, tool, decision, originSub, depth, chain}'
```

Audit rows produced by the subagent will carry:

- `originSub` — the originating human (the parent's `originSub`/`createdBy`)
- `depth` — chain depth (≥ 2 for the subagent)
- `chain` — array of agent profile IDs through the chain

## Notes on what NOT to do

- **Never** persist the child key past the subagent's session. It expires automatically (default 1h, max 24h), but treat it as ephemeral. If the subagent needs to run again later, mint a fresh child key.
- **Never** use the parent's key to govern the subagent. The whole point is that the subagent operates under narrowed scopes — using the parent's key defeats the chain and audit attribution.
- **Never** pass `originSub` in the request body. The mint endpoint rejects unknown fields, and the originating identity comes from the parent's chain — that's the ADCS spec's origin invariant.
- **Don't** skip the child key flow because "the subagent's scopes are the same as mine." Even with identical scopes, the chain provides per-subagent budget and audit correlation. The cost is one HTTP round-trip; the benefit is full-fidelity audit logs.

## Quick reference — endpoint shape

```
POST /api/v1/keys/child
Authorization: Bearer <parent gsk_...>
Content-Type: application/json
{
  "profileId": string,                   // required, profile must have delegatable:true
  "scopes":     string[]?,               // optional further narrowing beyond profile.scopes
  "maxBudgetCents": number?,             // optional cap; clamped to min(parent, profile, request)
  "ttlSeconds": number?,                 // optional 60..86400, default 3600
  "reason":     string?                  // optional audit label
}
→ 201
{
  "apiKey": "gsk_...",                   // shown ONCE — store + use, never persist
  "keyId": "...",
  "expiresAt": "ISO timestamp",
  "effectiveScopes": ["..."],            // post-intersection, frozen at mint
  "effectiveTools":  ["..."],
  "remainingBudgetCents": number,
  "chain": {
    "originSub": "...",
    "depth": number,
    "agentProfileId": "...",
    "agentRunId": "...",
    "parentKeyId": "..."
  }
}
```

Error codes you'll actually see:

- `400 validation_failed` — body shape wrong; check `details` from zod.
- `403 profile_not_delegatable` — set `delegatable: true` on the profile.
- `404 profile_not_found` — typo, or wrong tenant.
- `409 delegation_cycle` — profile already in the chain; pick a different one.
- `409 delegation_depth_exceeded` — chain at depth cap (5); restructure.
- `410 parent_key_already_expired` — re-mint your parent key first.
- `429 child_mint_rate_limit` — 30 mints/hour per parent; back off.

## Reference

Full reference: [agenticcontrolplane.com/agents/configure-as-code/](https://agenticcontrolplane.com/agents/configure-as-code/) — see the "POST /api/v1/keys/child" section.
