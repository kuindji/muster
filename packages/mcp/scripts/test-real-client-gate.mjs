import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyMusterMcpRealClientGate } from "./verify-real-client-gate.mjs";

const nonce = "0123456789abcdef0123456789abcdef0123456789abcdef";
const scheduleEvidence = Buffer.from("test-only schedule artifact\n");
const scheduleEvidenceSha256 = createHash("sha256")
  .update(scheduleEvidence)
  .digest("hex");
const common = {
  schema: "muster.mcp.real-client-gate.v1",
  nonce,
};
const rows = [
  {
    ...common,
    kind: "scheduled_run",
    at: "2026-08-08T12:00:00.000Z",
    provider_surface: "test-only.example",
    account_plan: "test-only",
    scheduled_for: "2026-08-08T12:05:00.000Z",
    window_ends_at: "2026-08-08T12:15:00.000Z",
    unattended: true,
    schedule_evidence_sha256: scheduleEvidenceSha256,
  },
  {
    ...common,
    kind: "tool_result",
    at: "2026-08-08T12:05:01.000Z",
    tool: "get_worker_status",
    outcome: "success",
    worker_id: "worker-gate-1",
    status: "active",
    contract_version: "1.1.0",
    skill_sha256: "b".repeat(64),
  },
  {
    ...common,
    kind: "tool_result",
    at: "2026-08-08T12:05:02.000Z",
    tool: "lease_job",
    outcome: "leased",
    worker_id: "worker-gate-1",
    job_id: "job-gate-1",
    lease_id: "lease-gate-1",
    input_hash: "input-gate-1",
    payload_marker: `muster-mcp-gate-${nonce}`,
  },
  {
    ...common,
    kind: "tool_result",
    at: "2026-08-08T12:05:03.000Z",
    tool: "submit_result",
    outcome: "accepted",
    worker_id: "worker-gate-1",
    job_id: "job-gate-1",
    lease_id: "lease-gate-1",
    input_hash: "input-gate-1",
    result_marker: `muster-mcp-gate-${nonce}`,
  },
];

const contents = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const result = verifyMusterMcpRealClientGate({
  contents,
  expectedNonce: nonce,
  scheduleEvidence,
});
assert.equal(result.scheduleArtifactVerified, true);
assert.equal(result.providerSurface, "test-only.example");

const mismatchedLease = structuredClone(rows);
mismatchedLease[3].lease_id = "lease-other";
assert.throws(
  () =>
    verifyMusterMcpRealClientGate({
      contents: `${mismatchedLease.map((row) => JSON.stringify(row)).join("\n")}\n`,
      expectedNonce: nonce,
      scheduleEvidence,
    }),
  /lease_id differs/,
);

const extraSensitiveField = structuredClone(rows);
extraSensitiveField[1].subject = "raw-subject";
assert.throws(
  () =>
    verifyMusterMcpRealClientGate({
      contents: `${extraSensitiveField.map((row) => JSON.stringify(row)).join("\n")}\n`,
      expectedNonce: nonce,
      scheduleEvidence,
    }),
  /status row keys must be exactly/,
);

const inactiveWorker = structuredClone(rows);
inactiveWorker[1].status = "maintenance";
assert.throws(
  () =>
    verifyMusterMcpRealClientGate({
      contents: `${inactiveWorker.map((row) => JSON.stringify(row)).join("\n")}\n`,
      expectedNonce: nonce,
      scheduleEvidence,
    }),
  /gate worker status must be active/,
);

assert.throws(
  () =>
    verifyMusterMcpRealClientGate({
      contents,
      expectedNonce: nonce,
      scheduleEvidence: Buffer.from("wrong schedule artifact\n"),
    }),
  /schedule artifact does not match/,
);

process.stdout.write("Muster MCP real-client gate verifier tests passed\n");
