// Canonical copy of the session-attestation payload logic (#403 paired
// arrival). bin/govern.mjs carries the same logic inline (it is
// deliberately self-contained, like vendor-patterns); this module exists
// so tests can pin the contract — the field names here are the wire
// contract with the gateway's /govern/attest endpoint.

import { createHash } from "crypto";

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The attestation body. hook_hash is REQUIRED — an attestation that
 *  can't prove what's running is not an attestation. grants_present
 *  encodes the #375 pairing invariant: capability (harness grants) must
 *  be visible alongside authority (this hook, alive and hashed). */
export function buildAttestationPayload({
  sessionId,
  cwd,
  pluginVersion,
  hookHash,
  grantsHash,
  harness,
}) {
  if (!hookHash) return null;
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: "SessionStart",
    plugin_version: pluginVersion,
    hook_hash: hookHash,
    grants_present: grantsHash != null,
    ...(grantsHash ? { grants_hash: grantsHash } : {}),
    harness,
  };
}
