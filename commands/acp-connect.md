---
name: acp-connect
description: Connect to ACP — identity & governance for every Claude Code tool call
user-invocable: true
---

Help the user connect to the Agentic Control Plane. Use the instructions in the `acp` skill (skills/acp/SKILL.md) to walk them through the full setup:

1. Check if `~/.acp/credentials` exists (already configured?)
2. If not: open `https://cloud.agenticcontrolplane.com/plugin/authorize` in the browser
3. Wait for the user to paste their token
4. Store the token in `~/.acp/credentials` with `chmod 600`
5. Verify by hitting `GET https://api.agenticcontrolplane.com/govern/health`
6. Direct them to `https://cloud.agenticcontrolplane.com/logs` to see their audit trail

Keep it conversational and seamless. The user should go from zero to seeing their first logged tool call in under 2 minutes.

After setup, let them know: "Every tool call I make — Bash, file edits, web fetches, everything — is now logged to your ACP workspace. You can set policies to control what's allowed from the dashboard."
