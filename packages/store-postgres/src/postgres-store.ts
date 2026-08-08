import type {
  ClassHealthSnapshot,
  ClassVersionRecord,
  ClaimLeaseOutcome,
  ContractTransitionOutcome,
  EnqueueOutcome,
  InitializeClassHealthOutcome,
  JobCycleAttemptSnapshot,
  JobRecord,
  LeaseCandidateSnapshot,
  LeaseRecord,
  NoWorkAttemptOutcome,
  OperationalTransitionOutcome,
  PermitEpochTransitionOutcome,
  QueueModeSnapshot,
  ReputationEvidenceRecord,
  RegisterClassVersionOutcome,
  RegisterWorkerOutcome,
  Store,
  WorkerRecord,
  WorkerRoutingSnapshot,
  WorkerRoutingTransitionOutcome,
  WorkerStateTransitionOutcome,
} from "@kuindji/muster-core";
import type {
  PostgresStoreOptions,
  QueryableClient,
  QueryablePool,
  TransactionOptions,
} from "./config.js";
import { validatePostgresStoreOptions } from "./config.js";
import {
  commandFingerprint,
  decodePositiveRevision,
  decodeStoredJson,
  decodeStoredRecord,
  snapshotCommandInput,
  type JsonValue,
} from "./codecs.js";
import { PostgresInfrastructureError } from "./errors.js";
import {
  withPoolClient,
  withSerializableTransaction,
} from "./transactions.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type AsyncStoreMethod = (...args: never[]) => Promise<unknown>;

interface RecordRow {
  readonly record: unknown;
}

interface RevisionedRecordRow extends RecordRow {
  readonly revision: string;
}

interface ReplayRow {
  readonly fingerprint: string;
  readonly outcome: unknown;
}

interface PayloadRow {
  readonly input_hash: unknown;
  readonly body: unknown;
}

interface CandidateRow {
  readonly job_record: unknown;
  readonly cycle_record: unknown;
  readonly attempt_record: unknown;
  readonly candidate_revision: string;
  readonly result_state: unknown;
  readonly queue_revision: string;
  readonly health_revision: string;
}

interface AcceptedSubmissionRow {
  readonly receipt: unknown;
  readonly body: unknown;
  readonly lease_record?: unknown;
}

interface ResultCycleRow {
  readonly result_state: unknown;
  readonly cycle_record: unknown;
  readonly candidate_revision: string;
  readonly attempt_record: unknown;
}

type AcceptedSubmission = NonNullable<
  Awaited<ReturnType<Store["getAcceptedSubmission"]>>
>;
type AcceptedReplica = Awaited<
  ReturnType<Store["listAcceptedReplicas"]>
>[number];
type DecisionResultRecord = NonNullable<
  Awaited<ReturnType<Store["getDecisionResult"]>>
>;
type ResultState = NonNullable<
  Awaited<ReturnType<Store["getResultState"]>>
>;

const workerStates = new Set([
  "enrolled", "active", "maintenance", "paused", "suspended", "revoked",
]);
const classStates = new Set(["draft", "active", "draining", "retired"]);
const queueModes = new Set([
  "normal", "degraded", "admission_halted", "emergency_halted",
]);
const queueCauses = new Set([
  "bootstrap", "capacity", "sla", "pool_offline", "operator", "emergency",
]);
const operatingStates = new Set([
  "ready", "adjudication_starved", "admission_halted", "emergency_halted",
]);
const reserveStates = new Set(["available", "saturated"]);
const healthSources = new Set(["automatic", "operator"]);
const resultStates = new Set([
  "collecting", "pending_result_adjudication", "verified", "rejected",
  "expired", "superseded", "cancelled",
]);
const verificationStrengths = new Set([
  "structural_only", "deterministic_oracle",
]);
const evidenceSources = new Set([
  "checked_success", "adjudicated_falsehood", "deterministic_oracle",
  "completeness_oracle", "held_out_canary", "human_audit",
  "published_correction", "structural_failure", "validator_failure",
  "post_payload_abandonment", "escalation_quota_abuse",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const compareWireIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const equal = (left: unknown, right: unknown): boolean =>
  commandFingerprint(left) === commandFingerprint(right);

function validWorkerRecord(record: JsonRecord): boolean {
  return isString(record.workerId) && isString(record.state) &&
    workerStates.has(record.state) && isString(record.enrolledAt) &&
    isNonNegativeSafeInteger(record.declaredCapPerWeek) &&
    isObject(record.capabilities) && isString(record.accountCluster) &&
    isNonNegativeSafeInteger(record.slot) && isObject(record.contractAcceptance);
}

function validRoutingSnapshot(record: JsonRecord): boolean {
  return decodePositiveRevision(record.revision) >= 1 &&
    isString(record.workerId) && isString(record.contributionWindowId) &&
    isNonNegativeSafeInteger(record.contributionUsed) &&
    isString(record.assignedSlotOccurrence) && Array.isArray(record.openLeaseIds) &&
    record.openLeaseIds.every(isString);
}

function validClassVersion(record: JsonRecord): boolean {
  return isString(record.classId) && isString(record.contractVersion) &&
    isString(record.payloadSchemaHash) && isString(record.outputSchemaHash) &&
    isString(record.state) && classStates.has(record.state) &&
    isString(record.registeredAt) &&
    (record.leaseDisabledAt === undefined || isString(record.leaseDisabledAt)) &&
    (record.acceptedUntil === undefined || isString(record.acceptedUntil));
}

function validQueueSnapshot(record: JsonRecord): boolean {
  return decodePositiveRevision(record.revision) >= 1 &&
    isString(record.mode) && queueModes.has(record.mode) &&
    isString(record.cause) && queueCauses.has(record.cause) &&
    isString(record.updatedAt);
}

function validHealthSnapshot(record: JsonRecord): boolean {
  if (
    decodePositiveRevision(record.revision) < 1 || !isString(record.classId) ||
    !isObject(record.health) || !isString(record.updatedAt) ||
    !isString(record.source) || !healthSources.has(record.source) ||
    (record.adjudicationUnsafeSince !== undefined &&
      !isString(record.adjudicationUnsafeSince))
  ) return false;
  const health = record.health;
  const reserves = health.reserves;
  if (!isString(health.operating) || !operatingStates.has(health.operating) ||
      !isObject(reserves)) return false;
  return ["lowCost", "urgent", "splitAndAdjudication", "audit"].every((lane) => {
    const state = reserves[lane];
    return isString(state) && reserveStates.has(state);
  });
}

function validLeaseRecord(record: JsonRecord): boolean {
  return isString(record.leaseId) && isString(record.classId) &&
    isString(record.jobId) && Number.isSafeInteger(record.collectionCycle) &&
    Number(record.collectionCycle) > 0 && isString(record.contractVersion) &&
    isString(record.permitEpoch) && isString(record.holder) &&
    isString(record.inputHash) && isString(record.policyVersion) &&
    isString(record.payloadRef) && isString(record.issuedAt) &&
    isString(record.expiresAt) && isString(record.absoluteInFlightDeadline) &&
    isNonNegativeSafeInteger(record.extensionsUsed) &&
    isObject(record.extensionPolicy) && isObject(record.snapshot) &&
    isObject(record.assignment) && isObject(record.routing) &&
    typeof record.open === "boolean";
}

function validAttemptSnapshot(record: JsonRecord): boolean {
  return isNonNegativeSafeInteger(record.attemptCount) &&
    Array.isArray(record.openLeaseIds) && record.openLeaseIds.every(isString) &&
    Array.isArray(record.acceptedWorkerIds) &&
    record.acceptedWorkerIds.every(isString) &&
    Array.isArray(record.acceptedDiversity) &&
    typeof record.splitObserved === "boolean";
}

function validJobRecord(record: JsonRecord): boolean {
  return isString(record.jobId) && isString(record.classId) &&
    isString(record.contractVersion) && isString(record.inputHash) &&
    isString(record.payloadRef) && isString(record.policyVersion) &&
    isString(record.permitEpoch) && Number.isSafeInteger(record.collectionCycle) &&
    Number(record.collectionCycle) > 0 && isString(record.firstEnqueuedAt) &&
    isString(record.cycleStartedAt) &&
    isNonNegativeSafeInteger(record.rejectedDisputeRequeues) &&
    (record.notBefore === undefined || isString(record.notBefore)) &&
    isObject(record.queuePriority) &&
    (record.queuePriority.lane === "normal" || record.queuePriority.lane === "urgent") &&
    Number.isSafeInteger(record.queuePriority.value) &&
    isString(record.queuePriority.enqueuedAt) &&
    isString(record.queuePriority.sequence);
}

function validSubmissionReceipt(record: JsonRecord): boolean {
  return isString(record.leaseId) && isString(record.jobId) &&
    Number.isSafeInteger(record.collectionCycle) &&
    Number(record.collectionCycle) > 0 && isString(record.inputHash) &&
    isString(record.resultHash) && isString(record.contractVersion) &&
    isString(record.permitEpoch) && record.outcome === "accepted" &&
    isString(record.acceptedAt);
}

function validSubmissionEvidence(value: unknown): boolean {
  return isObject(value) && isString(value.leaseId) &&
    Number.isSafeInteger(value.collectionCycle) &&
    Number(value.collectionCycle) > 0 && isString(value.resultHash) &&
    isString(value.workerId);
}

function validDecisionResult(record: JsonRecord): boolean {
  return isString(record.decisionResultHash) && isString(record.jobId) &&
    Number.isSafeInteger(record.collectionCycle) &&
    Number(record.collectionCycle) > 0 && isString(record.inputHash) &&
    record.result !== undefined && Array.isArray(record.evidence) &&
    record.evidence.every(validSubmissionEvidence) &&
    isString(record.achievedStrength) &&
    verificationStrengths.has(record.achievedStrength) &&
    (record.resultAdjudicationVerdictHash === undefined ||
      isString(record.resultAdjudicationVerdictHash)) &&
    isString(record.contractVersion) && isString(record.permitEpoch) &&
    isString(record.verifiedAt);
}

function validReputationEvidence(record: JsonRecord): boolean {
  if (!isString(record.evidenceId) || !isString(record.workerId) ||
      !isString(record.at) || !isString(record.source) ||
      !evidenceSources.has(record.source) ||
      (record.detailHash !== undefined && !isString(record.detailHash)) ||
      (record.impact !== "positive" && record.impact !== "negative")) {
    return false;
  }
  if (record.source === "checked_success" && record.impact !== "positive") {
    return false;
  }
  if (record.source !== "checked_success" && record.impact !== "negative") {
    return false;
  }
  return record.job === undefined ||
    (isObject(record.job) && isString(record.job.jobId) &&
      Number.isSafeInteger(record.job.collectionCycle) &&
      Number(record.job.collectionCycle) > 0);
}

function decodeSubmissionReceipt(
  value: unknown,
  description = "accepted_submissions.receipt",
): AcceptedSubmission["receipt"] {
  const record = decodeStoredRecord<AcceptedSubmission["receipt"]>(
    value,
    validSubmissionReceipt,
    description,
  );
  return {
    leaseId: record.leaseId,
    jobId: record.jobId,
    collectionCycle: record.collectionCycle,
    inputHash: record.inputHash,
    resultHash: record.resultHash,
    contractVersion: record.contractVersion,
    permitEpoch: record.permitEpoch,
    outcome: record.outcome,
    acceptedAt: record.acceptedAt,
  };
}

function decodeDecisionResult(
  value: unknown,
  description = "decisions.record",
): DecisionResultRecord {
  const record = decodeStoredRecord<DecisionResultRecord>(
    value,
    validDecisionResult,
    description,
  );
  return {
    decisionResultHash: record.decisionResultHash,
    jobId: record.jobId,
    collectionCycle: record.collectionCycle,
    inputHash: record.inputHash,
    result: record.result,
    evidence: record.evidence.map((entry) => ({
      leaseId: entry.leaseId,
      collectionCycle: entry.collectionCycle,
      resultHash: entry.resultHash,
      workerId: entry.workerId,
    })),
    achievedStrength: record.achievedStrength,
    ...(record.resultAdjudicationVerdictHash === undefined
      ? {}
      : { resultAdjudicationVerdictHash: record.resultAdjudicationVerdictHash }),
    contractVersion: record.contractVersion,
    permitEpoch: record.permitEpoch,
    verifiedAt: record.verifiedAt,
  };
}

function validClaimOutcome(record: JsonRecord): boolean {
  return record.kind === "claimed" && isObject(record.lease) &&
    isObject(record.job) && validLeaseRecord(record.lease) &&
    validJobRecord(record.job);
}

function decodeJob(row: RecordRow, description = "jobs.record"): JobRecord {
  return decodeStoredRecord<JobRecord>(row.record, validJobRecord, description);
}

function decodeLease(row: RecordRow, description = "leases.record"): LeaseRecord {
  return decodeStoredRecord<LeaseRecord>(row.record, validLeaseRecord, description);
}

function decodeAttempt(
  row: { readonly candidate_revision: string; readonly attempt_record: unknown },
  description = "attempts.record",
): { readonly revision: number; readonly attempts: JobCycleAttemptSnapshot } {
  return {
    revision: decodePositiveRevision(
      row.candidate_revision,
      "attempts.candidate_revision",
    ),
    attempts: decodeStoredRecord<JobCycleAttemptSnapshot>(
      row.attempt_record,
      validAttemptSnapshot,
      description,
    ),
  };
}

function decodeCandidate(row: CandidateRow): LeaseCandidateSnapshot {
  const job = decodeJob({ record: row.job_record });
  const cycle = decodeJob({ record: row.cycle_record }, "job_cycles.record");
  const attempt = decodeAttempt(row);
  if (!equal(job, cycle) || row.result_state !== "collecting") {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      `job ${job.jobId} current-cycle projections disagree`,
    );
  }
  return {
    revision: attempt.revision,
    job,
    attempts: attempt.attempts,
    operational: {
      queueRevision: decodePositiveRevision(
        row.queue_revision,
        "queue_state.revision",
      ),
      classHealthRevision: decodePositiveRevision(
        row.health_revision,
        "class_health.revision",
      ),
    },
  };
}

const validOutcome = (...kinds: string[]) => (record: JsonRecord): boolean =>
  isString(record.kind) && kinds.includes(record.kind);

function decodeWorker(row: RecordRow, description = "workers.record"): WorkerRecord {
  return decodeStoredRecord<WorkerRecord>(row.record, validWorkerRecord, description);
}

function decodeRouting(
  row: RevisionedRecordRow,
  description = "worker_routing.record",
): WorkerRoutingSnapshot {
  const record = decodeStoredRecord<WorkerRoutingSnapshot>(
    row.record,
    validRoutingSnapshot,
    description,
  );
  if (record.revision !== decodePositiveRevision(row.revision, `${description}.revision`)) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      `${description} revision projection does not match its record`,
    );
  }
  return record;
}

