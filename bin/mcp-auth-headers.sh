#!/bin/sh
# headersHelper for the bundled ACP MCP server — emits the Authorization
# header from the user's ACP credentials at connection time. Emits {} when
# not yet connected (server 401s, tools simply absent — never blocks startup).
KEY="$(cat "$HOME/.acp/credentials" 2>/dev/null || cat "$HOME/.acp/proxy-key" 2>/dev/null)"
[ -z "$KEY" ] && { echo '{}'; exit 0; }
printf '{"Authorization":"Bearer %s"}\n' "$KEY"
