// Pins the /govern/attest wire contract (#403). If a field name here
// drifts from the gateway's expectations, attestation silently degrades
// to "unattested" for every session — these tests are the tripwire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, buildAttestationPayload } from "../lib/attestation.mjs";

test("sha256Hex is deterministic and 64 hex chars", () => {
  const a = sha256Hex("hello");
  assert.equal(a, sha256Hex("hello"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, sha256Hex("hello "));
});

test("payload carries the pairing invariant fields", () => {
  const p = buildAttestationPayload({
    sessionId: "s1",
    cwd: "/work",
    pluginVersion: "0.9.0",
    hookHash: "a".repeat(64),
    grantsHash: "b".repeat(64),
    harness: "claude-code",
  });
  assert.equal(p.session_id, "s1");
  assert.equal(p.hook_event_name, "SessionStart");
  assert.equal(p.plugin_version, "0.9.0");
  assert.equal(p.hook_hash, "a".repeat(64));
  assert.equal(p.grants_present, true);
  assert.equal(p.grants_hash, "b".repeat(64));
  assert.equal(p.harness, "claude-code");
});

test("no grants file → grants_present false, no grants_hash key", () => {
  const p = buildAttestationPayload({
    sessionId: "s1",
    cwd: "/work",
    pluginVersion: "0.9.0",
    hookHash: "a".repeat(64),
    grantsHash: null,
    harness: "claude-code",
  });
  assert.equal(p.grants_present, false);
  assert.equal("grants_hash" in p, false);
});

test("an attestation without a hook hash is no attestation at all", () => {
  assert.equal(
    buildAttestationPayload({ sessionId: "s1", pluginVersion: "0.9.0", hookHash: null }),
    null,
  );
});