function decodeClassVersion(
  row: RecordRow,
  description = "class_versions.record",
): ClassVersionRecord {
  return decodeStoredRecord<ClassVersionRecord>(
    row.record,
    validClassVersion,
    description,
  );
}

function decodeQueue(row: RevisionedRecordRow): QueueModeSnapshot {
  const record = decodeStoredRecord<QueueModeSnapshot>(
    row.record,
    validQueueSnapshot,
    "queue_state.record",
  );
  if (record.revision !== decodePositiveRevision(row.revision, "queue_state.revision")) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      "queue_state revision projection does not match its record",
    );
  }
  return record;
}

function decodeHealth(
  row: RevisionedRecordRow,
  description = "class_health.record",
): ClassHealthSnapshot {
  const record = decodeStoredRecord<ClassHealthSnapshot>(
    row.record,
    validHealthSnapshot,
    description,
  );
  if (record.revision !== decodePositiveRevision(row.revision, `${description}.revision`)) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      `${description} revision projection does not match its record`,
    );
  }
  return record;
}

function restartSerializableTransaction(): never {
  throw Object.assign(new Error("concurrent insert requires a fresh snapshot"), {
    code: "40001",
  });
}

function notImplemented<Method extends AsyncStoreMethod>(method: string): Method {
  return (async (..._arguments: never[]) => {
    throw new PostgresInfrastructureError(
      "not_implemented",
      `PostgreSQL Store method ${method} is not implemented in this staged adapter`,
    );
  }) as unknown as Method;
}

/**
 * PostgreSQL implementation of the frozen Store boundary.
 *
 * The adapter borrows a client per operation and never owns caller pool
 * shutdown. Tasks 3 through 5 implement control, lease, and result state;
 * later plan slices remain explicit infrastructure stubs so the class is
 * already Store-assignable.
 */
export class PostgresStore implements Store {
  readonly schema: string;
  readonly quotedSchema: string;
  readonly transactionOptions: Readonly<TransactionOptions>;
  readonly #pool: QueryablePool;
  #creationTail: Promise<void> = Promise.resolve();

  constructor(options: PostgresStoreOptions) {
    const validated = validatePostgresStoreOptions(options);
    this.#pool = validated.pool;
    this.schema = validated.schema;
    this.quotedSchema = validated.quotedSchema;
    this.transactionOptions = validated.transaction;
    Object.freeze(this);
  }

  /** Internal adapter access; ownership and shutdown remain with the caller. */
  protected get pool(): QueryablePool {
    return this.#pool;
  }

  private transact<Input, Output>(
    input: Input,
    operation: (client: QueryableClient, input: Readonly<Input>) => Promise<Output>,
  ): Promise<Output> {
    return withSerializableTransaction({
      pool: this.#pool,
      options: this.transactionOptions,
      input,
      operation,
    });
  }

