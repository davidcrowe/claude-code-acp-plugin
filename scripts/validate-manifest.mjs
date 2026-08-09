#!/usr/bin/env node

// Manifest checks that `claude plugin validate` does NOT perform (#593).
//
// The CLI's validate command checks .claude-plugin/marketplace.json only, so
// a broken plugin.json false-greens locally while `claude plugin install`
// fails for every user. That exact gap shipped in the first commit
// (`"author": "GatewayStack"` — string where the install schema requires an
// object) and survived four months because nothing between the repo and a
// user's machine ever parsed plugin.json with the installer's rules.
//
// This script asserts the shapes the install-time schema actually enforces,
// plus cross-file invariants (version sync) that no single-file validator
// can see. CI pairs it with a real `claude plugin install` into a scratch
// HOME — the only fully honest check — in .github/workflows/validate.yml.

import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✘ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

function load(rel) {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  } catch (err) {
    fail(`${rel}: ${err.message}`);
    return null;
  }
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const plugin = load("plugin.json");
const marketplace = load(".claude-plugin/marketplace.json");

if (plugin) {
  if (typeof plugin.name !== "string" || !plugin.name) {
    fail("plugin.json: name must be a non-empty string");
  }
  if (typeof plugin.version !== "string" || !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    fail(`plugin.json: version must be semver, got ${JSON.stringify(plugin.version)}`);
  }
  // The #593 regression: a string author passes `claude plugin validate`
  // but fails `claude plugin install` with "expected object, received
  // string" — for every user, on every platform.
  if (!isPlainObject(plugin.author)) {
    fail(`plugin.json: author must be an OBJECT ({ name, url }), got ${JSON.stringify(plugin.author)} — a string author breaks claude plugin install (#593)`);
  } else if (typeof plugin.author.name !== "string" || !plugin.author.name) {
    fail("plugin.json: author.name must be a non-empty string");
  } else {
    ok("plugin.json author is an object with a name");
  }
  if (typeof plugin.hooks === "string" && !existsSync(join(ROOT, plugin.hooks))) {
    fail(`plugin.json: hooks path ${plugin.hooks} does not exist`);
  }
}

if (marketplace) {
  const entry = Array.isArray(marketplace.plugins) ? marketplace.plugins[0] : null;
  if (!entry) {
    fail(".claude-plugin/marketplace.json: plugins[0] missing");
  } else {
    if (entry.author !== undefined && !isPlainObject(entry.author)) {
      fail(`marketplace.json: plugins[0].author must be an object, got ${JSON.stringify(entry.author)}`);
    }
    if (plugin && entry.version !== plugin.version) {
      fail(`version drift: plugin.json ${plugin.version} vs marketplace.json ${entry.version} — keep them in sync`);
    } else if (plugin) {
      ok(`versions in sync (${plugin.version})`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} manifest problem(s). A real install would fail even if \`claude plugin validate\` passes.`);
  process.exit(1);
}
console.log("\nAll manifest checks passed.");
