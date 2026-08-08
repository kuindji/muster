import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SCHEMA = "muster.mcp.real-client-gate.v1";
const SHA256 = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;
const WIRE_ID = /^[\x21-\x7e]+$/;

const fail = (message) => {
  throw new Error(`invalid Muster MCP real-client gate evidence: ${message}`);
};

const record = (value, label) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
};

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} keys must be exactly ${wanted.join(",")}`);
  }
};

const timestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return Date.parse(value);
};

const nonempty = (value, label) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${label} must be one bounded non-empty string`);
  }
  return value;
};

const wireId = (value, label) => {
  if (typeof value !== "string" || !WIRE_ID.test(value)) {
    fail(`${label} must be a wire-safe identifier`);
  }
  return value;
};

const parseEvidence = (contents) => {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 4) fail("the file must contain exactly four JSONL rows");
  return lines.map((line, index) => {
    try {
      return record(JSON.parse(line), `row ${index + 1}`);
    } catch (error) {
      if (error instanceof SyntaxError) fail(`row ${index + 1} is not JSON`);
      throw error;
    }
  });
};

export function verifyMusterMcpRealClientGate(input) {
  if (typeof input.expectedNonce !== "string" || !NONCE.test(input.expectedNonce)) {
    fail("expected nonce is not a bounded high-entropy identifier");
  }
  const [scheduled, status, lease, submit] = parseEvidence(input.contents);
  const nonce = input.expectedNonce;
  const marker = `muster-mcp-gate-${nonce}`;

  exactKeys(scheduled, [
    "schema",
    "kind",
    "at",
    "nonce",
    "provider_surface",
    "account_plan",
    "scheduled_for",
    "window_ends_at",
    "unattended",
    "schedule_evidence_sha256",
  ], "scheduled row");
  if (scheduled.schema !== SCHEMA || scheduled.kind !== "scheduled_run") {
    fail("first row must be the v1 scheduled_run row");
  }
  if (scheduled.nonce !== nonce) fail("scheduled row nonce differs");
  nonempty(scheduled.provider_surface, "provider_surface");
  nonempty(scheduled.account_plan, "account_plan");
  if (scheduled.unattended !== true) fail("scheduled run must be unattended");
  if (
    typeof scheduled.schedule_evidence_sha256 !== "string" ||
    !SHA256.test(scheduled.schedule_evidence_sha256)
  ) {
    fail("schedule_evidence_sha256 must be lowercase SHA-256 hex");
  }
  const recordedAt = timestamp(scheduled.at, "scheduled at");
  const scheduledFor = timestamp(scheduled.scheduled_for, "scheduled_for");
  const windowEndsAt = timestamp(scheduled.window_ends_at, "window_ends_at");
  if (recordedAt > scheduledFor || scheduledFor >= windowEndsAt) {
    fail("schedule timestamps are not ordered");
  }

  const statusKeys = [
    "schema",
    "kind",
    "at",
    "nonce",
    "tool",
    "outcome",
    "worker_id",
    "status",
    "contract_version",
    "skill_sha256",
  ];
  exactKeys(status, statusKeys, "status row");
  if (
    status.schema !== SCHEMA ||
    status.kind !== "tool_result" ||
    status.nonce !== nonce ||
    status.tool !== "get_worker_status" ||
    status.outcome !== "success"
  ) {
    fail("second row must be a successful get_worker_status result");
  }
  wireId(status.worker_id, "status worker_id");
  if (status.status !== "active") fail("gate worker status must be active");
  nonempty(status.contract_version, "contract_version");
  if (typeof status.skill_sha256 !== "string" || !SHA256.test(status.skill_sha256)) {
    fail("skill_sha256 must be lowercase SHA-256 hex");
  }

  const leaseKeys = [
    "schema",
    "kind",
    "at",
    "nonce",
    "tool",
    "outcome",
    "worker_id",
    "job_id",
    "lease_id",
    "input_hash",
    "payload_marker",
  ];
  exactKeys(lease, leaseKeys, "lease row");
  if (
    lease.schema !== SCHEMA ||
    lease.kind !== "tool_result" ||
    lease.nonce !== nonce ||
    lease.tool !== "lease_job" ||
    lease.outcome !== "leased" ||
    lease.payload_marker !== marker
  ) {
    fail("third row must be the nonce-bound leased result");
  }
  for (const key of ["worker_id", "job_id", "lease_id", "input_hash"]) {
    wireId(lease[key], `lease ${key}`);
  }

  const submitKeys = [
    "schema",
    "kind",
    "at",
    "nonce",
    "tool",
    "outcome",
    "worker_id",
    "job_id",
    "lease_id",
    "input_hash",
    "result_marker",
  ];
  exactKeys(submit, submitKeys, "submit row");
  if (
    submit.schema !== SCHEMA ||
    submit.kind !== "tool_result" ||
    submit.nonce !== nonce ||
    submit.tool !== "submit_result" ||
    submit.outcome !== "accepted" ||
    submit.result_marker !== marker
  ) {
    fail("fourth row must be the nonce-bound accepted result");
  }
  for (const key of ["worker_id", "job_id", "lease_id", "input_hash"]) {
    wireId(submit[key], `submit ${key}`);
    if (submit[key] !== lease[key]) fail(`${key} differs between lease and submit`);
  }
  if (status.worker_id !== lease.worker_id) {
    fail("worker_id differs between status and lease");
  }

  const callTimes = [status, lease, submit].map((row, index) =>
    timestamp(row.at, `tool row ${index + 1} at`)
  );
  if (
    callTimes[0] < scheduledFor ||
    callTimes[2] > windowEndsAt ||
    !(callTimes[0] < callTimes[1] && callTimes[1] < callTimes[2])
  ) {
    fail("tool calls must be strictly ordered inside the schedule window");
  }

  if (input.scheduleEvidence !== undefined) {
    const digest = createHash("sha256").update(input.scheduleEvidence).digest("hex");
    if (digest !== scheduled.schedule_evidence_sha256) {
      fail("saved schedule artifact does not match schedule_evidence_sha256");
    }
  }

  return {
    nonce,
    providerSurface: scheduled.provider_surface,
    workerId: status.worker_id,
    jobId: lease.job_id,
    leaseId: lease.lease_id,
    scheduleArtifactVerified: input.scheduleEvidence !== undefined,
  };
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("usage: --file <jsonl> --nonce <nonce> [--schedule-evidence <file>]");
    }
    if (values.has(key)) fail(`duplicate argument ${key}`);
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!["--file", "--nonce", "--schedule-evidence"].includes(key)) {
      fail(`unknown argument ${key}`);
    }
  }
  if (!values.has("--file") || !values.has("--nonce")) {
    fail("usage: --file <jsonl> --nonce <nonce> [--schedule-evidence <file>]");
  }
  return values;
}

function main(arguments_) {
  const values = parseArguments(arguments_);
  const result = verifyMusterMcpRealClientGate({
    contents: readFileSync(values.get("--file"), "utf8"),
    expectedNonce: values.get("--nonce"),
    ...(values.has("--schedule-evidence")
      ? { scheduleEvidence: readFileSync(values.get("--schedule-evidence")) }
      : {}),
  });
  process.stdout.write(
    `Muster MCP real-client gate trace valid for ${result.nonce}` +
      `${result.scheduleArtifactVerified ? " with schedule artifact" : ""}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
