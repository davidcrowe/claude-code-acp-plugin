// Unit tests for the vendor pattern detection used by the Phase 1
// scoped-token injection flow in govern.mjs.
//
// Run with: node --test test/vendor-patterns.test.mjs
//
// These tests cover the pattern correctness — false negatives here mean
// real agent calls slip through ungoverned, false positives mean we
// intercept calls we shouldn't. Both are bad for users.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectVendor, VENDOR_PATTERNS } from "../lib/vendor-patterns.mjs";

test("detectVendor: returns null for non-Bash tools", () => {
  assert.equal(detectVendor("Read", { command: "gh repo list" }), null);
  assert.equal(detectVendor("Edit", { command: "gh repo list" }), null);
  assert.equal(detectVendor("WebFetch", { command: "gh repo list" }), null);
});

test("detectVendor: returns null for empty / undefined Bash command", () => {
  assert.equal(detectVendor("Bash", undefined), null);
  assert.equal(detectVendor("Bash", {}), null);
  assert.equal(detectVendor("Bash", { command: "" }), null);
  assert.equal(detectVendor("Bash", { command: "   " }), null);
});

test("detectVendor: matches gh CLI invocations", () => {
  const cases = [
    "gh repo list",
    "gh pr create --title 'x'",
    "gh auth status",
    "gh", // bare invocation (e.g. for help)
  ];
  for (const cmd of cases) {
    const result = detectVendor("Bash", { command: cmd });
    assert.ok(result, `expected match for: ${cmd}`);
    assert.equal(result.provider, "github");
    assert.equal(result.envVar, "GH_TOKEN");
  }
});

test("detectVendor: does NOT match commands that merely contain 'gh'", () => {
  // Avoid false positives where 'gh' appears mid-command but isn't the binary.
  const cases = [
    "echo gh",
    "ls /usr/local/bin/gh",
    "ghost --version",
    "ghc --version",
    "high-level-script",
    "rm -rf weight",
  ];
  for (const cmd of cases) {
    assert.equal(
      detectVendor("Bash", { command: cmd }),
      null,
      `expected NO match for: ${cmd}`,
    );
  }
});

test("detectVendor: matches curl to api.github.com", () => {
  const cases = [
    "curl https://api.github.com/user",
    "curl -s https://api.github.com/repos/x/y",
    "curl -H 'Accept: x' https://api.github.com/repos",
    "curl -L --silent api.github.com/users/me",
  ];
  for (const cmd of cases) {
    const result = detectVendor("Bash", { command: cmd });
    assert.ok(result, `expected match for: ${cmd}`);
    assert.equal(result.provider, "github");
  }
});

test("detectVendor: does NOT match curl to other hosts", () => {
  const cases = [
    "curl https://example.com",
    "curl https://api.gitlab.com/projects",
    "curl https://raw.githubusercontent.com/x/y/main/file",
    "curl https://github.com/davidcrowe/repo/archive/main.tar.gz",
  ];
  for (const cmd of cases) {
    assert.equal(
      detectVendor("Bash", { command: cmd }),
      null,
      `expected NO match for: ${cmd}`,
    );
  }
});

test("detectVendor: matches git push over HTTPS to github.com", () => {
  const cases = [
    "git push https://github.com/davidcrowe/repo main",
    "git push https://github.com/me/proj feat/branch",
  ];
  for (const cmd of cases) {
    const result = detectVendor("Bash", { command: cmd });
    assert.ok(result, `expected match for: ${cmd}`);
    assert.equal(result.provider, "github");
  }
});

test("detectVendor: does NOT match git push to other hosts or SSH", () => {
  const cases = [
    "git push origin main", // unspecified remote
    "git push git@github.com:davidcrowe/repo.git main", // SSH
    "git push https://gitlab.com/x/y main",
    "git push https://bitbucket.org/x/y main",
  ];
  for (const cmd of cases) {
    assert.equal(
      detectVendor("Bash", { command: cmd }),
      null,
      `expected NO match for: ${cmd}`,
    );
  }
});

test("VENDOR_PATTERNS: shape is consistent", () => {
  for (const p of VENDOR_PATTERNS) {
    assert.ok(p.regex instanceof RegExp, `regex required: ${JSON.stringify(p)}`);
    assert.equal(typeof p.provider, "string");
    assert.equal(typeof p.envVar, "string");
    assert.match(p.provider, /^[a-z][a-z0-9-]*$/, "provider must be canonical lowercase");
    assert.match(p.envVar, /^[A-Z][A-Z0-9_]*$/, "envVar must be SCREAMING_SNAKE");
    // If hostVar set, hostValue must also be set
    if (p.hostVar !== undefined) {
      assert.match(p.hostVar, /^[A-Z][A-Z0-9_]*$/, "hostVar must be SCREAMING_SNAKE");
      assert.equal(typeof p.hostValue, "string", "hostValue required when hostVar is set");
      assert.ok(p.hostValue.length > 0, "hostValue must be non-empty");
      assert.ok(!p.hostValue.includes("://"), "hostValue must be hostname-only, no protocol");
    }
  }
});

test("VENDOR_PATTERNS: gh CLI pattern has GH_HOST proxy routing", () => {
  // The gh pattern is the only one with full proxy support today —
  // GH_HOST + GH_TOKEN sent together routes through ACP's egress proxy.
  const ghPattern = VENDOR_PATTERNS.find((p) => p.regex.source.startsWith("^gh"));
  assert.ok(ghPattern, "gh pattern must exist");
  assert.equal(ghPattern.hostVar, "GH_HOST");
  assert.match(ghPattern.hostValue, /agenticcontrolplane\.com|localhost/);
});

test("VENDOR_PATTERNS: curl/git-push patterns are token-only (no proxy)", () => {
  // curl + git push patterns issue a scoped token but the call still
  // goes direct to the vendor. Document this with the test so a future
  // contributor adding hostVar to them does so intentionally.
  const nonGh = VENDOR_PATTERNS.filter((p) => !p.regex.source.startsWith("^gh"));
  for (const p of nonGh) {
    assert.equal(p.hostVar, undefined, `pattern ${p.regex} should not have hostVar yet`);
  }
});

test("VENDOR_PATTERNS: all current entries are GitHub (Phase 1+2 vendor #1)", () => {
  // When we add Slack/Salesforce/etc. (Phase 3+), this assertion
  // updates. Today, only GitHub is in scope, so this guards against
  // accidentally adding a pattern without bumping the test list.
  const providers = new Set(VENDOR_PATTERNS.map((p) => p.provider));
  assert.deepEqual([...providers], ["github"]);
});
