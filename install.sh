#!/bin/bash
set -e

# Agentic Control Plane — One-Command Installer for Claude Code
#
# Usage:
#   curl -sf https://agenticcontrolplane.com/install.sh | bash
#
# What it does:
#   1. Installs the ACP plugin into Claude Code
#   2. Opens browser for login / signup
#   3. Provisions a workspace + API key
#   4. Stores credentials — governance hook is immediately active
#   5. Opens your audit log dashboard

API_BASE="${ACP_API_BASE:-https://api.agenticcontrolplane.com}"
DASHBOARD_BASE="${ACP_DASHBOARD_BASE:-https://cloud.agenticcontrolplane.com}"
PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/agentic-control-plane"
CONFIG_DIR="$HOME/.acp"
CREDS_FILE="$CONFIG_DIR/credentials"

echo ""
echo "  Agentic Control Plane"
echo "  Identity & governance for Claude Code"
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Install plugin files ──────────────────────────────────────

echo "  Installing plugin..."

mkdir -p "$PLUGIN_DIR/bin" "$PLUGIN_DIR/hooks" "$PLUGIN_DIR/commands" "$PLUGIN_DIR/skills/acp"

# plugin.json
cat > "$PLUGIN_DIR/plugin.json" << 'PLUGIN'
{
  "name": "agentic-control-plane",
  "version": "0.3.0",
  "description": "Identity, governance, and audit for every Claude Code tool call. Logs all tool usage, enforces policies, and gives teams full visibility — without changing how you use Claude.",
  "author": "GatewayStack",
  "homepage": "https://agenticcontrolplane.com",
  "repository": "https://github.com/davidcrowe/claude-code-acp-plugin",
  "hooks": "./hooks/hooks.json"
}
PLUGIN

# .mcp.json (empty — no MCP server, governance only)
cat > "$PLUGIN_DIR/.mcp.json" << 'MCP'
{
  "mcpServers": {}
}
MCP

# hooks.json
cat > "$PLUGIN_DIR/hooks/hooks.json" << 'HOOKS'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PLUGIN_ROOT/bin/govern.mjs\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
HOOKS

# govern.mjs — the governance hook script
cat > "$PLUGIN_DIR/bin/govern.mjs" << 'GOVERN'
#!/usr/bin/env node
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ACP_API = process.env.ACP_API_BASE || "https://api.agenticcontrolplane.com";

function readToken() {
  if (process.env.ACP_BEARER_TOKEN) return process.env.ACP_BEARER_TOKEN;
  try {
    return readFileSync(join(homedir(), ".acp", "credentials"), "utf8").trim();
  } catch {
    return null;
  }
}

async function main() {
  const token = readToken();
  if (!token) process.exit(0);

  let input;
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {
    process.exit(0);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(`${ACP_API}/govern/tool-use`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GS-Client": "claude-code-plugin/0.3.0",
      },
      body: JSON.stringify({
        tool_name: input.tool_name,
        tool_input: input.tool_input,
        session_id: input.session_id,
        cwd: input.cwd,
        hook_event_name: input.hook_event_name || "PreToolUse",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) process.exit(0);
    const data = await res.json();
    if (data.decision === "deny") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { permissionDecision: "deny" },
        systemMessage: `[ACP] Blocked: ${data.reason || "denied by workspace policy"}`,
      }));
    }
  } catch {
    // fail open
  } finally {
    clearTimeout(timeout);
  }
  process.exit(0);
}

main();
GOVERN
chmod +x "$PLUGIN_DIR/bin/govern.mjs"

# commands/acp-connect.md
cat > "$PLUGIN_DIR/commands/acp-connect.md" << 'CMD'
---
name: acp-connect
description: Connect to ACP — identity & governance for every Claude Code tool call
user-invocable: true
---

Help the user connect to the Agentic Control Plane. Use the instructions in the `acp` skill to walk them through the full setup:

1. Check if `~/.acp/credentials` exists (already configured?)
2. If not: open `https://cloud.agenticcontrolplane.com/plugin/authorize` in the browser
3. Wait for the user to paste their token
4. Store the token in `~/.acp/credentials` with `chmod 600`
5. Verify by hitting `GET https://api.agenticcontrolplane.com/govern/health`
6. Direct them to `https://cloud.agenticcontrolplane.com/logs` to see their audit trail

Keep it conversational and seamless. The user should go from zero to seeing their first logged tool call in under 2 minutes.
CMD

# skills/acp/SKILL.md
cat > "$PLUGIN_DIR/skills/acp/SKILL.md" << 'SKILL'
---
name: acp
description: Identity, governance, and audit for all Claude Code tool calls via the Agentic Control Plane
user-invocable: true
---

# Agentic Control Plane (ACP)

ACP is the identity and governance layer for Claude Code. When active, every tool call (Bash, Read, Write, Edit, Grep, WebFetch, and all MCP tools) is logged and governed through the user's ACP workspace. The user does not need to change how they work — ACP runs transparently via a PreToolUse hook.

## Setup flow

### Step 1: Check if already configured
```bash
cat ~/.acp/credentials 2>/dev/null && echo "ACP credentials found" || echo "No ACP credentials"
```

### Step 2: Create account or log in
```bash
open "https://cloud.agenticcontrolplane.com/plugin/authorize"
```
Tell the user: "I've opened your browser to log in to ACP. After logging in, you'll see a token — paste it here."

