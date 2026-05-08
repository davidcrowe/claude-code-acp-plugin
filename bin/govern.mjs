#!/usr/bin/env node

// ACP Governance Hook — Pre- and Post-ToolUse interceptor
//
// Dispatches on input.hook_event_name:
//   PreToolUse  (default)  — /govern/tool-use   — can deny the call
//   PostToolUse            — /govern/tool-output — scans returned data
//
// PreToolUse flow (v0.5.0):
//   1. Call /govern/tool-use to get the policy decision (deny / ask / allow).
//   2. If decision is deny / ask, emit accordingly and exit.
//   3. If decision is allow AND the tool matches a vendor pattern (e.g.
//      Bash.gh, curl github.com), request a short-lived ACP-issued scoped
//      token from /api/v1/scoped-tokens, then mutate the Bash command to
//      prefix the token as an env var (`GH_TOKEN=<acp_token> gh ...`).
//      The user's local long-lived PAT is never read or used by the agent.
//   4. If the user hasn't connected the provider, emit deny with a clickable
//      connect URL so they can complete OAuth without leaving the IDE.
//   5. If the scoped-token endpoint isn't enabled (404), pass through —
//      existing local-credential workflows continue unchanged.
//
// Three distinct deny categories — keep the prefixes distinct so a user
// can tell at-a-glance whether a tool was blocked because policy denied
// it, because the gateway returned an error (auth, 5xx), or because we
// couldn't reach the gateway at all:
//   "[ACP] Denied by policy: ..."
//   "[ACP] Gateway error — tool blocked for safety (HTTP X)"
//   "[ACP] Gateway unreachable — tool blocked for safety (timed out / network)"
//
// Phase 1 of cross-arch credential brokering — see
// gatewaystack-connect/docs/cross-arch-governance-strategy.md (parent
// epic gatewaystack-connect#114, this work tracked at gatewaystack-connect#115).
//
// Fails OPEN on /govern/tool-use network/parse errors (existing behavior).
// Fails OPEN on /api/v1/scoped-tokens errors by default — server-side
// per-tenant policy can flip this to fail-closed. The plugin currently
// always fails open on token-request errors and surfaces a stderr warning;
// future versions will respect the server's `scopedTokensFailMode` policy.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { detectVendor } from "../lib/vendor-patterns.mjs";

const ACP_API =
  process.env.ACP_API_BASE || "https://api.agenticcontrolplane.com";

const PLUGIN_VERSION = "0.5.0";

// Identifies the calling client to the server (per-client policy routing).
// Each client's hooks.json sets this env var at invocation time:
// "claude-code-plugin", "cursor", "codex", etc. Falls back to
// claude-code-plugin for backward compat.
const ACP_CLIENT = process.env.ACP_CLIENT || "claude-code-plugin";

// 200 KB ceiling on the tool_output payload we send to the backend. Matches
// the backend's scan ceiling.
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
  "X-GS-Client": `${ACP_CLIENT}/${PLUGIN_VERSION}`,
};

function resolveAgentTier() {
  const mode = input.permission_mode;
  if (mode === "auto") return "subagent";
  if (mode === "bypassPermissions") return "background";
  return "interactive";
}

/* ------------------------------------------------------------------ */
/* Scoped-token request (Phase 1 cross-arch broker)                    */
/* ------------------------------------------------------------------ */

async function requestScopedToken(provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${ACP_API}/api/v1/scoped-tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider,
        ttlSeconds: 600,
        reason: `${ACP_CLIENT} ${input.tool_name ?? "unknown"} in session ${input.session_id ?? "unknown"}`,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.status === 404) return { passThrough: true };
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      return {
        needsConnect: true,
        provider,
        connectUrl: body.connectUrl,
      };
    }
    if (!res.ok) {
      return { fail: true, status: res.status };
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body.token !== "string") {
      return { fail: true, status: res.status, reason: "malformed_response" };
    }
    return { token: body.token, expiresAt: body.expiresAt };
  } catch (err) {
    clearTimeout(timeout);
    return {
      fail: true,
      reason: err && err.name === "AbortError" ? "timeout" : (err?.message ?? "network_error"),
    };
  }
}

