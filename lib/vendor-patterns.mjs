// Vendor pattern detection — pure functions, no I/O. Imported by
// bin/govern.mjs to map matched Bash commands to a (provider, envVar)
// pair so the hook can request an ACP-issued scoped token and inject it
// transparently.
//
// Adding a new vendor: add to VENDOR_PATTERNS below + ensure
// gatewaystack-connect's userConnect.ts PROVIDERS list includes the same
// canonical lowercase provider key.

export const VENDOR_PATTERNS = [
  // GitHub — gh CLI
  { regex: /^gh(\s|$)/, provider: "github", envVar: "GH_TOKEN" },
  // GitHub — direct REST via curl
  { regex: /^curl\s+(.*\s)?(https?:\/\/)?api\.github\.com/, provider: "github", envVar: "GH_TOKEN" },
  // GitHub — git push over HTTPS
  { regex: /^git\s+push\s+https:\/\/github\.com\//, provider: "github", envVar: "GH_TOKEN" },
];

/**
 * Detect whether a tool call matches a known vendor pattern. Only
 * Bash-tool commands are inspected today; future versions can extend
 * to other tools as patterns emerge.
 *
 * @param {string} toolName - Claude Code tool name (e.g. "Bash")
 * @param {{command?: string} | undefined} toolInput - Claude Code tool input
 * @returns {{regex: RegExp, provider: string, envVar: string} | null}
 */
export function detectVendor(toolName, toolInput) {
  if (toolName !== "Bash") return null;
  const cmd = (toolInput?.command ?? "").toString().trim();
  if (!cmd) return null;
  for (const p of VENDOR_PATTERNS) {
    if (p.regex.test(cmd)) return p;
  }
  return null;
}