### Step 3: Store credentials
```bash
mkdir -p ~/.acp && echo "THE_TOKEN" > ~/.acp/credentials && chmod 600 ~/.acp/credentials
```

### Step 4: Verify
```bash
curl -sf "https://api.agenticcontrolplane.com/govern/health" && echo " — ACP reachable"
```

### Step 5: Direct to console
Tell the user: "Your dashboard is ready at https://cloud.agenticcontrolplane.com/logs — every tool call shows up there in real-time."

## Console pages
- Audit logs: https://cloud.agenticcontrolplane.com/logs
- Policies: https://cloud.agenticcontrolplane.com/policies
- Rate limits: https://cloud.agenticcontrolplane.com/limits
- Content/PII: https://cloud.agenticcontrolplane.com/content
- API keys: https://cloud.agenticcontrolplane.com/api-keys
- Team: https://cloud.agenticcontrolplane.com/users

## Pause / resume
```bash
mv ~/.acp/credentials ~/.acp/credentials.paused   # pause
mv ~/.acp/credentials.paused ~/.acp/credentials    # resume
```
SKILL

echo "  Plugin installed at $PLUGIN_DIR"

# ── Step 1b: Install governance hook ──────────────────────────────────
# Copy govern.mjs to ~/.acp/ and register the hook in settings.json

cp "$PLUGIN_DIR/bin/govern.mjs" "$CONFIG_DIR/govern.mjs"
chmod +x "$CONFIG_DIR/govern.mjs"

# Add PreToolUse hook to Claude Code settings if not already present
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
  if ! grep -q "govern.mjs" "$CLAUDE_SETTINGS" 2>/dev/null; then
    # Inject hook into existing settings using node for safe JSON manipulation
    node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS','utf8'));
      s.hooks = s.hooks || {};
      s.hooks.PreToolUse = s.hooks.PreToolUse || [];
      s.hooks.PreToolUse.push({
        matcher: '.*',
        hooks: [{ type: 'command', command: 'node \$HOME/.acp/govern.mjs', timeout: 5 }]
      });
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(s, null, 2));
    "
    echo "  Governance hook registered in Claude Code settings"
  else
    echo "  Governance hook already registered"
  fi
else
  # Create settings.json with hook
  mkdir -p "$HOME/.claude"
  cat > "$CLAUDE_SETTINGS" << 'SETTINGS'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.acp/govern.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
SETTINGS
  echo "  Governance hook registered in Claude Code settings"
fi

# ── Step 2: Authenticate ──────────────────────────────────────────────

if [ -f "$CREDS_FILE" ]; then
  echo "  Credentials already configured."
  echo ""
  read -p "  Reconfigure? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "  You're all set. View your audit logs:"
    echo "  $DASHBOARD_BASE/logs"
    echo ""
    exit 0
  fi
fi

echo "  Opening browser to log in..."
echo ""

AUTH_URL="$DASHBOARD_BASE/plugin/authorize"
if command -v open &> /dev/null; then
  open "$AUTH_URL"
elif command -v xdg-open &> /dev/null; then
  xdg-open "$AUTH_URL"
else
  echo "  Open this URL in your browser:"
  echo "  $AUTH_URL"
  echo ""
fi

echo "  After logging in, you'll see a token."
echo ""
echo -n "  Paste your token here: "
read -r AUTH_TOKEN

if [ -z "$AUTH_TOKEN" ]; then
  echo ""
  echo "  No token provided."
  echo "  Plugin is installed — run /acp-connect inside Claude Code to finish setup."
  exit 0
fi

# ── Step 3: Provision workspace ───────────────────────────────────────

echo ""
echo "  Provisioning workspace..."

PROVISION_RESPONSE=$(curl -sf -X POST "$API_BASE/plugin/provision" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" 2>&1)

if [ $? -ne 0 ]; then
  echo "  Provision failed. Plugin is installed — run /acp-connect inside Claude Code to retry."
  exit 1
fi

API_KEY=$(echo "$PROVISION_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
WORKSPACE=$(echo "$PROVISION_RESPONSE" | grep -o '"workspace":"[^"]*"' | cut -d'"' -f4)
IS_NEW=$(echo "$PROVISION_RESPONSE" | grep -o '"isNew":[^,}]*' | cut -d':' -f2)

if [ -z "$API_KEY" ] || [ -z "$WORKSPACE" ]; then
  echo "  Failed to parse response. Plugin is installed — run /acp-connect inside Claude Code to retry."
  exit 1
fi

mkdir -p "$CONFIG_DIR"
echo "$API_KEY" > "$CREDS_FILE"
chmod 600 "$CREDS_FILE"

if [ "$IS_NEW" = "true" ]; then
  echo "  Created workspace: $WORKSPACE"
else
  echo "  Connected to workspace: $WORKSPACE"
fi

# ── Step 4: Verify ────────────────────────────────────────────────────

HEALTH=$(curl -sf "$API_BASE/govern/health" 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "  Governance endpoint verified"
fi

# ── Done ──────────────────────────────────────────────────────────────

echo ""
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done. Every Claude Code tool call is now governed."
echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Audit logs:  $DASHBOARD_BASE/logs"
echo "  Policies:    $DASHBOARD_BASE/policies"
echo ""
echo "  Restart Claude Code to activate the hook."
echo ""

# Open the dashboard so they land on logs
if command -v open &> /dev/null; then
  open "$DASHBOARD_BASE/logs"
elif command -v xdg-open &> /dev/null; then
  xdg-open "$DASHBOARD_BASE/logs"
fi