/* ------------------------------------------------------------------ */
/* PreToolUse                                                          */
/* ------------------------------------------------------------------ */

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

  // Three distinct deny categories — distinguishable at-a-glance.
  function denyByPolicy(reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      systemMessage: `[ACP] Denied by policy: ${reason}`,
    }));
    process.exit(0);
  }
  function denyGatewayError(status, statusText) {
    const detail = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      systemMessage: `[ACP] Gateway error — tool blocked for safety (${detail})`,
    }));
    process.exit(0);
  }
  function denyUnreachable(detail) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      systemMessage: `[ACP] Gateway unreachable — tool blocked for safety${detail ? ` (${detail})` : ""}`,
    }));
    process.exit(0);
  }
  function ask(reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
      systemMessage: `[ACP] Approval required: ${reason}`,
    }));
    process.exit(0);
  }

  // Step 1: policy check.
  let policyAllowed = true;
  try {
    const res = await fetch(`${ACP_API}/govern/tool-use`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      denyGatewayError(res.status, res.statusText);
      return;
    }
    const data = await res.json();
    if (data.decision === "deny") {
      denyByPolicy(data.reason || "policy did not return a reason");
      return;
    }
    if (data.decision === "ask") {
      ask(data.reason || "approval required");
      return;
    }
    // decision is allow (or unspecified) — continue to step 2.
    policyAllowed = true;
  } catch (err) {
    clearTimeout(timeout);
    const reason = err && err.name === "AbortError"
      ? "request timed out"
      : (err && err.message ? err.message : "network error");
    denyUnreachable(reason);
    return;
  }

  // Step 2 (Phase 1): if the tool matches a vendor pattern, request a
  // scoped token and inject it via updatedInput.command. The agent's
  // local PAT is never read; ACP brokers the credential.
  const vendor = detectVendor(input.tool_name, input.tool_input);
  if (!vendor || !policyAllowed) {
    process.exit(0);
  }

  const tokenResult = await requestScopedToken(vendor.provider);

  // Feature flag off — pass through silently. Existing local-credential
  // workflow continues unchanged. This is the non-breaking opt-in path
  // for tenants that haven't enabled scopedTokensEnabled.
  if (tokenResult.passThrough) {
    process.exit(0);
  }

  // User hasn't connected the provider via OAuth yet. Emit a deny with
  // a clickable markdown link in the systemMessage so the agent or user
  // can complete OAuth in their browser without leaving Claude Code,
  // then retry. This is the load-bearing UX from gatewaystack-connect#115.
  if (tokenResult.needsConnect) {
    const url = tokenResult.connectUrl
      || `${ACP_API}/integrations/${vendor.provider}/start`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      systemMessage:
        `[ACP] Connection required for ${vendor.provider}\n\n` +
        `Click to connect: ${url}\n\n` +
        `After authorizing in your browser, retry your request. ACP will issue a short-lived token bound to your account; your local credentials are not touched.`,
    }));
    process.exit(0);
  }

  // Scoped-token request failed (5xx, network, malformed). Default
  // fail-mode is OPEN — let the existing local-credential workflow
  // proceed rather than blocking on ACP infrastructure issues. Surface
  // a stderr warning so the issue is visible to the user / debugger.
  // Server-side per-tenant `scopedTokensFailMode` will flip this to
  // closed in a future release.
  if (tokenResult.fail) {
    process.stderr.write(
      `[ACP] Scoped-token request failed (${tokenResult.reason ?? `HTTP ${tokenResult.status}`}); falling back to local credentials for this call.\n`
    );
    process.exit(0);
  }

  // Success — inject the ACP-issued token via updatedInput.command.
  // Bash inherits the env var naturally when it executes the prefixed
  // command, so the user's existing `gh repo list` workflow keeps
  // working but now with an ACP-brokered credential.
  if (tokenResult.token && input.tool_input?.command) {
    const original = String(input.tool_input.command);
    const updated = `${vendor.envVar}=${tokenResult.token} ${original}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input.tool_input, command: updated },
      },
    }));
    process.exit(0);
  }

  // No token + no failure case — should be unreachable, but exit safely.
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* PostToolUse                                                         */
/* ------------------------------------------------------------------ */

async function handlePostToolUse() {
  let outputStr = "";
  try {
    const out = input.tool_response ?? input.tool_output ?? input.output;
    if (typeof out === "string") outputStr = out;
    else if (out !== undefined && out !== null) outputStr = JSON.stringify(out);
  } catch {
    process.exit(0);
  }
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
    const res = await fetch(`${ACP_API}/govern/tool-output`, { method: "POST", headers, body, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) { process.exit(0); }
    const data = await res.json();
    if (data.action === "redact" || data.action === "block") {
      process.stdout.write(JSON.stringify({
        systemMessage: `[ACP] ${data.action === "block" ? "Blocked" : "Flagged"}: ${data.reason || "governance policy"}`,
      }));
    }
  } catch {
    // silent pass-through
  } finally { clearTimeout(timeout); }
  process.exit(0);
}

const hookEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : "PreToolUse";
if (hookEvent === "PostToolUse") handlePostToolUse();
else handlePreToolUse();
