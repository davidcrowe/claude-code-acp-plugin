#!/usr/bin/env node

// ACP Governance Hook — PreToolUse interceptor
//
// Two modes:
//   AUDIT (default) — returns immediately, logs async. Near-zero latency.
//   ENFORCE         — waits for ACP decision before allowing/denying.
//
// Fails OPEN on any error — never blocks Claude Code.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ACP_API =
  process.env.ACP_API_BASE || "https://api.agenticcontrolplane.com";

function readToken() {
  if (process.env.ACP_BEARER_TOKEN) return process.env.ACP_BEARER_TOKEN;
  try {
    return readFileSync(join(homedir(), ".acp", "credentials"), "utf8").trim();
  } catch {
    return null;
  }
}

const token = readToken();
if (!token) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
} catch {
  process.exit(0);
}

// Map Claude Code's permission_mode to ACP agent tier
function resolveAgentTier() {
  const mode = input.permission_mode;
  // Claude Code modes: "default" (ask user), "auto" (autonomous), "plan"
  if (mode === "auto") return "subagent";
  if (mode === "bypassPermissions") return "background";
  return "interactive";
}

const body = JSON.stringify({
  tool_name: input.tool_name,
  tool_input: input.tool_input,
  session_id: input.session_id,
  cwd: input.cwd,
  hook_event_name: input.hook_event_name || "PreToolUse",
  agent_tier: resolveAgentTier(),
  permission_mode: input.permission_mode,
});

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-GS-Client": "claude-code-plugin/0.3.0",
};

// ── Audit mode: fire-and-forget, exit immediately ────────────────
// The API call runs but we don't wait for it.
// Result: <1ms hook latency. Logging still happens server-side.

function fireAndForget() {
  fetch(`${ACP_API}/govern/tool-use`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
  // Fallback: exit after 500ms even if fetch hangs
  setTimeout(() => process.exit(0), 500);
}

// ── Enforce mode: wait for decision ──────────────────────────────

async function enforce() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  function deny(reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { permissionDecision: "deny" },
        systemMessage: `[ACP] Blocked: ${reason}`,
      })
    );
    process.exit(0);
  }

  try {
    const res = await fetch(`${ACP_API}/govern/tool-use`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      // Enforce mode: fail CLOSED — if ACP can't verify, block the call
      deny("ACP unreachable (HTTP " + res.status + ") — tool call blocked for safety");
      return;
    }

    const data = await res.json();

    if (data.decision === "deny") {
      deny(data.reason || "denied by workspace policy"
      );
    }
  } catch {
    // Enforce mode: fail CLOSED — network error, timeout, etc.
    deny("ACP unreachable — tool call blocked for safety");
  } finally {
    clearTimeout(timeout);
  }

  process.exit(0);
}

// ── Decide which mode to use ─────────────────────────────────────
// Default: audit (fire-and-forget). Set ACP_MODE=enforce to wait.

// Mode: always use enforce (wait for response) so the backend
// can return deny decisions. The backend decides audit vs enforce
// based on the workspace policy config.
enforce();
