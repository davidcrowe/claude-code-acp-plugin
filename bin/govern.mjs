#!/usr/bin/env node

// ACP Governance Hook — Pre- and Post-ToolUse interceptor
//
// Dispatches on input.hook_event_name:
//   PreToolUse  (default)  — /govern/tool-use   — can deny the call
//   PostToolUse            — /govern/tool-output — scans returned data
//
// Fails OPEN on network/parse errors — never blocks Claude Code on our
// infrastructure. Explicit deny responses from the backend DO block (pre-hook
// enforce mode). Post-hook is audit-only client-side for v1; findings live
// in the dashboard audit log.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ACP_API =
  process.env.ACP_API_BASE || "https://api.agenticcontrolplane.com";

const PLUGIN_VERSION = "0.4.0";

// 200 KB ceiling on the tool_output payload we send to the backend. Matches
// the backend's scan ceiling. TODO: revisit when the MCP proxy lands and
// streaming scan becomes an option.
const POST_HOOK_PAYLOAD_CEILING = 200 * 1024;

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

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-GS-Client": `claude-code-plugin/${PLUGIN_VERSION}`,
};

// Map Claude Code's permission_mode to ACP agent tier
function resolveAgentTier() {
  const mode = input.permission_mode;
  if (mode === "auto") return "subagent";
  if (mode === "bypassPermissions") return "background";
  return "interactive";
}

// ─── PreToolUse (existing behaviour, unchanged) ──────────────────────
async function handlePreToolUse() {
  const body = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    session_id: input.session_id,
    cwd: input.cwd,
    hook_event_name: "PreToolUse",
    agent_tier: resolveAgentTier(),
    permission_mode: input.permission_mode,
  });

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
      deny("ACP unreachable (HTTP " + res.status + ") — tool call blocked for safety");
      return;
    }

    const data = await res.json();
    if (data.decision === "deny") {
      deny(data.reason || "denied by workspace policy");
    }
  } catch {
    deny("ACP unreachable — tool call blocked for safety");
  } finally {
    clearTimeout(timeout);
  }

  process.exit(0);
}

// ─── PostToolUse (new) ───────────────────────────────────────────────
// Sends the tool's return value to /govern/tool-output for PII + prompt-
// injection scanning. Client-side behaviour for v1:
//   - Always exits 0 — never disrupts Claude Code's tool flow.
//   - Surfaces systemMessage only when backend action is redact/block,
//     so the user sees a hint in their transcript.
//   - Findings and decisions land in the server-side audit log regardless.
async function handlePostToolUse() {
  // Normalise tool_output to a string. Claude Code may pass it as a string
  // or as a structured object (e.g. { stdout, stderr } for Bash).
  let outputStr = "";
  try {
    const out = input.tool_response ?? input.tool_output ?? input.output;
    if (typeof out === "string") outputStr = out;
    else if (out !== undefined && out !== null) outputStr = JSON.stringify(out);
  } catch {
    process.exit(0);
  }

  // Enforce payload ceiling — truncation is safe because the full output
  // already flowed through Claude Code. We're only scanning for findings.
  if (Buffer.byteLength(outputStr, "utf8") > POST_HOOK_PAYLOAD_CEILING) {
    outputStr = outputStr.slice(0, POST_HOOK_PAYLOAD_CEILING);
  }

  const body = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_output: outputStr,
    session_id: input.session_id,
    cwd: input.cwd,
    hook_event_name: "PostToolUse",
    agent_tier: resolveAgentTier(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(`${ACP_API}/govern/tool-output`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // Backend unreachable → silent pass-through. Never block tool results.
      process.exit(0);
    }

    const data = await res.json();

    // Emit a user-visible hint when action is notable. systemMessage is
    // shown in the Claude Code transcript but does NOT modify the tool
    // output the LLM sees. v1 is audit-flavoured; actual redaction/block
    // of LLM-visible content will come once we validate Claude Code's
    // PostToolUse response contract in prod.
    if (data.action === "redact" || data.action === "block") {
      process.stdout.write(
        JSON.stringify({
          systemMessage: `[ACP] ${data.action === "block" ? "Blocked" : "Flagged"}: ${data.reason || "governance policy"}`,
        })
      );
    }
  } catch {
    // Network/timeout/parse error → silent pass-through.
  } finally {
    clearTimeout(timeout);
  }

  process.exit(0);
}

// ─── Dispatch ────────────────────────────────────────────────────────
const hookEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : "PreToolUse";

if (hookEvent === "PostToolUse") {
  handlePostToolUse();
} else {
  // Default to pre-hook for any unrecognised event — preserves existing
  // behaviour for older Claude Code versions.
  handlePreToolUse();
}