  private inCreationOrder<Output>(operation: () => Promise<Output>): Promise<Output> {
    const result = this.#creationTail.then(operation, operation);
    this.#creationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readReplay<Outcome>(
    client: QueryableClient,
    commandKind: string,
    commandKey: string,
    fingerprint: string,
    validate: (record: JsonRecord) => boolean,
  ): Promise<Outcome | null> {
    const result = await client.query<ReplayRow>(
      `SELECT fingerprint, outcome
         FROM ${this.quotedSchema}.command_replays
        WHERE command_kind = $1 AND command_key = $2`,
      [commandKind, commandKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.fingerprint !== fingerprint) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        `command replay fingerprint mismatch for ${commandKind}`,
      );
    }
    return decodeStoredRecord<Outcome>(row.outcome, validate, `${commandKind}.outcome`);
  }

  private async writeReplay(
    client: QueryableClient,
    commandKind: string,
    commandKey: string,
    fingerprint: string,
    outcome: object,
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO ${this.quotedSchema}.command_replays
         (command_kind, command_key, fingerprint, outcome)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (command_kind, command_key) DO NOTHING`,
      [commandKind, commandKey, fingerprint, JSON.stringify(outcome)],
    );
    if (inserted.rowCount !== 1) restartSerializableTransaction();
  }

  private async loadCandidate(
    client: QueryableClient,
    jobId: string,
    lock: boolean,
  ): Promise<LeaseCandidateSnapshot | null> {
    const result = await client.query<CandidateRow>(
      `SELECT j.record AS job_record, jc.record AS cycle_record,
              a.record AS attempt_record, a.candidate_revision,
              jc.result_state, q.revision AS queue_revision,
              h.revision AS health_revision
         FROM ${this.quotedSchema}.jobs j
         JOIN ${this.quotedSchema}.job_cycles jc
           ON jc.job_id = j.job_id AND jc.collection_cycle = j.collection_cycle
         JOIN ${this.quotedSchema}.attempts a
           ON a.job_id = jc.job_id AND a.collection_cycle = jc.collection_cycle
         JOIN ${this.quotedSchema}.class_health h ON h.class_id = j.class_id
        CROSS JOIN ${this.quotedSchema}.queue_state q
        WHERE j.job_id = $1 AND jc.result_state = 'collecting'
        ${lock ? "FOR UPDATE OF j, jc, a, h, q" : ""}`,
      [jobId],
    );
    const row = result.rows[0];
    return row === undefined ? null : decodeCandidate(row);
  }

  private async closeLeaseAttempt(
    client: QueryableClient,
    lease: LeaseRecord,
    releaseContribution: boolean,
  ): Promise<void> {
    const attemptResult = await client.query<{
      readonly candidate_revision: string;
      readonly attempt_record: unknown;
    }>(
      `SELECT candidate_revision, record AS attempt_record
         FROM ${this.quotedSchema}.attempts
        WHERE job_id = $1 AND collection_cycle = $2
        FOR UPDATE`,
      [lease.jobId, lease.collectionCycle],
    );
    const attemptRow = attemptResult.rows[0];
    if (attemptRow === undefined) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        `lease ${lease.leaseId} has no attempt snapshot`,
      );
    }
    const { revision, attempts } = decodeAttempt(attemptRow);
    const routingResult = await client.query<RevisionedRecordRow>(
      `SELECT revision, record FROM ${this.quotedSchema}.worker_routing
        WHERE worker_id = $1 FOR UPDATE`,
      [lease.holder],
    );
    const routingRow = routingResult.rows[0];
    if (routingRow === undefined) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        `lease ${lease.leaseId} holder has no routing snapshot`,
      );
    }
    const routing = decodeRouting(routingRow);
    if (!attempts.openLeaseIds.includes(lease.leaseId) ||
        !routing.openLeaseIds.includes(lease.leaseId)) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        `lease ${lease.leaseId} open projections disagree`,
      );
    }

    const closedLease: LeaseRecord = { ...lease, open: false };
    const nextAttempts: JobCycleAttemptSnapshot = {
      ...attempts,
      openLeaseIds: attempts.openLeaseIds.filter((id) => id !== lease.leaseId),
    };
    const mayRelease = releaseContribution &&
      routing.contributionWindowId === lease.routing.contributionWindowId &&
      routing.contributionUsed > 0;
    const nextRouting: WorkerRoutingSnapshot = {
      ...routing,
      revision: routing.revision + 1,
      contributionUsed: mayRelease
        ? routing.contributionUsed - 1
        : routing.contributionUsed,
      openLeaseIds: routing.openLeaseIds.filter((id) => id !== lease.leaseId),
    };

    const closed = await client.query(
      `UPDATE ${this.quotedSchema}.leases
          SET open = false, record = $2::jsonb
        WHERE lease_id = $1 AND open = true`,
      [lease.leaseId, JSON.stringify(closedLease)],
    );
    if (closed.rowCount !== 1) restartSerializableTransaction();
    const attempted = await client.query(
      `UPDATE ${this.quotedSchema}.attempts
          SET candidate_revision = $3, attempt_count = $4,
              split_observed = $5, record = $6::jsonb
        WHERE job_id = $1 AND collection_cycle = $2
          AND candidate_revision = $7`,
      [
        lease.jobId,
        lease.collectionCycle,
        revision + 1,
        nextAttempts.attemptCount,
        nextAttempts.splitObserved,
        JSON.stringify(nextAttempts),
        revision,
      ],
    );
    if (attempted.rowCount !== 1) restartSerializableTransaction();
    const routed = await client.query(
      `UPDATE ${this.quotedSchema}.worker_routing
          SET revision = $2, contribution_used = $3, record = $4::jsonb
        WHERE worker_id = $1 AND revision = $5`,
      [
        lease.holder,
        nextRouting.revision,
        nextRouting.contributionUsed,
        JSON.stringify(nextRouting),
        routing.revision,
      ],
    );
    if (routed.rowCount !== 1) restartSerializableTransaction();
  }

  private async loadAcceptedReplicas(
    client: QueryableClient,
    jobId: string,
    collectionCycle: number,
  ): Promise<AcceptedReplica[]> {
    const result = await client.query<AcceptedSubmissionRow>(
      `SELECT s.receipt, s.body, l.record AS lease_record
         FROM ${this.quotedSchema}.accepted_submissions s
         JOIN ${this.quotedSchema}.leases l ON l.lease_id = s.lease_id
        WHERE s.job_id = $1 AND s.collection_cycle = $2
        ORDER BY s.lease_id COLLATE "C"`,
      [jobId, collectionCycle],
    );
    const replicas: AcceptedReplica[] = [];
    for (const row of result.rows) {
      const receipt = decodeSubmissionReceipt(row.receipt);
      const lease = decodeStoredRecord<LeaseRecord>(
        row.lease_record,
        validLeaseRecord,
        "leases.record",
      );
      if (lease.assignment.kind !== "ordinary") continue;
      if (receipt.leaseId !== lease.leaseId || receipt.jobId !== jobId ||
          receipt.collectionCycle !== collectionCycle ||
          receipt.inputHash !== lease.inputHash) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `accepted submission ${receipt.leaseId} disagrees with its lease`,
        );
      }
      replicas.push({
        evidence: {
          leaseId: lease.leaseId,
          collectionCycle,
          resultHash: receipt.resultHash,
          workerId: lease.holder,
        },
        body: decodeStoredJson(row.body),
        acceptedAt: receipt.acceptedAt,
      });
    }
    return replicas;
  }

  private async reputationEvidenceConflicts(
    client: QueryableClient,
    record?: Readonly<ReputationEvidenceRecord>,
  ): Promise<boolean> {
    if (record === undefined) return false;
    const result = await client.query<RecordRow>(
      `SELECT record FROM ${this.quotedSchema}.reputation_evidence
        WHERE evidence_id = $1 FOR UPDATE`,
      [record.evidenceId],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      const existing = decodeStoredRecord<ReputationEvidenceRecord>(
        row.record,
        validReputationEvidence,
        "reputation_evidence.record",
      );
      return !equal(existing, record);
    }
    const identity = await client.query(
      `SELECT identity_kind FROM ${this.quotedSchema}.core_identities
        WHERE identity_id = $1 FOR UPDATE`,
      [record.evidenceId],
    );
    return identity.rows[0] !== undefined;
  }

  private async persistReputationEvidence(
    client: QueryableClient,
    record?: Readonly<ReputationEvidenceRecord>,
  ): Promise<void> {
    if (record === undefined) return;
    const existing = await client.query<RecordRow>(
      `SELECT record FROM ${this.quotedSchema}.reputation_evidence
        WHERE evidence_id = $1 FOR UPDATE`,
      [record.evidenceId],
    );
    if (existing.rows[0] !== undefined) return;
    const identity = await client.query(
      `INSERT INTO ${this.quotedSchema}.core_identities
         (identity_id, identity_kind) VALUES ($1, 'reputation_evidence')
       ON CONFLICT (identity_id) DO NOTHING`,
      [record.evidenceId],
    );
    if (identity.rowCount !== 1) restartSerializableTransaction();
    await client.query(
      `INSERT INTO ${this.quotedSchema}.reputation_evidence
         (evidence_id, worker_id, source, observed_at, record)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)`,
      [
        record.evidenceId,
        record.workerId,
        record.source,
        record.at,
        JSON.stringify(record),
      ],
    );
  }

  async getWorker(
    workerId: Parameters<Store["getWorker"]>[0],
  ): ReturnType<Store["getWorker"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.workers WHERE worker_id = $1`,
        [workerId],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeWorker(row);
    });
  }

  async registerWorker(
    registration: Parameters<Store["registerWorker"]>[0],
  ): ReturnType<Store["registerWorker"]> {
    const snapshot = snapshotCommandInput(registration);
    return this.inCreationOrder(() => this.transact(snapshot, async (client, captured) => {
      const workerId = captured.worker.workerId;
      const fingerprint = commandFingerprint(captured);
      const workerResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.workers
          WHERE worker_id = $1 FOR UPDATE`,
        [workerId],
      );
      const routingResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.worker_routing
          WHERE worker_id = $1 FOR UPDATE`,
        [workerId],
      );
      const workerRow = workerResult.rows[0];
      const routingRow = routingResult.rows[0];
      if (workerRow !== undefined || routingRow !== undefined) {
        if (workerRow === undefined || routingRow === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `worker ${workerId} has a partial registration`,
          );
        }
        const worker = decodeWorker(workerRow);
        const routing = decodeRouting(routingRow);
        const replay = await client.query<ReplayRow>(
          `SELECT fingerprint, outcome
             FROM ${this.quotedSchema}.command_replays
            WHERE command_kind = 'register_worker' AND command_key = $1`,
          [workerId],
        );
        const history = replay.rows[0];
        if (history === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `worker ${workerId} is missing its registration receipt`,
          );
        }
        return history.fingerprint === fingerprint
          ? { kind: "replayed", worker, routing } as const
          : {
              kind: "conflict",
              existingWorker: worker,
              existingRouting: routing,
            } as const;
      }

      const worker: WorkerRecord = structuredClone(captured.worker);
      const routing: WorkerRoutingSnapshot = {
        revision: 1,
        workerId,
        contributionWindowId: captured.routing.contributionWindowId,
        contributionUsed: 0,
        assignedSlotOccurrence: captured.routing.assignedSlotOccurrence,
        openLeaseIds: [],
      };
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.workers
           (worker_id, state, enrolled_at, record)
         VALUES ($1, $2, $3::timestamptz, $4::jsonb)
         ON CONFLICT (worker_id) DO NOTHING`,
        [workerId, worker.state, worker.enrolledAt, JSON.stringify(worker)],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      await client.query(
        `INSERT INTO ${this.quotedSchema}.worker_routing
           (worker_id, revision, contribution_window_id, contribution_used,
            assigned_slot_occurrence, record)
         VALUES ($1, 1, $2, 0, $3, $4::jsonb)`,
        [
          workerId,
          routing.contributionWindowId,
          routing.assignedSlotOccurrence,
          JSON.stringify(routing),
        ],
      );
      const outcome: RegisterWorkerOutcome = { kind: "registered", worker, routing };
      await this.writeReplay(
        client,
        "register_worker",
        workerId,
        fingerprint,
        outcome,
      );
      return outcome;
    }));
  }

  async transitionWorkerState(
    input: Parameters<Store["transitionWorkerState"]>[0],
  ): ReturnType<Store["transitionWorkerState"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<WorkerStateTransitionOutcome>(
        client,
        "transition_worker_state",
        fingerprint,
        fingerprint,
        validOutcome("applied"),
      );
      if (replayed !== null && replayed.kind === "applied") {
        return { ...replayed, kind: "replayed" };
      }

      const workerResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.workers
          WHERE worker_id = $1 FOR UPDATE`,
        [captured.workerId],
      );
      const workerRow = workerResult.rows[0];
      if (workerRow === undefined) return { kind: "not_found" } as const;
      const worker = decodeWorker(workerRow);
      if (worker.state !== captured.from) {
        return { kind: "state_conflict", actual: worker.state } as const;
      }
      const routingResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.worker_routing
          WHERE worker_id = $1 FOR UPDATE`,
        [captured.workerId],
      );
      const routingRow = routingResult.rows[0];
      if (routingRow === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `worker ${captured.workerId} has no routing snapshot`,
        );
      }
      const routing = decodeRouting(routingRow);
      const closesLeases = captured.to === "suspended" || captured.to === "revoked";
      const requeuedOpenLeases: Extract<
        WorkerStateTransitionOutcome,
        { kind: "applied" | "replayed" }
      >["requeuedOpenLeases"] = [];

      if (closesLeases) {
        const leaseResult = await client.query<RecordRow>(
          `SELECT record FROM ${this.quotedSchema}.leases
            WHERE holder = $1 AND open = true
            ORDER BY lease_id COLLATE "C" FOR UPDATE`,
          [captured.workerId],
        );
        const leases = leaseResult.rows.map((row) =>
          decodeStoredRecord<LeaseRecord>(row.record, validLeaseRecord, "leases.record")
        );
        const durableLeaseIds = leases.map((lease) => lease.leaseId).sort(compareWireIds);
        const routingLeaseIds = [...routing.openLeaseIds].sort(compareWireIds);
        if (!equal(durableLeaseIds, routingLeaseIds)) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `worker ${captured.workerId} open-lease projections disagree`,
          );
        }
        for (const lease of leases) {
          const closedLease: LeaseRecord = { ...lease, open: false };
          await client.query(
            `UPDATE ${this.quotedSchema}.leases
                SET open = false, record = $2::jsonb
              WHERE lease_id = $1 AND open = true`,
            [lease.leaseId, JSON.stringify(closedLease)],
          );
          const attemptResult = await client.query<RevisionedRecordRow>(
            `SELECT candidate_revision AS revision, record
               FROM ${this.quotedSchema}.attempts
              WHERE job_id = $1 AND collection_cycle = $2
              FOR UPDATE`,
            [lease.jobId, lease.collectionCycle],
          );
          const attemptRow = attemptResult.rows[0];
          if (attemptRow !== undefined) {
            const attempt = decodeStoredRecord<JobCycleAttemptSnapshot>(
              attemptRow.record,
              validAttemptSnapshot,
              "attempts.record",
            );
            const nextAttempt: JobCycleAttemptSnapshot = {
              ...attempt,
              openLeaseIds: attempt.openLeaseIds.filter((id) => id !== lease.leaseId),
            };
            const nextRevision = decodePositiveRevision(
              attemptRow.revision,
              "attempts.candidate_revision",
            ) + 1;
            await client.query(
              `UPDATE ${this.quotedSchema}.attempts
                  SET candidate_revision = $3, record = $4::jsonb
                WHERE job_id = $1 AND collection_cycle = $2`,
              [lease.jobId, lease.collectionCycle, nextRevision, JSON.stringify(nextAttempt)],
            );
          }
          requeuedOpenLeases.push({
            leaseId: lease.leaseId,
            classId: lease.classId,
            jobId: lease.jobId,
            collectionCycle: lease.collectionCycle,
            contractVersion: lease.contractVersion,
            permitEpoch: lease.permitEpoch,
          });
        }
      }

      const nextWorker: WorkerRecord = { ...worker, state: captured.to };
      const nextRouting: WorkerRoutingSnapshot = {
        ...routing,
        revision: routing.revision + 1,
        openLeaseIds: closesLeases ? [] : [...routing.openLeaseIds],
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.workers
            SET state = $2, record = $3::jsonb
          WHERE worker_id = $1`,
        [captured.workerId, captured.to, JSON.stringify(nextWorker)],
      );
      await client.query(
        `UPDATE ${this.quotedSchema}.worker_routing
            SET revision = $2, record = $3::jsonb
          WHERE worker_id = $1`,
        [captured.workerId, nextRouting.revision, JSON.stringify(nextRouting)],
      );
      const outcome: WorkerStateTransitionOutcome = {
        kind: "applied",
        worker: nextWorker,
        requeuedOpenLeases,
      };
      await this.writeReplay(
        client,
        "transition_worker_state",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async registerClassVersion(
    registration: Parameters<Store["registerClassVersion"]>[0],
  ): ReturnType<Store["registerClassVersion"]> {
    const snapshot = snapshotCommandInput(registration);
    return this.inCreationOrder(() => this.transact(snapshot, async (client, captured) => {
      const existingResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
        [captured.classId, captured.contractVersion],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const existing = decodeClassVersion(existingRow);
        return existing.payloadSchemaHash === captured.payloadSchemaHash &&
            existing.outputSchemaHash === captured.outputSchemaHash &&
            existing.registeredAt === captured.registeredAt
          ? { kind: "replayed", record: existing } as const
          : { kind: "conflict", existing } as const;
      }
      const record: ClassVersionRecord = { ...captured, state: "draft" };
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.class_versions
           (class_id, contract_version, state, registered_at, record)
         VALUES ($1, $2, 'draft', $3::timestamptz, $4::jsonb)
         ON CONFLICT (class_id, contract_version) DO NOTHING`,
        [
          record.classId,
          record.contractVersion,
          record.registeredAt,
          JSON.stringify(record),
        ],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      return { kind: "registered", record } as RegisterClassVersionOutcome;
    }));
  }

  async getClassVersion(
    classId: Parameters<Store["getClassVersion"]>[0],
    contractVersion: Parameters<Store["getClassVersion"]>[1],
  ): ReturnType<Store["getClassVersion"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2`,
        [classId, contractVersion],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeClassVersion(row);
    });
  }

  async listClassVersions(
    classId: Parameters<Store["listClassVersions"]>[0],
  ): ReturnType<Store["listClassVersions"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions WHERE class_id = $1`,
        [classId],
      );
      return result.rows.map((row) => decodeClassVersion(row)).sort((left, right) =>
        compareWireIds(left.contractVersion, right.contractVersion)
      );
    });
  }

  private async publishReserveHealth(
    client: QueryableClient,
    classId: string,
    current: ClassHealthSnapshot,
    at: string,
  ): Promise<ClassHealthSnapshot> {
    const versionsResult = await client.query<RecordRow>(
      `SELECT record FROM ${this.quotedSchema}.class_versions
        WHERE class_id = $1 ORDER BY contract_version COLLATE "C" FOR UPDATE`,
      [classId],
    );
    const liveVersions = new Set(
      versionsResult.rows.map((row) => decodeClassVersion(row))
        .filter((record) => record.state !== "retired")
        .map((record) => record.contractVersion),
    );
    const policiesResult = await client.query<RecordRow>(
      `SELECT record FROM ${this.quotedSchema}.reserve_policies
        WHERE class_id = $1
        ORDER BY contract_version COLLATE "C", lane COLLATE "C" FOR UPDATE`,
      [classId],
    );
    const reserves = {
      lowCost: "available",
      urgent: "available",
      splitAndAdjudication: "available",
      audit: "available",
    } as const satisfies ClassHealthSnapshot["health"]["reserves"];
    const mutableReserves: Record<keyof typeof reserves, "available" | "saturated"> = {
      ...reserves,
    };
    for (const row of policiesResult.rows) {
      const decoded = decodeStoredJson(row.record);
      if (!isObject(decoded) || !isObject(decoded.policy) ||
          !isString(decoded.policy.contractVersion) ||
          !isString(decoded.policy.lane) ||
          !["lowCost", "urgent", "splitAndAdjudication", "audit"].includes(decoded.policy.lane) ||
          !isNonNegativeSafeInteger(decoded.policy.laneLimit) ||
          !isNonNegativeSafeInteger(decoded.used)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "reserve_policies.record has an unknown or invalid shape",
        );
      }
      if (liveVersions.has(decoded.policy.contractVersion) &&
          decoded.used >= decoded.policy.laneLimit) {
        mutableReserves[decoded.policy.lane as keyof typeof mutableReserves] = "saturated";
      }
    }
    const next: ClassHealthSnapshot = {
      revision: current.revision + 1,
      classId,
      health: { ...current.health, reserves: mutableReserves },
      updatedAt: at,
      source: "automatic",
      ...(current.adjudicationUnsafeSince === undefined
        ? {}
        : { adjudicationUnsafeSince: current.adjudicationUnsafeSince }),
    };
    await client.query(
      `UPDATE ${this.quotedSchema}.class_health
          SET revision = $2, operating = $3, updated_at = $4::timestamptz,
              adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
        WHERE class_id = $1`,
      [
        classId,
        next.revision,
        next.health.operating,
        next.updatedAt,
        next.adjudicationUnsafeSince ?? null,
        JSON.stringify(next),
      ],
    );
    return next;
  }

  async transitionClassVersion(
    input: Parameters<Store["transitionClassVersion"]>[0],
  ): ReturnType<Store["transitionClassVersion"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<ContractTransitionOutcome>(
        client,
        "transition_class_version",
        fingerprint,
        fingerprint,
        validOutcome("applied"),
      );
      if (replayed !== null && replayed.kind === "applied") {
        return { ...replayed, kind: "replayed" } as ContractTransitionOutcome;
      }
      const result = captured.to === "retired"
        ? await client.query<RecordRow>(
            `SELECT record FROM ${this.quotedSchema}.class_versions
              WHERE class_id = $1
              ORDER BY contract_version COLLATE "C" FOR UPDATE`,
            [captured.classId],
          )
        : await client.query<RecordRow>(
            `SELECT record FROM ${this.quotedSchema}.class_versions
              WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
            [captured.classId, captured.contractVersion],
          );
      const row = captured.to === "retired"
        ? result.rows.find((candidate) =>
            decodeClassVersion(candidate).contractVersion === captured.contractVersion
          )
        : result.rows[0];
      if (row === undefined) return { kind: "not_found" } as const;
      const current = decodeClassVersion(row);
      if (current.state !== captured.from) {
        return { kind: "state_conflict", actual: current.state } as const;
      }
      let currentHealth: ClassHealthSnapshot | undefined;
      if (captured.to === "retired") {
        const healthResult = await client.query<RevisionedRecordRow>(
          `SELECT revision, record FROM ${this.quotedSchema}.class_health
            WHERE class_id = $1 FOR UPDATE`,
          [captured.classId],
        );
        const healthRow = healthResult.rows[0];
        if (healthRow === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `class ${captured.classId} has no health snapshot`,
          );
        }
        currentHealth = decodeHealth(healthRow);
      }
      const record: ClassVersionRecord = {
        ...current,
        state: captured.to,
        ...(captured.leaseDisabledAt === undefined
          ? {}
          : { leaseDisabledAt: captured.leaseDisabledAt }),
        ...(captured.acceptedUntil === undefined
          ? {}
          : { acceptedUntil: captured.acceptedUntil }),
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.class_versions
            SET state = $3, lease_disabled_at = $4::timestamptz,
                accepted_until = $5::timestamptz, record = $6::jsonb
          WHERE class_id = $1 AND contract_version = $2`,
        [
          captured.classId,
          captured.contractVersion,
          record.state,
          record.leaseDisabledAt ?? null,
          record.acceptedUntil ?? null,
          JSON.stringify(record),
        ],
      );
      const classHealth = captured.to === "retired"
        ? await this.publishReserveHealth(
            client,
            captured.classId,
            currentHealth!,
            captured.at,
          )
        : undefined;
      const outcome = captured.to === "retired"
        ? { kind: "applied", record: { ...record, state: "retired" }, classHealth } as const
        : { kind: "applied", record } as const;
      await this.writeReplay(
        client,
        "transition_class_version",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome as ContractTransitionOutcome;
    });
  }

  async getCurrentPermitEpoch(
    classId: Parameters<Store["getCurrentPermitEpoch"]>[0],
  ): ReturnType<Store["getCurrentPermitEpoch"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{ permit_epoch: unknown }>(
        `SELECT permit_epoch FROM ${this.quotedSchema}.permit_epochs WHERE class_id = $1`,
        [classId],
      );
      const value = result.rows[0]?.permit_epoch;
      if (value === undefined) return null;
      if (!isString(value)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "permit_epochs.permit_epoch must be a string",
        );
      }
      return value;
    });
  }

  async transitionPermitEpoch(
    input: Parameters<Store["transitionPermitEpoch"]>[0],
  ): ReturnType<Store["transitionPermitEpoch"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<PermitEpochTransitionOutcome>(
        client,
        "transition_permit_epoch",
        fingerprint,
        fingerprint,
        validOutcome("applied"),
      );
      if (replayed !== null && replayed.kind === "applied") {
        return { ...replayed, kind: "replayed" };
      }
      const result = await client.query<{ permit_epoch: unknown }>(
        `SELECT permit_epoch FROM ${this.quotedSchema}.permit_epochs
          WHERE class_id = $1 FOR UPDATE`,
        [captured.classId],
      );
      const currentValue = result.rows[0]?.permit_epoch;
      if (currentValue !== undefined && !isString(currentValue)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "permit_epochs.permit_epoch must be a string",
        );
      }
      const current = currentValue ?? null;
      if (current !== captured.fromEpoch) {
        return { kind: "conflict", currentEpoch: current } as const;
      }
      const record = {
        classId: captured.classId,
        permitEpoch: captured.toEpoch,
        updatedAt: captured.at,
      };
      if (current === null) {
        const inserted = await client.query(
          `INSERT INTO ${this.quotedSchema}.permit_epochs
             (class_id, permit_epoch, updated_at, record)
           VALUES ($1, $2, $3::timestamptz, $4::jsonb)
           ON CONFLICT (class_id) DO NOTHING`,
          [captured.classId, captured.toEpoch, captured.at, JSON.stringify(record)],
        );
        if (inserted.rowCount !== 1) restartSerializableTransaction();
      } else {
        await client.query(
          `UPDATE ${this.quotedSchema}.permit_epochs
              SET permit_epoch = $2, updated_at = $3::timestamptz, record = $4::jsonb
            WHERE class_id = $1`,
          [captured.classId, captured.toEpoch, captured.at, JSON.stringify(record)],
        );
      }
      const outcome: PermitEpochTransitionOutcome = {
        kind: "applied",
        currentEpoch: captured.toEpoch,
      };
      await this.writeReplay(
        client,
        "transition_permit_epoch",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async getWorkerRoutingSnapshot(
    workerId: Parameters<Store["getWorkerRoutingSnapshot"]>[0],
  ): ReturnType<Store["getWorkerRoutingSnapshot"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.worker_routing
          WHERE worker_id = $1`,
        [workerId],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeRouting(row);
    });
  }

  async transitionWorkerRouting(
    input: Parameters<Store["transitionWorkerRouting"]>[0],
  ): ReturnType<Store["transitionWorkerRouting"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<WorkerRoutingTransitionOutcome>(
        client,
        "transition_worker_routing",
        fingerprint,
        fingerprint,
        validOutcome("applied"),
      );
      if (replayed !== null && replayed.kind === "applied") {
        return { ...replayed, kind: "replayed" };
      }
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.worker_routing
          WHERE worker_id = $1 FOR UPDATE`,
        [captured.expected.workerId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `worker ${captured.expected.workerId} has no routing snapshot`,
        );
      }
      const current = decodeRouting(row);
      if (!equal(current, captured.expected)) {
        return { kind: "conflict", current } as const;
      }
      const next: WorkerRoutingSnapshot = {
        revision: current.revision + 1,
        workerId: current.workerId,
        contributionWindowId: captured.next.contributionWindowId,
        contributionUsed: captured.next.contributionUsed,
        assignedSlotOccurrence: captured.next.assignedSlotOccurrence,
        openLeaseIds: [...current.openLeaseIds],
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.worker_routing
            SET revision = $2, contribution_window_id = $3,
                contribution_used = $4, assigned_slot_occurrence = $5,
                record = $6::jsonb
          WHERE worker_id = $1`,
        [
          current.workerId,
          next.revision,
          next.contributionWindowId,
          next.contributionUsed,
          next.assignedSlotOccurrence,
          JSON.stringify(next),
        ],
      );
      const outcome: WorkerRoutingTransitionOutcome = { kind: "applied", current: next };
      await this.writeReplay(
        client,
        "transition_worker_routing",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async getQueueMode(): ReturnType<Store["getQueueMode"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.queue_state
          WHERE singleton = true`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "queue_state singleton has not been bootstrapped",
        );
      }
      return decodeQueue(row);
    });
  }

  async transitionQueueMode(
    input: Parameters<Store["transitionQueueMode"]>[0],
  ): ReturnType<Store["transitionQueueMode"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<
        OperationalTransitionOutcome<QueueModeSnapshot>
      >(
        client,
        "transition_queue_mode",
        fingerprint,
        fingerprint,
        validOutcome("applied"),
      );
      if (replayed !== null && replayed.kind === "applied") {
        return { ...replayed, kind: "replayed" };
      }
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.queue_state
          WHERE singleton = true FOR UPDATE`,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "queue_state singleton has not been bootstrapped",
        );
      }
      const current = decodeQueue(row);
      if (!equal(current, captured.expected)) {
        return { kind: "conflict", current } as const;
      }
      const next: QueueModeSnapshot = {
        revision: current.revision + 1,
        mode: captured.next.mode,
        cause: captured.next.cause,
        updatedAt: captured.next.updatedAt,
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.queue_state
            SET revision = $1, mode = $2, cause = $3,
                updated_at = $4::timestamptz, record = $5::jsonb
          WHERE singleton = true`,
        [next.revision, next.mode, next.cause, next.updatedAt, JSON.stringify(next)],
      );
      const outcome: OperationalTransitionOutcome<QueueModeSnapshot> = {
        kind: "applied",
        current: next,
      };
      await this.writeReplay(
        client,
        "transition_queue_mode",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async initializeClassHealth(
    input: Parameters<Store["initializeClassHealth"]>[0],
  ): ReturnType<Store["initializeClassHealth"]> {
    const snapshot = snapshotCommandInput(input);
    return this.inCreationOrder(() => this.transact(snapshot, async (client, captured) => {
      const classId = captured.initial.classId;
      const fingerprint = commandFingerprint(captured.initial);
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1 FOR UPDATE`,
        [classId],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        const current = decodeHealth(row);
        const replayResult = await client.query<ReplayRow>(
          `SELECT fingerprint, outcome
             FROM ${this.quotedSchema}.command_replays
            WHERE command_kind = 'initialize_class_health' AND command_key = $1`,
          [classId],
        );
        const replay = replayResult.rows[0];
        if (replay === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `class ${classId} is missing its health initialization receipt`,
          );
        }
        return replay.fingerprint === fingerprint
          ? { kind: "replayed", current } as const
          : { kind: "conflict", current } as const;
      }
      const current: ClassHealthSnapshot = {
        revision: 1,
        ...structuredClone(captured.initial),
      };
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.class_health
           (class_id, revision, operating, updated_at,
            adjudication_unsafe_since, record)
         VALUES ($1, 1, $2, $3::timestamptz, $4::timestamptz, $5::jsonb)
         ON CONFLICT (class_id) DO NOTHING`,
        [
          classId,
          current.health.operating,
          current.updatedAt,
          current.adjudicationUnsafeSince ?? null,
          JSON.stringify(current),
        ],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      const outcome: InitializeClassHealthOutcome = { kind: "initialized", current };
      await this.writeReplay(
        client,
        "initialize_class_health",
        classId,
        fingerprint,
        outcome,
      );
      return outcome;
    }));
  }

  async getClassHealth(
    classId: Parameters<Store["getClassHealth"]>[0],
  ): ReturnType<Store["getClassHealth"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1`,
        [classId],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeHealth(row);
    });
  }

  async listClassHealth(): ReturnType<Store["listClassHealth"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health`,
      );
      return result.rows.map((row) => decodeHealth(row)).sort((left, right) =>
        compareWireIds(left.classId, right.classId)
      );
    });
  }

  async transitionClassHealth(
    input: Parameters<Store["transitionClassHealth"]>[0],
  ): ReturnType<Store["transitionClassHealth"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<
        OperationalTransitionOutcome<ClassHealthSnapshot>
      >(
        client,
        "transition_class_health",
        fingerprint,
        fingerprint,
        validOutcome("applied"),
      );
      if (replayed !== null && replayed.kind === "applied") {
        return { ...replayed, kind: "replayed" };
      }
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1 FOR UPDATE`,
        [captured.expected.classId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `class ${captured.expected.classId} has no health snapshot`,
        );
      }
      const current = decodeHealth(row);
      if (!equal(current, captured.expected)) {
        return { kind: "conflict", current } as const;
      }
      const next: ClassHealthSnapshot = {
        revision: current.revision + 1,
        classId: current.classId,
        health: { ...captured.next.health, reserves: { ...current.health.reserves } },
        updatedAt: captured.next.updatedAt,
        source: captured.next.source,
        ...(current.adjudicationUnsafeSince === undefined
          ? {}
          : { adjudicationUnsafeSince: current.adjudicationUnsafeSince }),
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.class_health
            SET revision = $2, operating = $3, updated_at = $4::timestamptz,
                adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
          WHERE class_id = $1`,
        [
          current.classId,
          next.revision,
          next.health.operating,
          next.updatedAt,
          next.adjudicationUnsafeSince ?? null,
          JSON.stringify(next),
        ],
      );
      const outcome: OperationalTransitionOutcome<ClassHealthSnapshot> = {
        kind: "applied",
        current: next,
      };
      await this.writeReplay(
        client,
        "transition_class_health",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async enqueueJob(
    input: Parameters<Store["enqueueJob"]>[0],
  ): ReturnType<Store["enqueueJob"]> {
    const snapshot = snapshotCommandInput(input);
    return this.inCreationOrder(() => this.transact(snapshot, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const historyResult = await client.query<ReplayRow>(
        `SELECT fingerprint, outcome
           FROM ${this.quotedSchema}.command_replays
          WHERE command_kind = 'enqueue_job' AND command_key = $1
          FOR UPDATE`,
        [captured.job.jobId],
      );
      const history = historyResult.rows[0];
      if (history !== undefined) {
        const prior = decodeStoredRecord<EnqueueOutcome>(
          history.outcome,
          validOutcome("enqueued"),
          "enqueue_job.outcome",
        );
        if (prior.kind !== "enqueued") {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            "enqueue_job receipt must contain the original enqueued outcome",
          );
        }
        return history.fingerprint === fingerprint
          ? { kind: "replayed" } as const
          : { kind: "conflict" } as const;
      }

      const existingJobResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.jobs
          WHERE job_id = $1 FOR UPDATE`,
        [captured.job.jobId],
      );
      if (existingJobResult.rows[0] !== undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `job ${captured.job.jobId} is missing its enqueue receipt`,
        );
      }

      const queueResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.queue_state
          WHERE singleton = true FOR UPDATE`,
      );
      const healthResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1 FOR UPDATE`,
        [captured.job.classId],
      );
      const queueRow = queueResult.rows[0];
      const healthRow = healthResult.rows[0];
      if (queueRow === undefined || healthRow === undefined) {
        return { kind: "conflict" } as const;
      }
      const queue = decodeQueue(queueRow);
      const health = decodeHealth(healthRow);
      const currentOperational = {
        queueRevision: queue.revision,
        classHealthRevision: health.revision,
      };
      if (!equal(currentOperational, captured.expectedOperationalState)) {
        return {
          kind: "operational_state_conflict",
          current: currentOperational,
        } as const;
      }
      if (
        queue.mode === "admission_halted" || queue.mode === "emergency_halted" ||
        health.health.operating !== "ready" ||
        health.health.reserves.urgent === "saturated" ||
        health.health.reserves.splitAndAdjudication === "saturated" ||
        health.health.reserves.audit === "saturated"
      ) {
        return {
          kind: "refused",
          queue: queue.mode,
          health: health.health,
        } as const;
      }

      const classResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
        [captured.job.classId, captured.job.contractVersion],
      );
      const epochResult = await client.query<{ readonly permit_epoch: unknown }>(
        `SELECT permit_epoch FROM ${this.quotedSchema}.permit_epochs
          WHERE class_id = $1 FOR UPDATE`,
        [captured.job.classId],
      );
      const classRow = classResult.rows[0];
      const epoch = epochResult.rows[0]?.permit_epoch;
      if (classRow === undefined || !isString(epoch) ||
          decodeClassVersion(classRow).state !== "active" ||
          epoch !== captured.job.permitEpoch) {
        return { kind: "conflict" } as const;
      }

      const identityResult = await client.query(
        `SELECT identity_id FROM ${this.quotedSchema}.core_identities
          WHERE identity_id = $1 FOR UPDATE`,
        [captured.job.payloadRef],
      );
      if (identityResult.rows[0] !== undefined) return { kind: "conflict" } as const;
      const payloadResult = await client.query<PayloadRow>(
        `SELECT input_hash, body FROM ${this.quotedSchema}.payloads
          WHERE payload_ref = $1 FOR UPDATE`,
        [captured.job.payloadRef],
      );
      const payloadRow = payloadResult.rows[0];
      if (payloadRow !== undefined) {
        if (!isString(payloadRow.input_hash)) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            "payloads.input_hash must be a string",
          );
        }
        if (payloadRow.input_hash !== captured.job.inputHash ||
            !equal(decodeStoredJson(payloadRow.body), captured.payload)) {
          return { kind: "conflict" } as const;
        }
      }

      if (payloadRow === undefined) {
        const insertedPayload = await client.query(
          `INSERT INTO ${this.quotedSchema}.payloads
             (payload_ref, input_hash, body)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (payload_ref) DO NOTHING`,
          [
            captured.job.payloadRef,
            captured.job.inputHash,
            JSON.stringify(captured.payload),
          ],
        );
        if (insertedPayload.rowCount !== 1) restartSerializableTransaction();
      }
      const insertedJob = await client.query(
        `INSERT INTO ${this.quotedSchema}.jobs
           (job_id, class_id, contract_version, payload_ref, input_hash,
            collection_cycle, lane, priority_value, enqueued_at, sequence, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11::jsonb)
         ON CONFLICT (job_id) DO NOTHING`,
        [
          captured.job.jobId,
          captured.job.classId,
          captured.job.contractVersion,
          captured.job.payloadRef,
          captured.job.inputHash,
          captured.job.collectionCycle,
          captured.job.queuePriority.lane,
          captured.job.queuePriority.value,
          captured.job.queuePriority.enqueuedAt,
          captured.job.queuePriority.sequence,
          JSON.stringify(captured.job),
        ],
      );
      if (insertedJob.rowCount !== 1) restartSerializableTransaction();
      await client.query(
        `INSERT INTO ${this.quotedSchema}.job_cycles
           (job_id, collection_cycle, permit_epoch, input_hash,
            cycle_started_at, result_state, record)
         VALUES ($1, $2, $3, $4, $5::timestamptz, 'collecting', $6::jsonb)`,
        [
          captured.job.jobId,
          captured.job.collectionCycle,
          captured.job.permitEpoch,
          captured.job.inputHash,
          captured.job.cycleStartedAt,
          JSON.stringify(captured.job),
        ],
      );
      const attempts: JobCycleAttemptSnapshot = {
        attemptCount: 0,
        openLeaseIds: [],
        acceptedWorkerIds: [],
        acceptedDiversity: [],
        splitObserved: false,
      };
      await client.query(
        `INSERT INTO ${this.quotedSchema}.attempts
           (job_id, collection_cycle, candidate_revision,
            attempt_count, split_observed, record)
         VALUES ($1, $2, 1, 0, false, $3::jsonb)`,
        [captured.job.jobId, captured.job.collectionCycle, JSON.stringify(attempts)],
      );
      const outcome: EnqueueOutcome = { kind: "enqueued" };
      await this.writeReplay(
        client,
        "enqueue_job",
        captured.job.jobId,
        fingerprint,
        outcome,
      );
      return outcome;
    }));
  }

  async getJob(
    jobId: Parameters<Store["getJob"]>[0],
  ): ReturnType<Store["getJob"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.jobs WHERE job_id = $1`,
        [jobId],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeJob(row);
    });
  }

  async getPayload(
    payloadRef: Parameters<Store["getPayload"]>[0],
  ): ReturnType<Store["getPayload"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{ readonly body: unknown }>(
        `SELECT body FROM ${this.quotedSchema}.payloads WHERE payload_ref = $1`,
        [payloadRef],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : decodeStoredJson(row.body) as Awaited<ReturnType<Store["getPayload"]>>;
    });
  }

  async listLeaseCandidates(
    input: Parameters<Store["listLeaseCandidates"]>[0],
  ): ReturnType<Store["listLeaseCandidates"]> {
    const captured = snapshotCommandInput(input);
    if (captured.classIds.length === 0) return [];
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<CandidateRow>(
        `SELECT j.record AS job_record, jc.record AS cycle_record,
                a.record AS attempt_record, a.candidate_revision,
                jc.result_state, q.revision AS queue_revision,
                h.revision AS health_revision
           FROM ${this.quotedSchema}.jobs j
           JOIN ${this.quotedSchema}.job_cycles jc
             ON jc.job_id = j.job_id AND jc.collection_cycle = j.collection_cycle
           JOIN ${this.quotedSchema}.attempts a
             ON a.job_id = jc.job_id AND a.collection_cycle = jc.collection_cycle
           JOIN ${this.quotedSchema}.class_health h ON h.class_id = j.class_id
          CROSS JOIN ${this.quotedSchema}.queue_state q
          WHERE j.class_id = ANY($1::text[]) AND jc.result_state = 'collecting'
          ORDER BY j.job_id COLLATE "C"`,
        [captured.classIds],
      );
      return result.rows.map(decodeCandidate);
    });
  }

  async compareAndClaimLease(
    input: Parameters<Store["compareAndClaimLease"]>[0],
  ): ReturnType<Store["compareAndClaimLease"]> {
    return this.transact(input, async (client, captured) => {
      const fingerprint = commandFingerprint(captured);
      const replayed = await this.readReplay<ClaimLeaseOutcome>(
        client,
        "compare_and_claim_lease",
        fingerprint,
        fingerprint,
        validClaimOutcome,
      );
      if (replayed !== null) return replayed;

      const identityResult = await client.query(
        `SELECT identity_id FROM ${this.quotedSchema}.core_identities
          WHERE identity_id = $1 FOR UPDATE`,
        [captured.preparedLease.leaseId],
      );
      if (identityResult.rows[0] !== undefined) {
        return { kind: "conflict", reason: "identity_collision" } as const;
      }
      const existingLeaseResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.preparedLease.leaseId],
      );
      if (existingLeaseResult.rows[0] !== undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `lease ${captured.preparedLease.leaseId} is missing its core identity`,
        );
      }
      if (captured.preparedLease.assignment.kind === "ordinary") {
        const leasePayloadCollision = await client.query(
          `SELECT payload_ref FROM ${this.quotedSchema}.payloads
            WHERE payload_ref = $1 FOR UPDATE`,
          [captured.preparedLease.leaseId],
        );
        if (leasePayloadCollision.rows[0] !== undefined) {
          return { kind: "conflict", reason: "identity_collision" } as const;
        }
      }

      const currentCandidate = await this.loadCandidate(
        client,
        captured.expectedCandidate.job.jobId,
        true,
      );
      if (currentCandidate === null ||
          currentCandidate.revision !== captured.expectedCandidate.revision ||
          !equal(currentCandidate.job, captured.expectedCandidate.job) ||
          !equal(currentCandidate.attempts, captured.expectedCandidate.attempts)) {
        return { kind: "conflict", reason: "candidate_stale" } as const;
      }

      const workerResult = await client.query<{
        readonly worker_record: unknown;
        readonly revision: string;
        readonly routing_record: unknown;
      }>(
        `SELECT w.record AS worker_record, r.revision,
                r.record AS routing_record
           FROM ${this.quotedSchema}.workers w
           JOIN ${this.quotedSchema}.worker_routing r ON r.worker_id = w.worker_id
          WHERE w.worker_id = $1
          FOR UPDATE OF w, r`,
        [captured.expectedWorker.workerId],
      );
      const workerRow = workerResult.rows[0];
      if (workerRow === undefined) {
        return { kind: "conflict", reason: "worker_snapshot_stale" } as const;
      }
      const worker = decodeWorker({ record: workerRow.worker_record });
      const currentWorker = decodeRouting({
        revision: workerRow.revision,
        record: workerRow.routing_record,
      });
      if (!equal(currentWorker, captured.expectedWorker)) {
        return { kind: "conflict", reason: "worker_snapshot_stale" } as const;
      }
      if (!equal(currentCandidate.operational, captured.expectedCandidate.operational)) {
        return { kind: "conflict", reason: "operational_state_stale" } as const;
      }

      const queueResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.queue_state
          WHERE singleton = true`,
      );
      const healthResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1`,
        [currentCandidate.job.classId],
      );
      const classResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
        [currentCandidate.job.classId, currentCandidate.job.contractVersion],
      );
      const queueRow = queueResult.rows[0];
      const healthRow = healthResult.rows[0];
      const classRow = classResult.rows[0];
      if (queueRow === undefined || healthRow === undefined || classRow === undefined) {
        return { kind: "conflict", reason: "unclaimable" } as const;
      }
      const queue = decodeQueue(queueRow);
      const health = decodeHealth(healthRow);
      const classVersion = decodeClassVersion(classRow);
      if (queue.mode === "admission_halted" || queue.mode === "emergency_halted" ||
          health.health.operating === "admission_halted" ||
          health.health.operating === "emergency_halted" ||
          classVersion.state !== "active" || worker.state !== "active" ||
          currentWorker.contributionUsed >= worker.declaredCapPerWeek) {
        return { kind: "conflict", reason: "unclaimable" } as const;
      }

      const storedPayloadResult = await client.query<PayloadRow>(
        `SELECT input_hash, body FROM ${this.quotedSchema}.payloads
          WHERE payload_ref = $1 FOR UPDATE`,
        [currentCandidate.job.payloadRef],
      );
      const storedPayload = storedPayloadResult.rows[0];
      if (storedPayload !== undefined && !isString(storedPayload.input_hash)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "payloads.input_hash must be a string",
        );
      }
      const lease = captured.preparedLease;
      const expectedAttempt = currentCandidate.attempts.attemptCount + 1;
      const payloadBindingMatches = lease.assignment.kind === "ordinary"
        ? lease.payloadRef === currentCandidate.job.payloadRef &&
          lease.inputHash === currentCandidate.job.inputHash &&
          storedPayload !== undefined &&
          storedPayload.input_hash === currentCandidate.job.inputHash &&
          equal(decodeStoredJson(storedPayload.body), captured.preparedPayload)
        : lease.payloadRef === lease.leaseId &&
          lease.payloadRef !== currentCandidate.job.payloadRef;
      if (lease.assignment.kind === "canary") {
        const canaryPayload = await client.query(
          `SELECT payload_ref FROM ${this.quotedSchema}.payloads
            WHERE payload_ref = $1 FOR UPDATE`,
          [lease.payloadRef],
        );
        if (canaryPayload.rows[0] !== undefined) {
          return { kind: "conflict", reason: "unclaimable" } as const;
        }
      }
      const preparedMatches = lease.open &&
        lease.jobId === currentCandidate.job.jobId &&
        lease.collectionCycle === currentCandidate.job.collectionCycle &&
        lease.classId === currentCandidate.job.classId &&
        lease.holder === currentWorker.workerId &&
        lease.contractVersion === currentCandidate.job.contractVersion &&
        lease.policyVersion === currentCandidate.job.policyVersion &&
        lease.permitEpoch === currentCandidate.job.permitEpoch &&
        lease.routing.candidateRevision === currentCandidate.revision &&
        lease.routing.workerRevision === currentWorker.revision &&
        equal(lease.routing.operational, currentCandidate.operational) &&
        lease.routing.contributionWindowId === currentWorker.contributionWindowId &&
        lease.routing.contributionOrdinal === currentWorker.contributionUsed + 1 &&
        lease.routing.assignedSlotOccurrence === currentWorker.assignedSlotOccurrence &&
        lease.routing.attemptNumber === expectedAttempt &&
        equal(lease.routing.queuePriority, currentCandidate.job.queuePriority) &&
        payloadBindingMatches;
      if (!preparedMatches || currentCandidate.attempts.openLeaseIds.length > 0 ||
          currentCandidate.attempts.acceptedWorkerIds.includes(currentWorker.workerId)) {
        return { kind: "conflict", reason: "unclaimable" } as const;
      }

      if (lease.assignment.kind === "canary") {
        const insertedPayload = await client.query(
          `INSERT INTO ${this.quotedSchema}.payloads
             (payload_ref, input_hash, body)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (payload_ref) DO NOTHING`,
          [lease.payloadRef, lease.inputHash, JSON.stringify(captured.preparedPayload)],
        );
        if (insertedPayload.rowCount !== 1) restartSerializableTransaction();
      }
      const insertedIdentity = await client.query(
        `INSERT INTO ${this.quotedSchema}.core_identities
           (identity_id, identity_kind) VALUES ($1, 'lease')
         ON CONFLICT (identity_id) DO NOTHING`,
        [lease.leaseId],
      );
      if (insertedIdentity.rowCount !== 1) restartSerializableTransaction();
      const insertedLease = await client.query(
        `INSERT INTO ${this.quotedSchema}.leases
           (lease_id, job_id, collection_cycle, class_id, contract_version,
            permit_epoch, holder, payload_ref, open, issued_at, expires_at,
            absolute_in_flight_deadline, record)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true,
                 $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::jsonb)
         ON CONFLICT (lease_id) DO NOTHING`,
        [
          lease.leaseId,
          lease.jobId,
          lease.collectionCycle,
          lease.classId,
          lease.contractVersion,
          lease.permitEpoch,
          lease.holder,
          lease.payloadRef,
          lease.issuedAt,
          lease.expiresAt,
          lease.absoluteInFlightDeadline,
          JSON.stringify(lease),
        ],
      );
      if (insertedLease.rowCount !== 1) restartSerializableTransaction();

      const nextAttempts: JobCycleAttemptSnapshot = {
        ...currentCandidate.attempts,
        attemptCount: expectedAttempt,
        openLeaseIds: [lease.leaseId],
      };
      const attemptUpdate = await client.query(
        `UPDATE ${this.quotedSchema}.attempts
            SET candidate_revision = $3, attempt_count = $4,
                split_observed = $5, record = $6::jsonb
          WHERE job_id = $1 AND collection_cycle = $2
            AND candidate_revision = $7`,
        [
          lease.jobId,
          lease.collectionCycle,
          currentCandidate.revision + 1,
          nextAttempts.attemptCount,
          nextAttempts.splitObserved,
          JSON.stringify(nextAttempts),
          currentCandidate.revision,
        ],
      );
      if (attemptUpdate.rowCount !== 1) restartSerializableTransaction();
      const nextRouting: WorkerRoutingSnapshot = {
        ...currentWorker,
        revision: currentWorker.revision + 1,
        contributionUsed: currentWorker.contributionUsed + 1,
        openLeaseIds: [...currentWorker.openLeaseIds, lease.leaseId],
      };
      const routingUpdate = await client.query(
        `UPDATE ${this.quotedSchema}.worker_routing
            SET revision = $2, contribution_used = $3, record = $4::jsonb
          WHERE worker_id = $1 AND revision = $5`,
        [
          currentWorker.workerId,
          nextRouting.revision,
          nextRouting.contributionUsed,
          JSON.stringify(nextRouting),
          currentWorker.revision,
        ],
      );
      if (routingUpdate.rowCount !== 1) restartSerializableTransaction();
      const outcome: ClaimLeaseOutcome = {
        kind: "claimed",
        lease: structuredClone(lease),
        job: structuredClone(currentCandidate.job),
      };
      await this.writeReplay(
        client,
        "compare_and_claim_lease",
        fingerprint,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async recordNoWorkAttempt(
    input: Parameters<Store["recordNoWorkAttempt"]>[0],
  ): ReturnType<Store["recordNoWorkAttempt"]> {
    return this.transact(input, async (client, captured) => {
      const result = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.worker_routing
          WHERE worker_id = $1 FOR UPDATE`,
        [captured.expectedWorker.workerId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `worker ${captured.expectedWorker.workerId} has no routing snapshot`,
        );
      }
      const current = decodeRouting(row);
      if (!equal(current, captured.expectedWorker)) {
        return { kind: "conflict", current } as const;
      }
      const next: WorkerRoutingSnapshot = {
        ...current,
        revision: current.revision + 1,
        contributionUsed: current.contributionUsed + 1,
        openLeaseIds: [...current.openLeaseIds],
      };
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.worker_routing
            SET revision = $2, contribution_used = $3, record = $4::jsonb
          WHERE worker_id = $1 AND revision = $5`,
        [
          current.workerId,
          next.revision,
          next.contributionUsed,
          JSON.stringify(next),
          current.revision,
        ],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
      const outcome: NoWorkAttemptOutcome = { kind: "recorded", current: next };
      return outcome;
    });
  }

  async getLease(
    leaseId: Parameters<Store["getLease"]>[0],
  ): ReturnType<Store["getLease"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases WHERE lease_id = $1`,
        [leaseId],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeLease(row);
    });
  }

  async extendLease(
    input: Parameters<Store["extendLease"]>[0],
  ): ReturnType<Store["extendLease"]> {
    return this.transact(input, async (client, captured) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "refused" } as const;
      const lease = decodeLease(row);
      if (!lease.open || lease.holder !== captured.workerId ||
          lease.expiresAt !== captured.expectedExpiry ||
          lease.extensionsUsed !== captured.expectedExtensionsUsed ||
          !Number.isFinite(lease.extensionPolicy.extensionTtl) ||
          lease.extensionPolicy.extensionTtl <= 0 ||
          !Number.isSafeInteger(lease.extensionPolicy.maxExtensionsPerLease) ||
          lease.extensionPolicy.maxExtensionsPerLease < 0 ||
          captured.newExtensionsUsed !== lease.extensionsUsed + 1 ||
          captured.newExtensionsUsed > lease.extensionPolicy.maxExtensionsPerLease) {
        return { kind: "refused" } as const;
      }
      const expectedNewExpiry = Date.parse(lease.expiresAt) +
        lease.extensionPolicy.extensionTtl * 1_000;
      if (!Number.isFinite(expectedNewExpiry) ||
          !Number.isFinite(Date.parse(lease.absoluteInFlightDeadline)) ||
          !Number.isFinite(Date.parse(captured.newExpiry)) ||
          Date.parse(captured.newExpiry) !== expectedNewExpiry ||
          Date.parse(captured.newExpiry) >= Date.parse(lease.absoluteInFlightDeadline)) {
        return { kind: "refused" } as const;
      }
      const next: LeaseRecord = {
        ...lease,
        expiresAt: captured.newExpiry,
        extensionsUsed: captured.newExtensionsUsed,
      };
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.leases
            SET expires_at = $2::timestamptz, record = $3::jsonb
          WHERE lease_id = $1 AND open = true`,
        [captured.leaseId, next.expiresAt, JSON.stringify(next)],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
      return { kind: "extended", newExpiry: next.expiresAt } as const;
    });
  }

  async abandonLease(
    input: Parameters<Store["abandonLease"]>[0],
  ): ReturnType<Store["abandonLease"]> {
    return this.transact(input, async (client, captured) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "refused" } as const;
      const lease = decodeLease(row);
      if (!lease.open || lease.holder !== captured.workerId ||
          lease.permitEpoch !== captured.requeue.sameCyclePermitEpoch) {
        return { kind: "refused" } as const;
      }
      await this.closeLeaseAttempt(
        client,
        lease,
        captured.classification !== "provider_or_platform_failure",
      );
      return { kind: "recorded" } as const;
    });
  }

  async expireAndRequeue(
    leaseId: Parameters<Store["expireAndRequeue"]>[0],
    under: Parameters<Store["expireAndRequeue"]>[1],
  ): ReturnType<Store["expireAndRequeue"]> {
    return this.transact({ leaseId, under }, async (client, captured) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      const row = result.rows[0];
      if (row === undefined) return;
      const lease = decodeLease(row);
      if (!lease.open || lease.permitEpoch !== captured.under.sameCyclePermitEpoch) return;
      await this.closeLeaseAttempt(client, lease, true);
    });
  }
  async acceptOrReplaySubmission(
    input: Parameters<Store["acceptOrReplaySubmission"]>[0],
  ): ReturnType<Store["acceptOrReplaySubmission"]> {
    return this.transact(input, async (client, captured) => {
      const leaseResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      const leaseRow = leaseResult.rows[0];
      if (leaseRow === undefined) {
        return { kind: "refused", error: "lease_not_held" } as const;
      }
      const lease = decodeLease(leaseRow);
      if (lease.holder !== captured.workerId) {
        return { kind: "refused", error: "lease_not_held" } as const;
      }

      const acceptedResult = await client.query<AcceptedSubmissionRow>(
        `SELECT receipt, body FROM ${this.quotedSchema}.accepted_submissions
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      const acceptedRow = acceptedResult.rows[0];
      if (acceptedRow !== undefined) {
        const receipt = decodeSubmissionReceipt(acceptedRow.receipt);
        return receipt.inputHash === captured.inputHash &&
            receipt.resultHash === captured.resultHash
          ? { kind: "replayed", receipt } as const
          : { kind: "conflict" } as const;
      }
      if (!lease.open) {
        return { kind: "refused", error: "lease_not_held" } as const;
      }

      const receipt = captured.receipt;
      const receiptMatches = receipt.leaseId === lease.leaseId &&
        receipt.jobId === lease.jobId &&
        receipt.collectionCycle === lease.collectionCycle &&
        receipt.inputHash === captured.inputHash &&
        receipt.resultHash === captured.resultHash &&
        receipt.contractVersion === lease.contractVersion &&
        receipt.permitEpoch === lease.permitEpoch &&
        receipt.outcome === "accepted";
      if (!receiptMatches || captured.inputHash !== lease.inputHash) {
        return { kind: "conflict" } as const;
      }
      const acceptedAt = Date.parse(receipt.acceptedAt);
      if (!Number.isFinite(acceptedAt) || acceptedAt < Date.parse(lease.issuedAt)) {
        return { kind: "conflict" } as const;
      }
      if (acceptedAt >= Date.parse(lease.expiresAt) ||
          acceptedAt >= Date.parse(lease.absoluteInFlightDeadline)) {
        await this.closeLeaseAttempt(client, lease, true);
        return { kind: "refused", error: "lease_not_held" } as const;
      }

      const classResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
        [lease.classId, lease.contractVersion],
      );
      const classRow = classResult.rows[0];
      const contract = classRow === undefined ? null : decodeClassVersion(classRow);
      const contractAccepts = contract?.state === "active" ||
        (contract?.state === "draining" && contract.acceptedUntil !== undefined &&
          acceptedAt <= Date.parse(contract.acceptedUntil));
      if (!contractAccepts) {
        await this.closeLeaseAttempt(client, lease, false);
        return { kind: "refused", error: "contract_expired" } as const;
      }

      const cycleResult = await client.query<{ readonly result_state: unknown }>(
        `SELECT result_state FROM ${this.quotedSchema}.job_cycles
          WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
        [lease.jobId, lease.collectionCycle],
      );
      if (cycleResult.rows[0]?.result_state !== "collecting") {
        return { kind: "refused", error: "lease_not_held" } as const;
      }
      const evidence = captured.reputationEvidence;
      if (evidence !== undefined &&
          (evidence.workerId !== lease.holder || evidence.job === undefined ||
            evidence.job.jobId !== lease.jobId ||
            evidence.job.collectionCycle !== lease.collectionCycle)) {
        return { kind: "evidence_conflict" } as const;
      }
      if (await this.reputationEvidenceConflicts(client, evidence)) {
        return { kind: "evidence_conflict" } as const;
      }

      await this.closeLeaseAttempt(client, lease, false);
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.accepted_submissions
           (lease_id, job_id, collection_cycle, worker_id, result_hash,
            accepted_at, receipt, body)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb)
         ON CONFLICT (lease_id) DO NOTHING`,
        [
          lease.leaseId,
          lease.jobId,
          lease.collectionCycle,
          lease.holder,
          captured.resultHash,
          receipt.acceptedAt,
          JSON.stringify(receipt),
          JSON.stringify(captured.body),
        ],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();

      if (lease.assignment.kind === "ordinary") {
        const attemptResult = await client.query<{
          readonly candidate_revision: string;
          readonly attempt_record: unknown;
        }>(
          `SELECT candidate_revision, record AS attempt_record
             FROM ${this.quotedSchema}.attempts
            WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
          [lease.jobId, lease.collectionCycle],
        );
        const attemptRow = attemptResult.rows[0];
        if (attemptRow === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `accepted lease ${lease.leaseId} has no attempt snapshot`,
          );
        }
        const { revision, attempts } = decodeAttempt(attemptRow);
        const workerResult = await client.query<RecordRow>(
          `SELECT record FROM ${this.quotedSchema}.workers
            WHERE worker_id = $1 FOR SHARE`,
          [lease.holder],
        );
        const workerRow = workerResult.rows[0];
        if (workerRow === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `accepted lease ${lease.leaseId} has no worker`,
          );
        }
        const worker = decodeWorker(workerRow);
        const nextAttempts: JobCycleAttemptSnapshot = {
          ...attempts,
          acceptedWorkerIds: [...attempts.acceptedWorkerIds, lease.holder],
          acceptedDiversity: [
            ...attempts.acceptedDiversity,
            {
              workerId: lease.holder,
              axes: {
                slot: String(worker.slot),
                provider: worker.capabilities.providerSurface,
                accountCluster: worker.accountCluster,
                language: [...worker.capabilities.languages].sort().join(","),
              },
            },
          ],
        };
        const updated = await client.query(
          `UPDATE ${this.quotedSchema}.attempts
              SET record = $4::jsonb
            WHERE job_id = $1 AND collection_cycle = $2
              AND candidate_revision = $3`,
          [lease.jobId, lease.collectionCycle, revision, JSON.stringify(nextAttempts)],
        );
        if (updated.rowCount !== 1) restartSerializableTransaction();
      }
      await this.persistReputationEvidence(client, evidence);
      return { kind: "accepted", receipt: structuredClone(receipt) } as const;
    });
  }

  async rejectSubmission(
    input: Parameters<Store["rejectSubmission"]>[0],
  ): ReturnType<Store["rejectSubmission"]> {
    return this.transact(input, async (client, captured) => {
      const leaseResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      const leaseRow = leaseResult.rows[0];
      if (leaseRow === undefined) {
        return { kind: "refused", error: "lease_not_held" } as const;
      }
      const lease = decodeLease(leaseRow);
      if (lease.holder !== captured.workerId) {
        return { kind: "refused", error: "lease_not_held" } as const;
      }
      const accepted = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.accepted_submissions
          WHERE lease_id = $1 FOR UPDATE`,
        [captured.leaseId],
      );
      if (accepted.rows[0] !== undefined) return { kind: "conflict" } as const;

      const fingerprint = commandFingerprint(captured);
      const replayResult = await client.query<ReplayRow>(
        `SELECT fingerprint, outcome FROM ${this.quotedSchema}.command_replays
          WHERE command_kind = 'reject_submission' AND command_key = $1`,
        [captured.leaseId],
      );
      const replay = replayResult.rows[0];
      if (replay !== undefined) {
        return replay.fingerprint === fingerprint
          ? { kind: "replayed" } as const
          : { kind: "conflict" } as const;
      }
      if (!lease.open) {
        return { kind: "refused", error: "lease_not_held" } as const;
      }
      const evidence = captured.reputationEvidence;
      if (evidence !== undefined &&
          (evidence.workerId !== lease.holder || evidence.job === undefined ||
            evidence.job.jobId !== lease.jobId ||
            evidence.job.collectionCycle !== lease.collectionCycle)) {
        return { kind: "evidence_conflict" } as const;
      }
      if (await this.reputationEvidenceConflicts(client, evidence)) {
        return { kind: "evidence_conflict" } as const;
      }
      await this.closeLeaseAttempt(
        client,
        lease,
        captured.classification !== "coordinator_fault",
      );
      await this.persistReputationEvidence(client, evidence);
      await this.writeReplay(
        client,
        "reject_submission",
        captured.leaseId,
        fingerprint,
        { kind: "recorded" },
      );
      return { kind: "recorded" } as const;
    });
  }

  async getAcceptedSubmission(
    leaseId: Parameters<Store["getAcceptedSubmission"]>[0],
  ): ReturnType<Store["getAcceptedSubmission"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<AcceptedSubmissionRow>(
        `SELECT receipt, body FROM ${this.quotedSchema}.accepted_submissions
          WHERE lease_id = $1`,
        [leaseId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        receipt: decodeSubmissionReceipt(row.receipt),
        body: decodeStoredJson(row.body),
      };
    });
  }

  async listAcceptedReplicas(
    jobId: Parameters<Store["listAcceptedReplicas"]>[0],
    collectionCycle: Parameters<Store["listAcceptedReplicas"]>[1],
  ): ReturnType<Store["listAcceptedReplicas"]> {
    return withPoolClient(this.#pool, (client) =>
      this.loadAcceptedReplicas(client, jobId, collectionCycle));
  }

  async getResultState(
    jobId: Parameters<Store["getResultState"]>[0],
    collectionCycle: Parameters<Store["getResultState"]>[1],
  ): ReturnType<Store["getResultState"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{ readonly result_state: unknown }>(
        `SELECT result_state FROM ${this.quotedSchema}.job_cycles
          WHERE job_id = $1 AND collection_cycle = $2`,
        [jobId, collectionCycle],
      );
      const value = result.rows[0]?.result_state;
      if (value === undefined) return null;
      if (!isString(value) || !resultStates.has(value)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      return value as ResultState;
    });
  }

  async markResultSplit(
    input: Parameters<Store["markResultSplit"]>[0],
  ): ReturnType<Store["markResultSplit"]> {
    const canonicalInput = {
      ...input,
      evidence: [...input.evidence].sort((left, right) =>
        compareWireIds(left.leaseId, right.leaseId)),
    };
    return this.transact(canonicalInput, async (client, captured) => {
      const cycleResult = await client.query<ResultCycleRow>(
        `SELECT jc.result_state, jc.record AS cycle_record,
                a.candidate_revision, a.record AS attempt_record
           FROM ${this.quotedSchema}.job_cycles jc
           JOIN ${this.quotedSchema}.attempts a
             ON a.job_id = jc.job_id AND a.collection_cycle = jc.collection_cycle
          WHERE jc.job_id = $1 AND jc.collection_cycle = $2
          FOR UPDATE OF jc, a`,
        [captured.jobId, captured.collectionCycle],
      );
      const row = cycleResult.rows[0];
      const actual = row?.result_state;
      if (actual !== undefined && (!isString(actual) || !resultStates.has(actual))) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      if (row === undefined) {
        return { kind: "conflict", actual: null } as const;
      }
      const job = decodeJob({ record: row.cycle_record }, "job_cycles.record");
      const { revision, attempts } = decodeAttempt(row);
      const typedActual = actual as ResultState;
      if (typedActual !== "collecting" || job.inputHash !== captured.inputHash) {
        return { kind: "conflict", actual: typedActual } as const;
      }
      const fingerprint = commandFingerprint(captured);
      if (attempts.splitObserved) {
        const replay = await client.query<ReplayRow>(
          `SELECT fingerprint, outcome FROM ${this.quotedSchema}.command_replays
            WHERE command_kind = 'mark_result_split' AND command_key = $1`,
          [`${captured.jobId}:${captured.collectionCycle}`],
        );
        return replay.rows[0]?.fingerprint === fingerprint
          ? { kind: "replayed" } as const
          : { kind: "conflict", actual: typedActual } as const;
      }
      const evidence = (await this.loadAcceptedReplicas(
        client,
        captured.jobId,
        captured.collectionCycle,
      )).map((replica) => replica.evidence);
      if (captured.evidence.length < 2 || !equal(evidence, captured.evidence)) {
        return { kind: "conflict", actual: typedActual } as const;
      }
      const nextAttempts: JobCycleAttemptSnapshot = {
        ...attempts,
        splitObserved: true,
      };
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.attempts
            SET candidate_revision = $3, split_observed = true, record = $4::jsonb
          WHERE job_id = $1 AND collection_cycle = $2
            AND candidate_revision = $5`,
        [
          captured.jobId,
          captured.collectionCycle,
          revision + 1,
          JSON.stringify(nextAttempts),
          revision,
        ],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
      await this.writeReplay(
        client,
        "mark_result_split",
        `${captured.jobId}:${captured.collectionCycle}`,
        fingerprint,
        { kind: "recorded" },
      );
      return { kind: "recorded" } as const;
    });
  }

  async transitionResult(
    input: Parameters<Store["transitionResult"]>[0],
  ): ReturnType<Store["transitionResult"]> {
    return this.transact(input, async (client, captured) => {
      const cycleResult = await client.query<ResultCycleRow>(
        `SELECT jc.result_state, jc.record AS cycle_record,
                a.candidate_revision, a.record AS attempt_record
           FROM ${this.quotedSchema}.job_cycles jc
           JOIN ${this.quotedSchema}.attempts a
             ON a.job_id = jc.job_id AND a.collection_cycle = jc.collection_cycle
          WHERE jc.job_id = $1 AND jc.collection_cycle = $2
          FOR UPDATE OF jc, a`,
        [captured.jobId, captured.collectionCycle],
      );
      const row = cycleResult.rows[0];
      if (row === undefined) return { ok: false, actual: captured.from } as const;
      if (!isString(row.result_state) || !resultStates.has(row.result_state)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      const actual = row.result_state as ResultState;
      if (actual !== captured.from) return { ok: false, actual } as const;
      const jobCycle = decodeJob({ record: row.cycle_record }, "job_cycles.record");
      let next: JobRecord | undefined;
      if (captured.startNewCycle !== undefined) {
        if (captured.startNewCycle.permitEpoch.length === 0 ||
            captured.startNewCycle.inputHash.length === 0) {
          return { ok: false, actual } as const;
        }
        const nextCycle = captured.collectionCycle + 1;
        const collision = await client.query(
          `SELECT 1 FROM ${this.quotedSchema}.job_cycles
            WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
          [captured.jobId, nextCycle],
        );
        if (collision.rows[0] !== undefined) return { ok: false, actual } as const;
        next = {
          ...jobCycle,
          collectionCycle: nextCycle,
          permitEpoch: captured.startNewCycle.permitEpoch,
          inputHash: captured.startNewCycle.inputHash,
          cycleStartedAt: captured.startNewCycle.cycleStartedAt,
        };
      }
      const leasesResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE job_id = $1 AND collection_cycle = $2 AND open = true
          ORDER BY lease_id COLLATE "C" FOR UPDATE`,
        [captured.jobId, captured.collectionCycle],
      );
      for (const leaseRow of leasesResult.rows) {
        await this.closeLeaseAttempt(client, decodeLease(leaseRow), true);
      }
      await client.query(
        `UPDATE ${this.quotedSchema}.job_cycles
            SET result_state = $3
          WHERE job_id = $1 AND collection_cycle = $2`,
        [captured.jobId, captured.collectionCycle, captured.to],
      );
      if (next !== undefined) {
        const currentJob = await client.query<RecordRow>(
          `SELECT record FROM ${this.quotedSchema}.jobs
            WHERE job_id = $1 FOR UPDATE`,
          [captured.jobId],
        );
        if (currentJob.rows[0] === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `job ${captured.jobId} has no current projection`,
          );
        }
        await client.query(
          `UPDATE ${this.quotedSchema}.jobs
              SET input_hash = $2, collection_cycle = $3, record = $4::jsonb
            WHERE job_id = $1`,
          [next.jobId, next.inputHash, next.collectionCycle, JSON.stringify(next)],
        );
        await client.query(
          `INSERT INTO ${this.quotedSchema}.job_cycles
             (job_id, collection_cycle, permit_epoch, input_hash,
              cycle_started_at, result_state, record)
           VALUES ($1, $2, $3, $4, $5::timestamptz, 'collecting', $6::jsonb)`,
          [
            next.jobId,
            next.collectionCycle,
            next.permitEpoch,
            next.inputHash,
            next.cycleStartedAt,
            JSON.stringify(next),
          ],
        );
        const attempts: JobCycleAttemptSnapshot = {
          attemptCount: 0,
          openLeaseIds: [],
          acceptedWorkerIds: [],
          acceptedDiversity: [],
          splitObserved: false,
        };
        await client.query(
          `INSERT INTO ${this.quotedSchema}.attempts
             (job_id, collection_cycle, candidate_revision,
              attempt_count, split_observed, record)
           VALUES ($1, $2, 1, 0, false, $3::jsonb)`,
          [next.jobId, next.collectionCycle, JSON.stringify(attempts)],
        );
      }
      return { ok: true } as const;
    });
  }

  async recordDecisionResult(
    input: Parameters<Store["recordDecisionResult"]>[0],
  ): ReturnType<Store["recordDecisionResult"]> {
    return this.transact(input, async (client, captured) => {
      const existingResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.decisions
          WHERE decision_result_hash = $1 FOR UPDATE`,
        [captured.decision.decisionResultHash],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const existing = decodeDecisionResult(existingRow.record);
        if (equal(existing, captured.decision)) return { ok: true } as const;
        const stateResult = await client.query<{ readonly result_state: unknown }>(
          `SELECT result_state FROM ${this.quotedSchema}.job_cycles
            WHERE job_id = $1 AND collection_cycle = $2`,
          [captured.decision.jobId, captured.decision.collectionCycle],
        );
        const state = stateResult.rows[0]?.result_state;
        if (state !== undefined && (!isString(state) || !resultStates.has(state))) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            "job_cycles.result_state has an unknown value",
          );
        }
        return {
          ok: false,
          actual: (state as ResultState | undefined) ?? "collecting",
        } as const;
      }
      const cycleResult = await client.query<ResultCycleRow>(
        `SELECT jc.result_state, jc.record AS cycle_record,
                a.candidate_revision, a.record AS attempt_record
           FROM ${this.quotedSchema}.job_cycles jc
           JOIN ${this.quotedSchema}.attempts a
             ON a.job_id = jc.job_id AND a.collection_cycle = jc.collection_cycle
          WHERE jc.job_id = $1 AND jc.collection_cycle = $2
          FOR UPDATE OF jc, a`,
        [captured.decision.jobId, captured.decision.collectionCycle],
      );
      const row = cycleResult.rows[0];
      const actualValue = row?.result_state;
      if (actualValue !== undefined &&
          (!isString(actualValue) || !resultStates.has(actualValue))) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      const actual = (actualValue as ResultState | undefined) ?? null;
      if (row === undefined) {
        return { ok: false, actual: captured.transition.from } as const;
      }
      const job = decodeJob({ record: row.cycle_record }, "job_cycles.record");
      const { attempts } = decodeAttempt(row);
      const evidence = (await this.loadAcceptedReplicas(
        client,
        captured.decision.jobId,
        captured.decision.collectionCycle,
      )).map((replica) => replica.evidence);
      const expectedEvidence = [...captured.decision.evidence].sort((left, right) =>
        compareWireIds(left.leaseId, right.leaseId));
      if (actual !== captured.transition.from || attempts.splitObserved ||
          attempts.openLeaseIds.length > 0 ||
          captured.decision.inputHash !== job.inputHash ||
          captured.decision.contractVersion !== job.contractVersion ||
          captured.decision.permitEpoch !== job.permitEpoch ||
          !equal(evidence, expectedEvidence)) {
        return {
          ok: false,
          actual: actual ?? captured.transition.from,
        } as const;
      }
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.decisions
           (decision_result_hash, job_id, collection_cycle, verified_at, record)
         VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
         ON CONFLICT (decision_result_hash) DO NOTHING`,
        [
          captured.decision.decisionResultHash,
          captured.decision.jobId,
          captured.decision.collectionCycle,
          captured.decision.verifiedAt,
          JSON.stringify(captured.decision),
        ],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      await client.query(
        `UPDATE ${this.quotedSchema}.job_cycles
            SET result_state = 'verified'
          WHERE job_id = $1 AND collection_cycle = $2`,
        [captured.decision.jobId, captured.decision.collectionCycle],
      );
      return { ok: true } as const;
    });
  }

  async getDecisionResult(
    decisionResultHash: Parameters<Store["getDecisionResult"]>[0],
  ): ReturnType<Store["getDecisionResult"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.decisions
          WHERE decision_result_hash = $1`,
        [decisionResultHash],
      );
      const row = result.rows[0];
      return row === undefined ? null : decodeDecisionResult(row.record);
    });
  }

  async inspectAuthorizationContext(
    decisionResultHash: Parameters<Store["inspectAuthorizationContext"]>[0],
  ): ReturnType<Store["inspectAuthorizationContext"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{
        readonly decision_record: unknown;
        readonly cycle_record: unknown;
        readonly current_job_record: unknown;
        readonly result_state: unknown;
        readonly class_record: unknown;
      }>(
        `SELECT d.record AS decision_record, jc.record AS cycle_record,
                j.record AS current_job_record, jc.result_state,
                cv.record AS class_record
           FROM ${this.quotedSchema}.decisions d
           JOIN ${this.quotedSchema}.job_cycles jc
             ON jc.job_id = d.job_id AND jc.collection_cycle = d.collection_cycle
           JOIN ${this.quotedSchema}.jobs j ON j.job_id = d.job_id
           JOIN ${this.quotedSchema}.class_versions cv
             ON cv.class_id = (jc.record->>'classId')
            AND cv.contract_version = (d.record->>'contractVersion')
          WHERE d.decision_result_hash = $1`,
        [decisionResultHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (!isString(row.result_state) || !resultStates.has(row.result_state)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      return {
        decision: decodeDecisionResult(row.decision_record),
        jobCycle: decodeJob({ record: row.cycle_record }, "job_cycles.record"),
        currentJob: decodeJob({ record: row.current_job_record }),
        resultState: row.result_state as ResultState,
        classVersion: decodeClassVersion({ record: row.class_record }),
      };
    });
  }
  readonly authorizeOrReplayIntent = notImplemented<Store["authorizeOrReplayIntent"]>("authorizeOrReplayIntent");
  readonly getAuthorizationStatus = notImplemented<Store["getAuthorizationStatus"]>("getAuthorizationStatus");
  readonly getInitialReceipt = notImplemented<Store["getInitialReceipt"]>("getInitialReceipt");
  readonly getAuthorization = notImplemented<Store["getAuthorization"]>("getAuthorization");
  readonly inspectInvalidationScope = notImplemented<Store["inspectInvalidationScope"]>("inspectInvalidationScope");
  readonly invalidateResultScope = notImplemented<Store["invalidateResultScope"]>("invalidateResultScope");
  readonly openResultAdjudication = notImplemented<Store["openResultAdjudication"]>("openResultAdjudication");
  readonly getResultAdjudicationRequest = notImplemented<Store["getResultAdjudicationRequest"]>("getResultAdjudicationRequest");
  readonly inspectResultVerdictContext = notImplemented<Store["inspectResultVerdictContext"]>("inspectResultVerdictContext");
  readonly listPendingResultAdjudications = notImplemented<Store["listPendingResultAdjudications"]>("listPendingResultAdjudications");
  readonly applyResultAdjudicationVerdict = notImplemented<Store["applyResultAdjudicationVerdict"]>("applyResultAdjudicationVerdict");
  readonly getActionAdjudicationRequest = notImplemented<Store["getActionAdjudicationRequest"]>("getActionAdjudicationRequest");
  readonly getPendingAuthorizationContext = notImplemented<Store["getPendingAuthorizationContext"]>("getPendingAuthorizationContext");
  readonly listPendingActionAdjudications = notImplemented<Store["listPendingActionAdjudications"]>("listPendingActionAdjudications");
  readonly getVerdictHistory = notImplemented<Store["getVerdictHistory"]>("getVerdictHistory");
  readonly applyActionAdjudicationVerdict = notImplemented<Store["applyActionAdjudicationVerdict"]>("applyActionAdjudicationVerdict");
  readonly inspectAdjudicationLoad = notImplemented<Store["inspectAdjudicationLoad"]>("inspectAdjudicationLoad");
  readonly refreshClassHealth = notImplemented<Store["refreshClassHealth"]>("refreshClassHealth");
  readonly enterEmergencyHalt = notImplemented<Store["enterEmergencyHalt"]>("enterEmergencyHalt");
  readonly getReservePolicy = notImplemented<Store["getReservePolicy"]>("getReservePolicy");
  readonly initializeReservePolicy = notImplemented<Store["initializeReservePolicy"]>("initializeReservePolicy");
  readonly transitionReservePolicy = notImplemented<Store["transitionReservePolicy"]>("transitionReservePolicy");
  readonly chargeReserve = notImplemented<Store["chargeReserve"]>("chargeReserve");
  readonly appendLedger = notImplemented<Store["appendLedger"]>("appendLedger");
  readonly listLedger = notImplemented<Store["listLedger"]>("listLedger");
  readonly recordReputationEvidence = notImplemented<Store["recordReputationEvidence"]>("recordReputationEvidence");
  async listReputationEvidence(
    workerId: Parameters<Store["listReputationEvidence"]>[0],
  ): ReturnType<Store["listReputationEvidence"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.reputation_evidence
          WHERE worker_id = $1
          ORDER BY observed_at, evidence_id COLLATE "C"`,
        [workerId],
      );
      return result.rows.map((row) => decodeStoredRecord<ReputationEvidenceRecord>(
        row.record,
        validReputationEvidence,
        "reputation_evidence.record",
      ));
    });
  }
}
