# Agentic Control Plane — Claude Code Plugin

Identity, governance, and audit for every Claude Code tool call.

When active, **every tool call** Claude makes — `Bash`, `Read`, `Write`, `Edit`, `WebFetch`, and all MCP tools — is logged to your ACP workspace. Set policies to control what's allowed. Get full compliance visibility across your team.

ACP doesn't replace your tools or change how you use Claude. It's the governance layer that sits transparently in front of everything.

## One-command install

```bash
curl -sf https://agenticcontrolplane.com/install.sh | bash
```

This installs the plugin, opens your browser to sign up / log in, provisions your workspace, and activates the governance hook. You'll land on your audit log dashboard — done.

Already have the plugin? Run `/acp-connect` inside Claude Code to connect.

## How it works

The plugin registers a **PreToolUse hook** that fires before every tool call:

1. Hook sends tool name + input to ACP's governance API
2. ACP runs a 6-layer pipeline: immutable rules, scope enforcement, ABAC policies, rate limits, budget caps, content scanning
3. Returns `allow` or `deny`
4. All calls are logged to your workspace's audit trail

The hook **fails open** on network errors — ACP outages never block Claude Code.

### Deny messages — three categories

When ACP denies a call, the plugin tells you why with a distinct prefix so you can tell network problems apart from real policy denials at a glance:

- `[ACP] Denied by policy: <reason>` — a workspace policy intentionally blocked the call
- `[ACP] Gateway error — tool blocked for safety (HTTP X)` — ACP responded with an error (e.g. auth, server crash)
- `[ACP] Gateway unreachable — tool blocked for safety` — ACP didn't respond at all (timeout, network)

### Cross-architecture credential brokering (v0.5.0+, opt-in)

When your workspace has **scoped tokens** enabled (`policies.scopedTokensEnabled: true` in your tenant config), the plugin recognizes calls to known vendors — currently `gh`, `curl api.github.com`, and `git push https://github.com/…` — and:

1. Requests a short-lived ACP-issued scoped token bound to your stored OAuth credential for that vendor
2. Injects the token into the call as `GH_TOKEN=…` so the existing CLI keeps working with no setup change
3. **Your local PAT is never read or used by the agent** — ACP brokers the credential and audits every issuance + use

If you haven't connected the vendor yet, the plugin emits a deny with a clickable connect URL inline in the IDE so you can complete OAuth in your browser without leaving Claude Code.

If your workspace doesn't have scoped tokens enabled, the plugin behaves exactly as v0.4.0 did — your existing local credentials continue to work unchanged.

Other vendors (Slack, Salesforce, Notion, etc.) ship in subsequent releases. Track progress at [gatewaystack-connect#114](https://github.com/davidcrowe/gatewaystack-connect/issues/114).

## What you get

- **Audit logs** — every tool call with identity, arguments, timestamps, decisions
- **Policy enforcement** — allow/deny by tool name, argument patterns, ABAC rules
- **Rate limits & budgets** — cap tool calls per minute, per month, or by cost
- **Content scanning** — detect PII in tool inputs, optionally block or redact
- **Team management** — multiple members, roles, workspace-level controls

## Console

After setup, your dashboard is at:

- **Logs**: `https://cloud.agenticcontrolplane.com/logs`
- **Policies**: `https://cloud.agenticcontrolplane.com/policies`
- **Limits**: `https://cloud.agenticcontrolplane.com/limits`

## Pause / disable

```bash
# Pause governance (keep credentials)
mv ~/.acp/credentials ~/.acp/credentials.paused

# Resume
mv ~/.acp/credentials.paused ~/.acp/credentials

# Fully remove
rm -rf ~/.acp
claude plugin disable agentic-control-plane
```

## Support

- Site: https://agenticcontrolplane.com
- Issues: https://github.com/davidcrowe/claude-code-acp-plugin/issues
