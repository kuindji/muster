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

interface RecordRow {
  readonly record: unknown;
}

interface LedgerRow extends RecordRow {
  readonly recorded_at: unknown;
  readonly class_id: unknown;
  readonly kind: unknown;
  readonly privacy: unknown;
}

interface ReputationEvidenceRow extends RecordRow {
  readonly evidence_id: unknown;
  readonly worker_id: unknown;
  readonly source: unknown;
  readonly observed_at: unknown;
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
type ReservePolicyRecord = NonNullable<
  Awaited<ReturnType<Store["getReservePolicy"]>>
>;
type ReserveChargeOutcome = Awaited<ReturnType<Store["chargeReserve"]>>;
type AdjudicationLoadSnapshot = Awaited<
  ReturnType<Store["inspectAdjudicationLoad"]>
>;
type ResultVerdictContext = NonNullable<
  Awaited<ReturnType<Store["inspectResultVerdictContext"]>>
>;
type ActionAdjudicationRequest = NonNullable<
  Awaited<ReturnType<Store["getActionAdjudicationRequest"]>>
>;
type PendingAuthorizationContext = NonNullable<
  Awaited<ReturnType<Store["getPendingAuthorizationContext"]>>
>;
type VerdictHistoryRecord = NonNullable<
  Awaited<ReturnType<Store["getVerdictHistory"]>>
>;
type AuthorizationContext = NonNullable<
  Awaited<ReturnType<Store["inspectAuthorizationContext"]>>
>;
type AuthorizeIntentOutcome = Awaited<ReturnType<Store["authorizeOrReplayIntent"]>>;
type AuthorizedIntentOutcome = Extract<
  AuthorizeIntentOutcome,
  { readonly initialReceipt: unknown }
>;
type AuthorizationReserveBatch = NonNullable<
  AuthorizedIntentOutcome["reserveBatch"]
>;
type AuthorizationStatus = NonNullable<
  Awaited<ReturnType<Store["getAuthorizationStatus"]>>
>;
type ActionAuthorization = NonNullable<
  Awaited<ReturnType<Store["getAuthorization"]>>
>;
type InvalidationSnapshot = Awaited<
  ReturnType<Store["inspectInvalidationScope"]>
>;
type AppliedInvalidation = Extract<
  Awaited<ReturnType<Store["invalidateResultScope"]>>,
  { kind: "applied" }
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
const ledgerEntryKeys = new Set([
  "at", "kind", "outcome", "privacy", "classId", "job", "workerId",
  "providerSurface", "contractVersion", "correlationId", "hashes", "body",
  "descriptors",
]);
const reputationEvidenceKeys = new Set([
  "evidenceId", "workerId", "at", "job", "detailHash", "source", "impact",
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

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCanonicalJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return hasWellFormedUtf16(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) ||
            !isCanonicalJsonValue(value[index], seen)) return false;
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.entries(value).every(([key, entry]) =>
      hasWellFormedUtf16(key) && entry !== undefined &&
      isCanonicalJsonValue(entry, seen)
    );
  } finally {
    seen.delete(value);
  }
}

function validLedgerEntry(record: unknown): boolean {
  if (!isObject(record) ||
      !Object.keys(record).every((key) => ledgerEntryKeys.has(key)) ||
      !isString(record.at) || !Number.isFinite(Date.parse(record.at)) ||
      !isString(record.kind) || record.kind.length === 0 ||
      !isString(record.outcome) || record.outcome.length === 0 ||
      !isString(record.privacy) ||
      !["public", "internal", "sensitive"].includes(record.privacy) ||
      !isObject(record.hashes) ||
      !Object.values(record.hashes).every((hash) =>
        isString(hash) && hash.length > 0
      )) {
    return false;
  }
  for (const key of [
    "classId", "workerId", "providerSurface", "contractVersion", "correlationId",
  ]) {
    const value = record[key];
    if (value !== undefined && (!isString(value) || value.length === 0)) return false;
  }
  if (record.job !== undefined &&
      (!isObject(record.job) ||
        Object.keys(record.job).some((key) =>
          key !== "jobId" && key !== "collectionCycle"
        ) ||
        !isString(record.job.jobId) || record.job.jobId.length === 0 ||
        !Number.isSafeInteger(record.job.collectionCycle) ||
        Number(record.job.collectionCycle) <= 0)) {
    return false;
  }
  return (record.body === undefined || isCanonicalJsonValue(record.body)) &&
    (record.descriptors === undefined ||
      isCanonicalJsonValue(record.descriptors));
}

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
  if (!Object.keys(record).every((key) => reputationEvidenceKeys.has(key)) ||
      !isString(record.evidenceId) || record.evidenceId.length === 0 ||
      !isString(record.workerId) || record.workerId.length === 0 ||
      !isString(record.at) || !isString(record.source) ||
      !evidenceSources.has(record.source) ||
      (record.detailHash !== undefined &&
        (!isString(record.detailHash) || record.detailHash.length === 0)) ||
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
      Object.keys(record.job).every((key) =>
        key === "jobId" || key === "collectionCycle"
      ) &&
      Number.isSafeInteger(record.job.collectionCycle) &&
      Number(record.job.collectionCycle) > 0);
}

function projectedTimestamp(value: unknown, description: string): number {
  if (!isString(value) || !Number.isFinite(Date.parse(value))) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      `${description} must be a valid timestamp`,
    );
  }
  return Date.parse(value);
}

function decodeLedgerRow(row: LedgerRow): Parameters<Store["appendLedger"]>[0] {
  const record = decodeStoredRecord<Parameters<Store["appendLedger"]>[0]>(
    row.record,
    validLedgerEntry,
    "ledger_entries.record",
  );
  const projectedClassId = row.class_id === null ? undefined : row.class_id;
  if (projectedTimestamp(row.recorded_at, "ledger_entries.recorded_at") !==
        Date.parse(record.at) ||
      projectedClassId !== record.classId || row.kind !== record.kind ||
      row.privacy !== record.privacy) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      "ledger entry projections do not match their record",
    );
  }
  return record;
}

function decodeReputationEvidenceRow(
  row: ReputationEvidenceRow,
): ReputationEvidenceRecord {
  const record = decodeStoredRecord<ReputationEvidenceRecord>(
    row.record,
    validReputationEvidence,
    "reputation_evidence.record",
  );
  if (row.evidence_id !== record.evidenceId || row.worker_id !== record.workerId ||
      row.source !== record.source ||
      projectedTimestamp(row.observed_at, "reputation_evidence.observed_at") !==
        Date.parse(record.at)) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      "reputation evidence projections do not match their record",
    );
  }
  return record;
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

function validReservePolicySnapshot(value: unknown): boolean {
  if (!isObject(value)) return false;
  const lane = value.lane;
  const windowStartsAt = isString(value.windowStartsAt)
    ? Date.parse(value.windowStartsAt)
    : Number.NaN;
  const windowEndsAt = isString(value.windowEndsAt)
    ? Date.parse(value.windowEndsAt)
    : Number.NaN;
  return isString(value.classId) && value.classId.length > 0 &&
    isString(value.contractVersion) && value.contractVersion.length > 0 &&
    isString(lane) &&
    ["lowCost", "urgent", "splitAndAdjudication", "audit"].includes(lane) &&
    isString(value.policyVersion) && value.policyVersion.length > 0 &&
    isString(value.windowId) && value.windowId.length > 0 &&
    Number.isFinite(windowStartsAt) && Number.isFinite(windowEndsAt) &&
    windowStartsAt < windowEndsAt &&
    isNonNegativeSafeInteger(value.laneLimit) &&
    ((lane === "lowCost" || lane === "urgent")
      ? isNonNegativeSafeInteger(value.perWorkerLimit)
      : value.perWorkerLimit === undefined);
}

function validReservePolicyRecord(record: JsonRecord): boolean {
  if (!Array.isArray(record.workerUsage)) return false;
  const workerUsage = record.workerUsage;
  return decodePositiveRevision(record.revision) >= 1 &&
    validReservePolicySnapshot(record.policy) &&
    isNonNegativeSafeInteger(record.used) &&
    workerUsage.every((entry) => isObject(entry) &&
      isString(entry.workerId) && entry.workerId.length > 0 &&
      isNonNegativeSafeInteger(entry.used)) &&
    workerUsage.every((entry, index) => index === 0 ||
      (entry as { readonly workerId: string }).workerId >
        (workerUsage[index - 1] as { readonly workerId: string }).workerId) &&
    isString(record.updatedAt) && Number.isFinite(Date.parse(record.updatedAt));
}

function decodeReservePolicy(value: unknown): ReservePolicyRecord {
  return decodeStoredRecord<ReservePolicyRecord>(
    value,
    validReservePolicyRecord,
    "reserve_policies.record",
  );
}

function validReserveCharge(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.workerIds)) return false;
  const workerIds = value.workerIds;
  return isString(value.chargeKey) && value.chargeKey.length > 0 &&
    workerIds.every((workerId) => isString(workerId) && workerId.length > 0) &&
    workerIds.every((workerId, index) =>
      index === 0 || workerId > workerIds[index - 1]!) &&
    validReservePolicySnapshot(value.policy) && isString(value.at) &&
    Number.isFinite(Date.parse(value.at));
}

function validReserveChargeRecord(value: unknown): boolean {
  return isObject(value) && validReserveCharge(value.charge) &&
    (value.outcome === "charged" || value.outcome === "exhausted");
}

function validReserveChargeOutcome(record: JsonRecord): boolean {
  if ((record.kind !== "charged" && record.kind !== "exhausted") ||
      (record.status !== "applied" && record.status !== "replayed") ||
      !validReserveChargeRecord(record.charge) ||
      !isObject(record.currentPolicy) ||
      !validReservePolicyRecord(record.currentPolicy as JsonRecord) ||
      !isObject(record.classHealth) ||
      !validHealthSnapshot(record.classHealth as JsonRecord)) return false;
  const chargeRecord = record.charge as JsonRecord;
  const charge = chargeRecord.charge as JsonRecord;
  const currentPolicy = record.currentPolicy as JsonRecord;
  const policy = currentPolicy.policy as JsonRecord;
  const classHealth = record.classHealth as JsonRecord;
  return chargeRecord.outcome === record.kind &&
    equal(charge.policy, currentPolicy.policy) &&
    classHealth.classId === policy.classId;
}

function decodeReserveChargeOutcome(
  value: unknown,
  description = "reserve_charges.record",
): Extract<ReserveChargeOutcome, { kind: "charged" | "exhausted" }> {
  return decodeStoredRecord<Extract<
    ReserveChargeOutcome,
    { kind: "charged" | "exhausted" }
  >>(value, validReserveChargeOutcome, description);
}

function validResultAdjudicationRecord(record: JsonRecord): boolean {
  if (!validResultAdjudicationRequest(record.request) ||
      !isString(record.openedAt) ||
      !isString(record.state) || !resultStates.has(record.state) ||
      !isObject(record.charge) ||
      !validReserveChargeRecord(record.charge.charge) ||
      !isObject(record.charge.currentPolicy) ||
      !validReservePolicyRecord(record.charge.currentPolicy as JsonRecord) ||
      !isObject(record.charge.classHealth) ||
      !validHealthSnapshot(record.charge.classHealth as JsonRecord)) return false;
  const charge = record.charge as JsonRecord;
  const chargeRecord = charge.charge as JsonRecord;
  const nestedCharge = chargeRecord.charge as JsonRecord;
  const currentPolicy = charge.currentPolicy as JsonRecord;
  const policy = currentPolicy.policy as JsonRecord;
  const classHealth = charge.classHealth as JsonRecord;
  return equal(
    nestedCharge.policy,
    currentPolicy.policy,
  ) && classHealth.classId === policy.classId;
}

function validActionAuthorization(record: JsonRecord): boolean {
  return isString(record.authorizationRequestId) &&
    isString(record.effectIntentId) && isString(record.effectIntentHash) &&
    isString(record.jobId) && Number.isSafeInteger(record.collectionCycle) &&
    Number(record.collectionCycle) > 0 && isString(record.inputHash) &&
    isString(record.decisionResultHash) && Array.isArray(record.evidence) &&
    record.evidence.every(validSubmissionEvidence) &&
    (record.resultAdjudicationVerdictHash === undefined ||
      isString(record.resultAdjudicationVerdictHash)) &&
    (record.actionAdjudicationVerdictHash === undefined ||
      isString(record.actionAdjudicationVerdictHash)) &&
    isString(record.contractVersion) && isString(record.permitEpoch) &&
    Array.isArray(record.actions) && record.actions.length > 0 &&
    record.actions.every(isString);
}

function validAuthorizationStatus(record: JsonRecord): boolean {
  if (!isString(record.state) || ![
    "pending_adjudication", "authorized", "denied", "expired", "superseded",
    "cancelled",
  ].includes(record.state)) return false;
  if (record.state === "authorized") {
    if (!isObject(record.validity) || !isString(record.validity.kind) ||
        !["valid", "invalid"].includes(record.validity.kind)) return false;
    return record.validity.kind === "valid" ||
      (isString(record.validity.reason) && isString(record.validity.invalidatedAt));
  }
  return record.state !== "denied" || isString(record.reason);
}

function validEffectIntent(value: unknown): boolean {
  return isObject(value) && isString(value.id) && Array.isArray(value.effects) &&
    value.effects.length > 0 && value.effects.every((effect) =>
      isObject(effect) && isString(effect.action) && isObject(effect.descriptor));
}

function validActionAdjudicationRequest(record: JsonRecord): boolean {
  return isString(record.authorizationRequestId) && isString(record.jobId) &&
    Number.isSafeInteger(record.collectionCycle) &&
    Number(record.collectionCycle) > 0 && validEffectIntent(record.effectIntent) &&
    isString(record.effectIntentHash) && isString(record.inputHash) &&
    isString(record.decisionResultHash) && Array.isArray(record.evidence) &&
    record.evidence.every(validSubmissionEvidence) &&
    (record.resultAdjudicationVerdictHash === undefined ||
      isString(record.resultAdjudicationVerdictHash)) &&
    isString(record.contractVersion) && isString(record.permitEpoch) &&
    Array.isArray(record.humanReviews) && record.humanReviews.length > 0 &&
    record.humanReviews.every((review) => isObject(review) &&
      isString(review.action) && isString(review.predicate) &&
      Array.isArray(review.requiredPayloadPaths) &&
      review.requiredPayloadPaths.every(isString) &&
      Array.isArray(review.requiredResultPaths) &&
      review.requiredResultPaths.every(isString) &&
      Array.isArray(review.requiredEffectPaths) &&
      review.requiredEffectPaths.every(isString));
}

function validInitialReceipt(record: JsonRecord): boolean {
  if (!isString(record.authorizationRequestId) ||
      !isString(record.effectIntentId) || !isString(record.effectIntentHash) ||
      !isString(record.jobId) || !Number.isSafeInteger(record.collectionCycle) ||
      Number(record.collectionCycle) < 1 || !isString(record.decisionResultHash) ||
      !isString(record.at) || !isString(record.outcome) || ![
        "authorized", "denied", "pending_adjudication",
      ].includes(record.outcome)) return false;
  if (record.outcome === "authorized") {
    return isObject(record.authorization) && validActionAuthorization(record.authorization);
  }
  return record.outcome !== "denied" || isString(record.denialReason);
}

function validAuthorizationContext(record: JsonRecord): boolean {
  return isObject(record.decision) && validDecisionResult(record.decision) &&
    isObject(record.jobCycle) && validJobRecord(record.jobCycle) &&
    isObject(record.currentJob) && validJobRecord(record.currentJob) &&
    isString(record.resultState) && resultStates.has(record.resultState) &&
    isObject(record.classVersion) && validClassVersion(record.classVersion) &&
    isString(record.maxInFlightDeadline);
}

function validVerdictHistory(record: JsonRecord): boolean {
  if ((record.kind !== "result" && record.kind !== "action") ||
      !isString(record.requestId) || !isString(record.verdictHash) ||
      !isObject(record.verdict) || !isObject(record.receipt)) return false;
  const receipt = record.receipt;
  return isString(receipt.requestId) && isString(receipt.verdictHash) &&
    isString(receipt.decidedAt) && isString(receipt.outcome) && [
      "resolved", "rejected", "approved", "denied",
    ].includes(receipt.outcome) &&
    (receipt.outcome !== "rejected" ||
      (receipt.rejectOutcome === "requeued" ||
        receipt.rejectOutcome === "cap_exhausted"));
}

function validResultAdjudicationRequest(value: unknown): boolean {
  return isObject(value) && isString(value.id) && isString(value.reason) &&
    isString(value.jobId) && Number.isSafeInteger(value.collectionCycle) &&
    Number(value.collectionCycle) > 0 && isString(value.inputHash) &&
    Array.isArray(value.candidateResultHashes) &&
    value.candidateResultHashes.every(isString) && Array.isArray(value.evidence) &&
    value.evidence.every(validSubmissionEvidence) &&
    isString(value.contractVersion) && isString(value.permitEpoch);
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

/**
 * PostgreSQL implementation of the frozen Store boundary.
 *
 * The adapter borrows a client per operation and never owns caller pool
 * shutdown. The complete Store surface persists control, lease, result, safety,
 * ledger, and reputation state without evaluating core policy.
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

  private async publishReserveHealthFromSnapshot(
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
        ? await this.publishReserveHealthFromSnapshot(
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
    return withPoolClient(this.#pool, (client) =>
      this.loadAuthorizationContext(client, decisionResultHash));
  }

  private async loadAuthorizationContext(
    client: QueryableClient,
    decisionResultHash: string,
    lock = false,
  ): Promise<AuthorizationContext | null> {
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
          WHERE d.decision_result_hash = $1${
            lock ? " FOR UPDATE OF d, jc, j, cv" : ""
          }`,
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
  }

  private async settleAuthorizationReserves(
    client: QueryableClient,
    authorizationRequestId: string,
    charges: readonly Parameters<Store["chargeReserve"]>[0][],
    context: Parameters<Store["authorizeOrReplayIntent"]>[0]["expectedContext"],
    at: string,
  ): Promise<AuthorizationReserveBatch | Exclude<
    AuthorizeIntentOutcome,
    AuthorizedIntentOutcome
  >> {
    const order = ["lowCost", "urgent", "splitAndAdjudication"] as const;
    const lanes = charges.map((charge) => charge.policy.lane);
    if (lanes.some((lane) => !order.includes(lane as typeof order[number]))) {
      return { kind: "reserve_batch_invalid", reason: "extraneous_lane" };
    }
    if (new Set(lanes).size !== lanes.length) {
      return { kind: "reserve_batch_invalid", reason: "duplicate_lane" };
    }
    const indexes = lanes.map((lane) => order.indexOf(lane as typeof order[number]));
    if (indexes.some((index, position) =>
        position > 0 && index <= indexes[position - 1]!)) {
      return { kind: "reserve_batch_invalid", reason: "lane_order" };
    }
    for (const charge of charges) {
      if (charge.chargeKey !== `${authorizationRequestId}:${charge.policy.lane}`) {
        return { kind: "reserve_batch_invalid", reason: "charge_key" };
      }
      if (charge.policy.classId !== context.jobCycle.classId ||
          charge.policy.contractVersion !== context.jobCycle.contractVersion ||
          charge.at !== at) {
        return { kind: "reserve_batch_invalid", reason: "context_mismatch" };
      }
      if (charge.workerIds.some((workerId, index) =>
          index > 0 && workerId <= charge.workerIds[index - 1]!)) {
        return { kind: "reserve_batch_invalid", reason: "worker_order" };
      }
    }

    // Preflight every lane before any mutation. Serializable row locks keep the
    // checked policies and charge identities stable through settlement.
    const preflight: Array<{
      readonly charge: typeof charges[number];
      readonly outcome: "charged" | "exhausted";
    }> = [];
    for (const charge of charges) {
      const existing = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.reserve_charges
          WHERE charge_key = $1 FOR UPDATE`,
        [charge.chargeKey],
      );
      if (existing.rows[0] !== undefined) {
        const record = decodeReserveChargeOutcome(existing.rows[0].record);
        if (!equal(record.charge.charge.policy, charge.policy) ||
            !equal(record.charge.charge.workerIds, charge.workerIds)) {
          return {
            kind: "reserve_charge_conflict",
            lane: charge.policy.lane as typeof order[number],
            existingCharge: record.charge,
          };
        }
        preflight.push({ charge, outcome: record.charge.outcome });
      } else {
        const policy = await this.loadReservePolicy(client, charge.policy, true);
        if (policy === null || !equal(policy.policy, charge.policy)) {
          return {
            kind: "reserve_policy_conflict",
            lane: charge.policy.lane as typeof order[number],
            currentPolicy: policy,
          };
        }
        const perWorkerLimit = policy.policy.perWorkerLimit;
        const perWorkerCapacity = charge.policy.lane === "lowCost" ||
            charge.policy.lane === "urgent"
          ? charge.workerIds.every((workerId) =>
              (policy.workerUsage.find((usage) =>
                usage.workerId === workerId)?.used ?? 0) < (perWorkerLimit ?? -1))
          : true;
        preflight.push({
          charge,
          outcome: policy.used < policy.policy.laneLimit && perWorkerCapacity
            ? "charged"
            : "exhausted",
        });
      }
    }

    if (charges[0] === undefined) {
      return { kind: "reserve_batch_invalid", reason: "extraneous_lane" };
    }
    const failClosed = preflight.some((entry) =>
      (entry.charge.policy.lane === "lowCost" ||
        entry.charge.policy.lane === "urgent") &&
      entry.outcome === "exhausted");
    const selected = preflight.filter((entry) =>
      !failClosed || (
        (entry.charge.policy.lane === "lowCost" ||
          entry.charge.policy.lane === "urgent") &&
        entry.outcome === "exhausted"
      ));

    const healthResult = await client.query<RevisionedRecordRow>(
      `SELECT revision, record FROM ${this.quotedSchema}.class_health
        WHERE class_id = $1 FOR UPDATE`,
      [charges[0].policy.classId],
    );
    if (healthResult.rows[0] === undefined) {
      return {
        kind: "reserve_policy_conflict",
        lane: charges[0].policy.lane as typeof order[number],
        currentPolicy: await this.loadReservePolicy(client, charges[0].policy),
      };
    }
    const startingHealth = decodeHealth(healthResult.rows[0]);
    const results: Array<{
      readonly settlement: AuthorizationReserveBatch["settlements"][number];
      readonly applied: boolean;
      readonly chargeKey: string;
    }> = [];
    let classHealth = startingHealth;
    for (const { charge } of selected) {
      await client.query(
        `UPDATE ${this.quotedSchema}.class_health
            SET revision = $2, operating = $3, updated_at = $4::timestamptz,
                adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
          WHERE class_id = $1`,
        [startingHealth.classId, startingHealth.revision,
          startingHealth.health.operating, startingHealth.updatedAt,
          startingHealth.adjudicationUnsafeSince ?? null,
          JSON.stringify(startingHealth)],
      );
      const outcome = await this.settleReserve(client, charge);
      if (outcome.kind === "reserve_charge_conflict" ||
          outcome.kind === "reserve_policy_conflict") {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "reserve batch changed after serializable preflight",
        );
      }
      if (outcome.status === "applied") classHealth = outcome.classHealth;
      results.push({
        settlement: {
          lane: charge.policy.lane as typeof order[number],
          charge: outcome.charge,
          currentPolicy: outcome.currentPolicy,
        },
        applied: outcome.status === "applied",
        chargeKey: charge.chargeKey,
      });
    }
    await client.query(
      `UPDATE ${this.quotedSchema}.class_health
          SET revision = $2, operating = $3, updated_at = $4::timestamptz,
              adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
        WHERE class_id = $1`,
      [classHealth.classId, classHealth.revision, classHealth.health.operating,
        classHealth.updatedAt, classHealth.adjudicationUnsafeSince ?? null,
        JSON.stringify(classHealth)],
    );
    for (const result of results) {
      if (!result.applied) continue;
      const stored = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.reserve_charges
          WHERE charge_key = $1 FOR UPDATE`,
        [result.chargeKey],
      );
      if (stored.rows[0] === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `reserve charge ${result.chargeKey} disappeared`,
        );
      }
      const record = decodeReserveChargeOutcome(stored.rows[0].record);
      await client.query(
        `UPDATE ${this.quotedSchema}.reserve_charges
            SET record = $2::jsonb WHERE charge_key = $1`,
        [result.chargeKey, JSON.stringify({ ...record, classHealth })],
      );
    }
    return {
      settlements: results.map((result) => result.settlement),
      skippedLanes: preflight
        .filter((entry) => !selected.includes(entry))
        .map((entry) => entry.charge.policy.lane as typeof order[number]),
      classHealth,
    };
  }

  private async loadReservePolicy(
    client: QueryableClient,
    input: Parameters<Store["getReservePolicy"]>[0],
    lock = false,
  ): Promise<ReservePolicyRecord | null> {
    const result = await client.query<RecordRow>(
      `SELECT record FROM ${this.quotedSchema}.reserve_policies
        WHERE class_id = $1 AND contract_version = $2 AND lane = $3${
          lock ? " FOR UPDATE" : ""
        }`,
      [input.classId, input.contractVersion, input.lane],
    );
    return result.rows[0] === undefined
      ? null
      : decodeReservePolicy(result.rows[0].record);
  }

  private validReservePolicy(
    policy: Parameters<Store["initializeReservePolicy"]>[0]["policy"],
  ): boolean {
    const start = Date.parse(policy.windowStartsAt);
    const end = Date.parse(policy.windowEndsAt);
    return policy.classId.length > 0 && policy.contractVersion.length > 0 &&
      policy.policyVersion.length > 0 && policy.windowId.length > 0 &&
      Number.isFinite(start) && Number.isFinite(end) && start < end &&
      Number.isSafeInteger(policy.laneLimit) && policy.laneLimit >= 0 &&
      (policy.lane === "lowCost" || policy.lane === "urgent"
        ? policy.perWorkerLimit !== undefined &&
          Number.isSafeInteger(policy.perWorkerLimit) && policy.perWorkerLimit >= 0
        : policy.perWorkerLimit === undefined);
  }

  private async publishReserveHealth(
    client: QueryableClient,
    classId: string,
    at: string,
  ): Promise<ClassHealthSnapshot> {
    const healthResult = await client.query<RevisionedRecordRow>(
      `SELECT revision, record FROM ${this.quotedSchema}.class_health
        WHERE class_id = $1 FOR UPDATE`,
      [classId],
    );
    const row = healthResult.rows[0];
    if (row === undefined) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        `class ${classId} has no health snapshot`,
      );
    }
    const current = decodeHealth(row);
    const policies = await client.query<{
      readonly record: unknown;
      readonly state: string;
    }>(
      `SELECT rp.record, cv.state
         FROM ${this.quotedSchema}.reserve_policies rp
         JOIN ${this.quotedSchema}.class_versions cv
           ON cv.class_id = rp.class_id
          AND cv.contract_version = rp.contract_version
        WHERE rp.class_id = $1
        ORDER BY rp.contract_version COLLATE "C", rp.lane COLLATE "C"
        FOR UPDATE OF rp`,
      [classId],
    );
    const reserves = {
      lowCost: "available" as "available" | "saturated",
      urgent: "available" as "available" | "saturated",
      splitAndAdjudication: "available" as "available" | "saturated",
      audit: "available" as "available" | "saturated",
    };
    for (const policyRow of policies.rows) {
      if (policyRow.state === "retired") continue;
      const record = decodeReservePolicy(policyRow.record);
      if (record.used >= record.policy.laneLimit) {
        reserves[record.policy.lane] = "saturated";
      }
    }
    const next: ClassHealthSnapshot = {
      revision: current.revision + 1,
      classId,
      health: { ...current.health, reserves },
      updatedAt: at,
      source: "automatic",
      ...(current.adjudicationUnsafeSince === undefined
        ? {}
        : { adjudicationUnsafeSince: current.adjudicationUnsafeSince }),
    };
    const updated = await client.query(
      `UPDATE ${this.quotedSchema}.class_health
          SET revision = $2, operating = $3, updated_at = $4::timestamptz,
              adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
        WHERE class_id = $1 AND revision = $7`,
      [
        classId,
        next.revision,
        next.health.operating,
        next.updatedAt,
        next.adjudicationUnsafeSince ?? null,
        JSON.stringify(next),
        current.revision,
      ],
    );
    if (updated.rowCount !== 1) restartSerializableTransaction();
    return next;
  }

  private async settleReserve(
    client: QueryableClient,
    charge: Parameters<Store["chargeReserve"]>[0],
  ): Promise<ReserveChargeOutcome> {
    const readExisting = async (): Promise<ReserveChargeOutcome | null> => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.reserve_charges
          WHERE charge_key = $1 FOR UPDATE`,
        [charge.chargeKey],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const existing = decodeReserveChargeOutcome(row.record);
      const semanticMatches = equal(existing.charge.charge.policy, charge.policy) &&
        equal(existing.charge.charge.workerIds, charge.workerIds);
      if (!semanticMatches) {
        return {
          kind: "reserve_charge_conflict",
          existingCharge: existing.charge,
        };
      }
      return { ...existing, status: "replayed" };
    };

    const early = await readExisting();
    if (early !== null) return early;
    const current = await this.loadReservePolicy(client, charge.policy, true);
    const raced = await readExisting();
    if (raced !== null) return raced;
    if (current === null || !equal(current.policy, charge.policy)) {
      return { kind: "reserve_policy_conflict", currentPolicy: current };
    }
    const perWorkerLimit = charge.policy.perWorkerLimit;
    const perWorkerCapacity = charge.policy.lane === "lowCost" ||
        charge.policy.lane === "urgent"
      ? charge.workerIds.every((workerId) =>
          (current.workerUsage.find((entry) => entry.workerId === workerId)?.used ?? 0) <
            (perWorkerLimit ?? -1))
      : true;
    const outcome = current.used < current.policy.laneLimit && perWorkerCapacity
      ? "charged" as const
      : "exhausted" as const;
    let nextPolicy = current;
    if (outcome === "charged") {
      const usage = new Map(current.workerUsage.map((entry) => [entry.workerId, entry.used]));
      if (charge.policy.lane === "lowCost" || charge.policy.lane === "urgent") {
        for (const workerId of charge.workerIds) {
          usage.set(workerId, (usage.get(workerId) ?? 0) + 1);
        }
      }
      nextPolicy = {
        revision: current.revision + 1,
        policy: structuredClone(current.policy),
        used: current.used + 1,
        workerUsage: [...usage.entries()]
          .sort(([left], [right]) => compareWireIds(left, right))
          .map(([workerId, used]) => ({ workerId, used })),
        updatedAt: charge.at,
      };
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.reserve_policies
            SET revision = $4, window_id = $5,
                window_starts_at = $6::timestamptz,
                window_ends_at = $7::timestamptz, record = $8::jsonb
          WHERE class_id = $1 AND contract_version = $2 AND lane = $3
            AND revision = $9`,
        [
          charge.policy.classId,
          charge.policy.contractVersion,
          charge.policy.lane,
          nextPolicy.revision,
          nextPolicy.policy.windowId,
          nextPolicy.policy.windowStartsAt,
          nextPolicy.policy.windowEndsAt,
          JSON.stringify(nextPolicy),
          current.revision,
        ],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
    }
    const classHealth = await this.publishReserveHealth(
      client,
      charge.policy.classId,
      charge.at,
    );
    const applied = {
      kind: outcome,
      status: "applied" as const,
      charge: { charge: structuredClone(charge), outcome },
      currentPolicy: nextPolicy,
      classHealth,
    } as Extract<ReserveChargeOutcome, { kind: typeof outcome }>;
    const inserted = await client.query(
      `INSERT INTO ${this.quotedSchema}.reserve_charges
         (charge_key, class_id, contract_version, lane, window_id,
          outcome, charged_at, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
       ON CONFLICT (charge_key) DO NOTHING`,
      [
        charge.chargeKey,
        charge.policy.classId,
        charge.policy.contractVersion,
        charge.policy.lane,
        charge.policy.windowId,
        outcome,
        charge.at,
        JSON.stringify(applied),
      ],
    );
    if (inserted.rowCount !== 1) restartSerializableTransaction();
    return applied;
  }

  private async bumpAdjudicationLoad(
    client: QueryableClient,
    classId: string,
    at: string,
  ): Promise<void> {
    const result = await client.query<{ readonly revision: string }>(
      `SELECT revision FROM ${this.quotedSchema}.adjudication_load
        WHERE class_id = $1 FOR UPDATE`,
      [classId],
    );
    const row = result.rows[0];
    const revision = row === undefined
      ? 1
      : decodePositiveRevision(row.revision, "adjudication_load.revision") + 1;
    const record: AdjudicationLoadSnapshot = {
      revision,
      classId,
      windowStartsAt: at,
      admittedDemand: 0,
    };
    if (row === undefined) {
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.adjudication_load
           (class_id, revision, window_starts_at, admitted_demand,
            oldest_pending_opened_at, record)
         VALUES ($1, $2, $3::timestamptz, 0, NULL, $4::jsonb)
         ON CONFLICT (class_id) DO NOTHING`,
        [classId, revision, at, JSON.stringify(record)],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      return;
    }
    const updated = await client.query(
      `UPDATE ${this.quotedSchema}.adjudication_load
          SET revision = $2, record = $3::jsonb
        WHERE class_id = $1 AND revision = $4`,
      [classId, revision, JSON.stringify(record), revision - 1],
    );
    if (updated.rowCount !== 1) restartSerializableTransaction();
  }

  private async loadAdjudicationLoad(
    client: QueryableClient,
    input: Parameters<Store["inspectAdjudicationLoad"]>[0],
  ): Promise<AdjudicationLoadSnapshot> {
    const revisionResult = await client.query<{ readonly revision: string }>(
      `SELECT revision FROM ${this.quotedSchema}.adjudication_load
        WHERE class_id = $1`,
      [input.classId],
    );
    const result = await client.query<{
      readonly opened_at: unknown;
      readonly pending: boolean;
    }>(
      `SELECT opened_at, (state = 'pending_result_adjudication') AS pending
         FROM ${this.quotedSchema}.result_adjudications
        WHERE class_id = $1
       UNION ALL
       SELECT aa.opened_at,
              (ast.state = 'pending_adjudication') AS pending
         FROM ${this.quotedSchema}.action_adjudications aa
         JOIN ${this.quotedSchema}.authorization_status ast
           ON ast.authorization_request_id = aa.authorization_request_id
        WHERE aa.class_id = $1`,
      [input.classId],
    );
    const opened = result.rows.map((row) => {
      const value = row.opened_at;
      const timestamp = value instanceof Date ? value.toISOString() : String(value);
      return { timestamp, pending: row.pending };
    });
    const pending = opened.filter((entry) => entry.pending)
      .map((entry) => entry.timestamp).sort(compareWireIds);
    return {
      revision: revisionResult.rows[0] === undefined
        ? 0
        : decodePositiveRevision(
            revisionResult.rows[0].revision,
            "adjudication_load.revision",
          ),
      classId: input.classId,
      windowStartsAt: input.windowStartsAt,
      admittedDemand: opened.filter((entry) =>
        entry.timestamp >= input.windowStartsAt).length,
      ...(pending[0] === undefined ? {} : { oldestPendingOpenedAt: pending[0] }),
    };
  }

  private async loadResultVerdictContext(
    client: QueryableClient,
    requestId: string,
    lock = false,
  ): Promise<ResultVerdictContext | null> {
    const result = await client.query<{
      readonly request_record: unknown;
      readonly cycle_record: unknown;
      readonly current_job_record: unknown;
      readonly result_state: unknown;
      readonly class_record: unknown;
    }>(
      `SELECT ra.record AS request_record, jc.record AS cycle_record,
              j.record AS current_job_record, jc.result_state,
              cv.record AS class_record
         FROM ${this.quotedSchema}.result_adjudications ra
         JOIN ${this.quotedSchema}.job_cycles jc
           ON jc.job_id = ra.job_id AND jc.collection_cycle = ra.collection_cycle
         JOIN ${this.quotedSchema}.jobs j ON j.job_id = ra.job_id
         JOIN ${this.quotedSchema}.class_versions cv
           ON cv.class_id = ra.class_id
          AND cv.contract_version = (ra.record->'request'->>'contractVersion')
        WHERE ra.request_id = $1${
          lock ? " FOR UPDATE OF ra, jc, j, cv" : ""
        }`,
      [requestId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (!isString(row.result_state) || !resultStates.has(row.result_state)) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        "job_cycles.result_state has an unknown value",
      );
    }
    const stored = decodeStoredRecord<{
      readonly request: ResultVerdictContext["request"];
    }>(
      row.request_record,
      (record) => validResultAdjudicationRequest(record.request),
      "result_adjudications.record",
    );
    return {
      request: stored.request,
      jobCycle: decodeJob({ record: row.cycle_record }, "job_cycles.record"),
      currentJob: decodeJob({ record: row.current_job_record }),
      resultState: row.result_state as ResultState,
      classVersion: decodeClassVersion({ record: row.class_record }),
    };
  }

  private async loadInvalidationSnapshot(
    client: QueryableClient,
    scope: Parameters<Store["inspectInvalidationScope"]>[0],
    lock = false,
  ): Promise<InvalidationSnapshot> {
    const cycles = await client.query<{
      readonly result_state: unknown;
      readonly record: unknown;
    }>(
      `SELECT result_state, record FROM ${this.quotedSchema}.job_cycles
        WHERE record->>'classId' = $1
        ORDER BY job_id COLLATE "C", collection_cycle${
          lock ? " FOR UPDATE" : ""
        }`,
      [scope.classId],
    );
    let decisionCycles = new Set<string>();
    if (scope.kind === "decision_results") {
      const decisions = await client.query<{
        readonly decision_result_hash: string;
        readonly job_id: string;
        readonly collection_cycle: string;
      }>(
        `SELECT decision_result_hash, job_id, collection_cycle
           FROM ${this.quotedSchema}.decisions
          WHERE decision_result_hash = ANY($1::text[])${
            lock ? " FOR UPDATE" : ""
          }`,
        [scope.decisionResultHashes],
      );
      decisionCycles = new Set(decisions.rows.map((row) =>
        `${row.job_id}:${row.collection_cycle}`));
    }
    const selectedCycles = scope.kind === "job_cycles"
      ? new Set(scope.jobCycles.map((entry) =>
          `${entry.jobId}:${entry.collectionCycle}`))
      : null;
    const targets: InvalidationSnapshot["targets"] = [];
    for (const row of cycles.rows) {
      if (!isString(row.result_state) || !resultStates.has(row.result_state)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      const job = decodeJob({ record: row.record }, "job_cycles.record");
      const key = `${job.jobId}:${job.collectionCycle}`;
      const matches = scope.kind === "class" ||
        (scope.kind === "job_cycles" && selectedCycles!.has(key)) ||
        (scope.kind === "permit_epoch" && job.permitEpoch === scope.permitEpoch) ||
        (scope.kind === "contract_version" &&
          job.contractVersion === scope.contractVersion) ||
        (scope.kind === "decision_results" && decisionCycles.has(key));
      if (!matches) continue;
      targets.push({
        jobId: job.jobId,
        collectionCycle: job.collectionCycle,
        state: row.result_state as ResultState,
        inputHash: job.inputHash,
        permitEpoch: job.permitEpoch,
        contractVersion: job.contractVersion,
      });
    }
    return { scope: structuredClone(scope), targets };
  }

  private async applyInvalidation(
    client: QueryableClient,
    snapshot: InvalidationSnapshot,
    reason: Parameters<Store["invalidateResultScope"]>[0]["reason"],
    requeuePlans: Parameters<Store["invalidateResultScope"]>[0]["requeuePlans"],
    at: string,
    epochTransition?: {
      readonly classId: string;
      readonly fromEpoch: string | null;
      readonly toEpoch: string;
    },
  ): Promise<AppliedInvalidation> {
    const resultTarget = {
      emergency_halted: "cancelled",
      operator_cancelled: "cancelled",
      emergency_permit_withdrawal: "superseded",
      contract_expired: "expired",
      max_in_flight_exceeded: "expired",
    } as const;
    const to = resultTarget[reason];
    const targetKeys = new Set(snapshot.targets.map((target) =>
      `${target.jobId}:${target.collectionCycle}`));
    const nextKeys = new Set<string>();
    for (const plan of requeuePlans) {
      const oldKey = `${plan.jobId}:${plan.fromCollectionCycle}`;
      const nextKey = `${plan.jobId}:${plan.newCollectionCycle}`;
      if (!targetKeys.has(oldKey) ||
          plan.newCollectionCycle !== plan.fromCollectionCycle + 1 ||
          nextKeys.has(nextKey)) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `invalid requeue plan for ${oldKey}`,
        );
      }
      const collision = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.job_cycles
          WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
        [plan.jobId, plan.newCollectionCycle],
      );
      if (collision.rows[0] !== undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `duplicate requeue target ${nextKey}`,
        );
      }
      nextKeys.add(nextKey);
    }
    const resultTransitions: AppliedInvalidation["resultTransitions"] = [];
    const authorizationTransitions: AppliedInvalidation["authorizationTransitions"] = [];
    const invalidatedAuthorizations: AppliedInvalidation["invalidatedAuthorizations"] = [];
    for (const target of snapshot.targets) {
      const leases = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.leases
          WHERE job_id = $1 AND collection_cycle = $2 AND open = true
          ORDER BY lease_id COLLATE "C" FOR UPDATE`,
        [target.jobId, target.collectionCycle],
      );
      for (const row of leases.rows) {
        await this.closeLeaseAttempt(client, decodeLease(row), true);
      }
      await client.query(
        `UPDATE ${this.quotedSchema}.job_cycles SET result_state = $3
          WHERE job_id = $1 AND collection_cycle = $2`,
        [target.jobId, target.collectionCycle, to],
      );
      resultTransitions.push({
        jobId: target.jobId,
        collectionCycle: target.collectionCycle,
        from: target.state,
        to,
      });
      const resultRequests = await client.query<RecordRow & { readonly request_id: string }>(
        `SELECT request_id, record FROM ${this.quotedSchema}.result_adjudications
          WHERE job_id = $1 AND collection_cycle = $2
            AND state = 'pending_result_adjudication' FOR UPDATE`,
        [target.jobId, target.collectionCycle],
      );
      for (const row of resultRequests.rows) {
        const record = decodeStoredRecord<JsonRecord>(
          row.record,
          validResultAdjudicationRecord,
          "result_adjudications.record",
        );
        await client.query(
          `UPDATE ${this.quotedSchema}.result_adjudications
              SET state = $2, record = $3::jsonb WHERE request_id = $1`,
          [row.request_id, to, JSON.stringify({ ...record, state: to })],
        );
      }
      const pendingActions = await client.query<{
        readonly authorization_request_id: string;
        readonly revision: string;
      }>(
        `SELECT ast.authorization_request_id, ast.revision
           FROM ${this.quotedSchema}.authorization_status ast
           JOIN ${this.quotedSchema}.action_adjudications aa
             ON aa.authorization_request_id = ast.authorization_request_id
          WHERE (aa.request->>'jobId') = $1
            AND (aa.request->>'collectionCycle')::bigint = $2
            AND ast.state = 'pending_adjudication'
          ORDER BY ast.authorization_request_id COLLATE "C"
          FOR UPDATE OF ast`,
        [target.jobId, target.collectionCycle],
      );
      for (const row of pendingActions.rows) {
        const revision = decodePositiveRevision(row.revision);
        const status: AuthorizationStatus = { state: to };
        await client.query(
          `UPDATE ${this.quotedSchema}.authorization_status
              SET state = $2, revision = $3, record = $4::jsonb
            WHERE authorization_request_id = $1`,
          [row.authorization_request_id, to, revision + 1, JSON.stringify(status)],
        );
        authorizationTransitions.push({
          authorizationRequestId: row.authorization_request_id,
          from: "pending_adjudication",
          to,
        });
      }
      const liveAuthorizations = await client.query<{
        readonly authorization_request_id: string;
        readonly class_id: string;
        readonly revision: string;
        readonly status_record: unknown;
      }>(
        `SELECT a.authorization_request_id, a.class_id, ast.revision,
                ast.record AS status_record
           FROM ${this.quotedSchema}.authorizations a
           JOIN ${this.quotedSchema}.authorization_status ast
             ON ast.authorization_request_id = a.authorization_request_id
          WHERE a.job_id = $1 AND a.collection_cycle = $2
            AND ast.state = 'authorized'
          ORDER BY a.authorization_request_id COLLATE "C"
          FOR UPDATE OF ast`,
        [target.jobId, target.collectionCycle],
      );
      for (const row of liveAuthorizations.rows) {
        const status = decodeStoredRecord<AuthorizationStatus>(
          row.status_record,
          validAuthorizationStatus,
          "authorization_status.record",
        );
        if (status.state !== "authorized" || status.validity.kind !== "valid") continue;
        const nextStatus: AuthorizationStatus = {
          state: "authorized",
          validity: { kind: "invalid", reason, invalidatedAt: at },
        };
        const revision = decodePositiveRevision(row.revision);
        await client.query(
          `UPDATE ${this.quotedSchema}.authorization_status
              SET revision = $2, record = $3::jsonb
            WHERE authorization_request_id = $1`,
          [row.authorization_request_id, revision + 1, JSON.stringify(nextStatus)],
        );
        invalidatedAuthorizations.push({
          authorizationRequestId: row.authorization_request_id,
          classId: row.class_id,
          jobId: target.jobId,
          collectionCycle: target.collectionCycle,
          reason,
        });
      }
    }
    for (const plan of requeuePlans) {
      const old = snapshot.targets.find((target) =>
        target.jobId === plan.jobId &&
        target.collectionCycle === plan.fromCollectionCycle)!;
      const oldResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.job_cycles
          WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
        [old.jobId, old.collectionCycle],
      );
      const oldJob = decodeJob(oldResult.rows[0]!, "job_cycles.record");
      const next: JobRecord = {
        ...oldJob,
        collectionCycle: plan.newCollectionCycle,
        permitEpoch: plan.permitEpoch,
        inputHash: plan.inputHash,
        cycleStartedAt: plan.cycleStartedAt,
      };
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
        [next.jobId, next.collectionCycle, next.permitEpoch, next.inputHash,
          next.cycleStartedAt, JSON.stringify(next)],
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
    if (epochTransition !== undefined) {
      const record = {
        classId: epochTransition.classId,
        permitEpoch: epochTransition.toEpoch,
        updatedAt: at,
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.permit_epochs
            SET permit_epoch = $2, updated_at = $3::timestamptz, record = $4::jsonb
          WHERE class_id = $1`,
        [epochTransition.classId, epochTransition.toEpoch, at, JSON.stringify(record)],
      );
    }
    if (snapshot.targets.length > 0) {
      await this.bumpAdjudicationLoad(client, snapshot.scope.classId, at);
    }
    return {
      kind: "applied",
      resultTransitions,
      authorizationTransitions,
      invalidatedAuthorizations,
      newCycles: structuredClone(requeuePlans),
      ...(epochTransition === undefined ? {} : { epochTransition }),
    };
  }

  private contextEligible(
    classVersion: ClassVersionRecord,
    processedAt: string,
    maxInFlightDeadline: string,
  ): boolean {
    if (classVersion.state === "retired" || classVersion.state === "draft") {
      return false;
    }
    if (classVersion.state === "draining" &&
        (classVersion.acceptedUntil === undefined ||
          Date.parse(processedAt) > Date.parse(classVersion.acceptedUntil))) {
      return false;
    }
    return Date.parse(processedAt) < Date.parse(maxInFlightDeadline);
  }
  async authorizeOrReplayIntent(
    input: Parameters<Store["authorizeOrReplayIntent"]>[0],
  ): ReturnType<Store["authorizeOrReplayIntent"]> {
    return this.transact(input, async (client, captured) => {
      const semantic = {
        authorizationRequestId: captured.authorizationRequestId,
        effectIntent: captured.effectIntent,
        effectIntentHash: captured.effectIntentHash,
        decisionResultHash: captured.decisionResultHash,
        decision: captured.decision.kind === "deny"
          ? captured.decision
          : {
              ...captured.decision,
              ...(captured.decision.charges === undefined
                ? {}
                : {
                    charges: captured.decision.charges.map((charge) => ({
                      ...charge,
                      at: undefined,
                    })),
                  }),
            },
      };
      const semanticFingerprint = commandFingerprint(semantic);
      const existingResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.effect_intents
          WHERE effect_intent_id = $1 FOR UPDATE`,
        [captured.effectIntent.id],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const existing = decodeStoredRecord<{
          readonly input: string;
          readonly initialReceipt: AuthorizedIntentOutcome["initialReceipt"];
          readonly reserveBatch?: AuthorizationReserveBatch;
        }>(
          existingRow.record,
          (record) => isString(record.input) &&
            isObject(record.initialReceipt) &&
            validInitialReceipt(record.initialReceipt) &&
            (record.reserveBatch === undefined || isObject(record.reserveBatch)),
          "effect_intents.record",
        );
        return existing.input === semanticFingerprint
          ? {
              kind: "replayed",
              initialReceipt: existing.initialReceipt,
              ...(existing.reserveBatch === undefined
                ? {}
                : { reserveBatch: existing.reserveBatch }),
            }
          : { kind: "conflict" };
      }
      const identity = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.core_identities
          WHERE identity_id = $1 FOR UPDATE`,
        [captured.authorizationRequestId],
      );
      if (identity.rows[0] !== undefined) return { kind: "conflict" } as const;
      const current = await this.loadAuthorizationContext(
        client,
        captured.decisionResultHash,
        true,
      );
      if (current === null || !equal(current.decision, captured.expectedContext.decision)) {
        return {
          kind: "authorization_context_conflict",
          reason: "decision_changed",
        } as const;
      }
      if (!equal(current.jobCycle, captured.expectedContext.jobCycle)) {
        return {
          kind: "authorization_context_conflict",
          reason: "job_cycle_changed",
        } as const;
      }
      if (!equal(current.currentJob, captured.expectedContext.currentJob) ||
          current.currentJob.collectionCycle !== current.jobCycle.collectionCycle) {
        return {
          kind: "authorization_context_conflict",
          reason: "current_cycle_changed",
        } as const;
      }
      if (current.resultState !== "verified" ||
          captured.expectedContext.resultState !== "verified") {
        return {
          kind: "authorization_context_conflict",
          reason: "result_not_verified",
        } as const;
      }
      if (!equal(current.classVersion, captured.expectedContext.classVersion) ||
          !this.contextEligible(
            current.classVersion,
            captured.at,
            captured.expectedContext.maxInFlightDeadline,
          )) {
        return {
          kind: "authorization_context_conflict",
          reason: "class_version_ineligible",
        } as const;
      }
      const hasSplitLane = captured.decision.kind !== "deny" &&
        captured.decision.charges?.some((charge) =>
          charge.policy.lane === "splitAndAdjudication") === true;
      if ((captured.decision.kind === "pend") !== hasSplitLane) {
        return { kind: "reserve_batch_invalid", reason: "decision_mismatch" } as const;
      }
      let reserveBatch: AuthorizationReserveBatch | undefined;
      if (captured.decision.kind !== "deny" &&
          captured.decision.charges !== undefined) {
        const settlement = await this.settleAuthorizationReserves(
          client,
          captured.authorizationRequestId,
          captured.decision.charges,
          captured.expectedContext,
          captured.at,
        );
        if ("kind" in settlement) return settlement;
        reserveBatch = settlement;
      }
      if (captured.decision.kind === "pend" && reserveBatch === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "pending adjudication requires a reserve batch",
        );
      }

      const decision = current.decision;
      let initialReceipt: AuthorizedIntentOutcome["initialReceipt"];
      let status: AuthorizationStatus;
      let authorization: ActionAuthorization | undefined;
      if (captured.decision.kind === "deny") {
        initialReceipt = {
          authorizationRequestId: captured.authorizationRequestId,
          effectIntentId: captured.effectIntent.id,
          effectIntentHash: captured.effectIntentHash,
          jobId: decision.jobId,
          collectionCycle: decision.collectionCycle,
          decisionResultHash: captured.decisionResultHash,
          at: captured.at,
          outcome: "denied",
          denialReason: captured.decision.reason,
        };
        status = { state: "denied", reason: captured.decision.reason };
      } else if (reserveBatch?.settlements.some((entry) =>
          (entry.lane === "lowCost" || entry.lane === "urgent") &&
          entry.charge.outcome === "exhausted")) {
        initialReceipt = {
          authorizationRequestId: captured.authorizationRequestId,
          effectIntentId: captured.effectIntent.id,
          effectIntentHash: captured.effectIntentHash,
          jobId: decision.jobId,
          collectionCycle: decision.collectionCycle,
          decisionResultHash: captured.decisionResultHash,
          at: captured.at,
          outcome: "denied",
          denialReason: "escalation_budget_exhausted",
        };
        status = { state: "denied", reason: "escalation_budget_exhausted" };
      } else if (captured.decision.kind === "authorize") {
        authorization = structuredClone(captured.decision.authorization);
        initialReceipt = {
          authorizationRequestId: captured.authorizationRequestId,
          effectIntentId: captured.effectIntent.id,
          effectIntentHash: captured.effectIntentHash,
          jobId: decision.jobId,
          collectionCycle: decision.collectionCycle,
          decisionResultHash: captured.decisionResultHash,
          at: captured.at,
          outcome: "authorized",
          authorization,
        };
        status = { state: "authorized", validity: { kind: "valid" } };
      } else {
        initialReceipt = {
          authorizationRequestId: captured.authorizationRequestId,
          effectIntentId: captured.effectIntent.id,
          effectIntentHash: captured.effectIntentHash,
          jobId: decision.jobId,
          collectionCycle: decision.collectionCycle,
          decisionResultHash: captured.decisionResultHash,
          at: captured.at,
          outcome: "pending_adjudication",
        };
        status = { state: "pending_adjudication" };
      }
      const effectRecord = {
        input: semanticFingerprint,
        authorizationRequestId: captured.authorizationRequestId,
        effectIntent: structuredClone(captured.effectIntent),
        effectIntentHash: captured.effectIntentHash,
        decisionResultHash: captured.decisionResultHash,
        initialReceipt,
        ...(reserveBatch === undefined ? {} : { reserveBatch }),
      };
      const insertedIdentity = await client.query(
        `INSERT INTO ${this.quotedSchema}.core_identities
           (identity_id, identity_kind)
         VALUES ($1, 'authorization_request')
         ON CONFLICT (identity_id) DO NOTHING`,
        [captured.authorizationRequestId],
      );
      if (insertedIdentity.rowCount !== 1) restartSerializableTransaction();
      await client.query(
        `INSERT INTO ${this.quotedSchema}.effect_intents
           (effect_intent_id, authorization_request_id, effect_intent_hash,
            decision_result_hash, record)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [captured.effectIntent.id, captured.authorizationRequestId,
          captured.effectIntentHash, captured.decisionResultHash,
          JSON.stringify(effectRecord)],
      );
      await client.query(
        `INSERT INTO ${this.quotedSchema}.authorization_status
           (authorization_request_id, state, revision, record)
         VALUES ($1, $2, 1, $3::jsonb)`,
        [captured.authorizationRequestId, status.state, JSON.stringify(status)],
      );
      if (authorization !== undefined) {
        await client.query(
          `INSERT INTO ${this.quotedSchema}.authorizations
             (authorization_request_id, effect_intent_id, class_id, job_id,
              collection_cycle, record)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [captured.authorizationRequestId, captured.effectIntent.id,
            current.jobCycle.classId, authorization.jobId,
            authorization.collectionCycle, JSON.stringify(authorization)],
        );
      }
      if (captured.decision.kind === "pend" && status.state === "pending_adjudication") {
        await client.query(
          `INSERT INTO ${this.quotedSchema}.action_adjudications
             (authorization_request_id, class_id, opened_at, request, context)
           VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5::jsonb)`,
          [captured.authorizationRequestId, current.jobCycle.classId, captured.at,
            JSON.stringify(captured.decision.request),
            JSON.stringify(captured.expectedContext)],
        );
        await this.bumpAdjudicationLoad(
          client,
          current.jobCycle.classId,
          captured.at,
        );
      }
      return {
        kind: "applied",
        initialReceipt,
        ...(reserveBatch === undefined ? {} : { reserveBatch }),
      };
    });
  }

  async getAuthorizationStatus(
    authorizationRequestId: Parameters<Store["getAuthorizationStatus"]>[0],
  ): ReturnType<Store["getAuthorizationStatus"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.authorization_status
          WHERE authorization_request_id = $1`,
        [authorizationRequestId],
      );
      return result.rows[0] === undefined
        ? null
        : decodeStoredRecord<AuthorizationStatus>(
            result.rows[0].record,
            validAuthorizationStatus,
            "authorization_status.record",
          );
    });
  }

  async getInitialReceipt(
    effectIntentId: Parameters<Store["getInitialReceipt"]>[0],
  ): ReturnType<Store["getInitialReceipt"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.effect_intents
          WHERE effect_intent_id = $1`,
        [effectIntentId],
      );
      if (result.rows[0] === undefined) return null;
      const stored = decodeStoredRecord<{
        readonly initialReceipt: AuthorizedIntentOutcome["initialReceipt"];
      }>(
        result.rows[0].record,
        (record) => isObject(record.initialReceipt) &&
          validInitialReceipt(record.initialReceipt as JsonRecord),
        "effect_intents.record",
      );
      return decodeStoredRecord<AuthorizedIntentOutcome["initialReceipt"]>(
        stored.initialReceipt,
        validInitialReceipt,
        "effect_intents.record.initialReceipt",
      );
    });
  }

  async getAuthorization(
    authorizationRequestId: Parameters<Store["getAuthorization"]>[0],
  ): ReturnType<Store["getAuthorization"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.authorizations
          WHERE authorization_request_id = $1`,
        [authorizationRequestId],
      );
      return result.rows[0] === undefined
        ? null
        : decodeStoredRecord<ActionAuthorization>(
            result.rows[0].record,
            validActionAuthorization,
            "authorizations.record",
          );
    });
  }
  async inspectInvalidationScope(
    scope: Parameters<Store["inspectInvalidationScope"]>[0],
  ): ReturnType<Store["inspectInvalidationScope"]> {
    return withPoolClient(this.#pool, (client) =>
      this.loadInvalidationSnapshot(client, scope));
  }

  async invalidateResultScope(
    input: Parameters<Store["invalidateResultScope"]>[0],
  ): ReturnType<Store["invalidateResultScope"]> {
    return this.transact(input, async (client, captured) => {
      const replayKey = commandFingerprint(captured);
      const replay = await this.readReplay<AppliedInvalidation>(
        client,
        "invalidate_result_scope",
        replayKey,
        replayKey,
        validOutcome("applied"),
      );
      if (replay !== null) return replay;
      const current = await this.loadInvalidationSnapshot(client, captured.scope, true);
      const expectedTargets = [...captured.expectedTargets].sort((left, right) =>
        compareWireIds(left.jobId, right.jobId) ||
        left.collectionCycle - right.collectionCycle);
      if (!equal(current.targets, expectedTargets)) {
        return { kind: "conflict", current } as const;
      }
      let epochTransition: {
        readonly classId: string;
        readonly fromEpoch: string | null;
        readonly toEpoch: string;
      } | undefined;
      if (captured.reason === "emergency_permit_withdrawal") {
        const transition = captured.epochTransition;
        const epochResult = await client.query<{ readonly permit_epoch: unknown }>(
          `SELECT permit_epoch FROM ${this.quotedSchema}.permit_epochs
            WHERE class_id = $1 FOR UPDATE`,
          [transition.classId],
        );
        const currentEpoch = epochResult.rows[0]?.permit_epoch;
        if (transition.classId !== captured.scope.classId ||
            currentEpoch !== transition.fromEpoch) {
          return { kind: "conflict", current } as const;
        }
        epochTransition = transition;
      }
      const outcome = await this.applyInvalidation(
        client,
        current,
        captured.reason,
        captured.requeuePlans,
        captured.at,
        epochTransition,
      );
      await this.writeReplay(
        client,
        "invalidate_result_scope",
        replayKey,
        replayKey,
        outcome,
      );
      return outcome;
    });
  }
  async openResultAdjudication(
    input: Parameters<Store["openResultAdjudication"]>[0],
  ): ReturnType<Store["openResultAdjudication"]> {
    return this.transact(input, async (client, captured) => {
      const existingResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.result_adjudications
          WHERE request_id = $1 FOR UPDATE`,
        [captured.request.id],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const existing = decodeStoredRecord<{
          readonly request: typeof captured.request;
          readonly openedAt: string;
          readonly charge: {
            readonly charge: Extract<ReserveChargeOutcome,
              { kind: "charged" | "exhausted" }>["charge"];
            readonly currentPolicy: ReservePolicyRecord;
            readonly classHealth: ClassHealthSnapshot;
          };
        }>(
          existingRow.record,
          (record) => validResultAdjudicationRequest(record.request) &&
            isString(record.openedAt) && isObject(record.charge),
          "result_adjudications.record",
        );
        const same = equal(existing.request, captured.request) && equal(
          { ...existing.charge.charge.charge, at: undefined },
          { ...captured.charge, at: undefined },
        );
        if (!same) return { kind: "identity_conflict" } as const;
        return {
          kind: "replayed",
          original: existing.charge.charge.outcome === "charged"
            ? "opened_charged"
            : "opened_uncovered",
          openedAt: existing.openedAt,
          ...existing.charge,
        } as Awaited<ReturnType<Store["openResultAdjudication"]>>;
      }
      const identity = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.core_identities
          WHERE identity_id = $1 FOR UPDATE`,
        [captured.request.id],
      );
      if (identity.rows[0] !== undefined) {
        return { kind: "identity_conflict" } as const;
      }
      const cycleResult = await client.query<{
        readonly result_state: unknown;
        readonly record: unknown;
      }>(
        `SELECT result_state, record FROM ${this.quotedSchema}.job_cycles
          WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
        [captured.resultTransition.jobId, captured.resultTransition.collectionCycle],
      );
      const cycleRow = cycleResult.rows[0];
      const actual = cycleRow?.result_state;
      if (actual !== undefined && (!isString(actual) || !resultStates.has(actual))) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "job_cycles.result_state has an unknown value",
        );
      }
      if (cycleRow === undefined) {
        return { kind: "state_conflict", actual: captured.resultTransition.from } as const;
      }
      const job = decodeJob({ record: cycleRow.record }, "job_cycles.record");
      if (captured.request.jobId !== captured.resultTransition.jobId ||
          captured.request.collectionCycle !== captured.resultTransition.collectionCycle ||
          captured.request.inputHash !== job.inputHash ||
          captured.request.contractVersion !== job.contractVersion ||
          captured.request.permitEpoch !== job.permitEpoch ||
          actual !== captured.resultTransition.from) {
        return {
          kind: "state_conflict",
          actual: (actual as ResultState) ?? captured.resultTransition.from,
        } as const;
      }
      const cycleCollision = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.result_adjudications
          WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
        [job.jobId, job.collectionCycle],
      );
      if (cycleCollision.rows[0] !== undefined) {
        return { kind: "state_conflict", actual: actual as ResultState } as const;
      }
      const settlement = await this.settleReserve(client, captured.charge);
      if (settlement.kind === "reserve_charge_conflict" ||
          settlement.kind === "reserve_policy_conflict") return settlement;
      const charge = {
        charge: settlement.charge,
        currentPolicy: settlement.currentPolicy,
        classHealth: settlement.classHealth,
      };
      const openedAt = captured.resultTransition.at;
      const state = "pending_result_adjudication" as const;
      const record = {
        request: structuredClone(captured.request),
        openedAt,
        state,
        charge,
      };
      const insertedIdentity = await client.query(
        `INSERT INTO ${this.quotedSchema}.core_identities
           (identity_id, identity_kind)
         VALUES ($1, 'result_adjudication_request')
         ON CONFLICT (identity_id) DO NOTHING`,
        [captured.request.id],
      );
      if (insertedIdentity.rowCount !== 1) restartSerializableTransaction();
      await client.query(
        `INSERT INTO ${this.quotedSchema}.result_adjudications
           (request_id, job_id, collection_cycle, class_id, state, opened_at, record)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)`,
        [
          captured.request.id,
          job.jobId,
          job.collectionCycle,
          job.classId,
          state,
          openedAt,
          JSON.stringify(record),
        ],
      );
      await client.query(
        `UPDATE ${this.quotedSchema}.job_cycles
            SET result_state = 'pending_result_adjudication'
          WHERE job_id = $1 AND collection_cycle = $2`,
        [job.jobId, job.collectionCycle],
      );
      await this.bumpAdjudicationLoad(client, job.classId, openedAt);
      return {
        kind: settlement.kind === "charged" ? "opened_charged" : "opened_uncovered",
        openedAt,
        ...charge,
      } as Awaited<ReturnType<Store["openResultAdjudication"]>>;
    });
  }

  async getResultAdjudicationRequest(
    id: Parameters<Store["getResultAdjudicationRequest"]>[0],
  ): ReturnType<Store["getResultAdjudicationRequest"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.result_adjudications
          WHERE request_id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : decodeStoredRecord<{ readonly request: NonNullable<
            Awaited<ReturnType<Store["getResultAdjudicationRequest"]>>
          > }>(
            row.record,
            (record) => validResultAdjudicationRequest(record.request),
            "result_adjudications.record",
          ).request;
    });
  }

  async inspectResultVerdictContext(
    id: Parameters<Store["inspectResultVerdictContext"]>[0],
  ): ReturnType<Store["inspectResultVerdictContext"]> {
    return withPoolClient(this.#pool, (client) =>
      this.loadResultVerdictContext(client, id));
  }

  async listPendingResultAdjudications(
    classId: Parameters<Store["listPendingResultAdjudications"]>[0],
  ): ReturnType<Store["listPendingResultAdjudications"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.result_adjudications
          WHERE class_id = $1 AND state = 'pending_result_adjudication'
          ORDER BY opened_at, request_id COLLATE "C"`,
        [classId],
      );
      return result.rows.map((row) => {
        const record = decodeStoredRecord<{
          readonly request: Awaited<ReturnType<
            Store["listPendingResultAdjudications"]
          >>[number]["request"];
          readonly openedAt: string;
        }>(
          row.record,
          (stored) => validResultAdjudicationRequest(stored.request) &&
            isString(stored.openedAt),
          "result_adjudications.record",
        );
        return { request: record.request, openedAt: record.openedAt };
      });
    });
  }

  async applyResultAdjudicationVerdict(
    input: Parameters<Store["applyResultAdjudicationVerdict"]>[0],
  ): ReturnType<Store["applyResultAdjudicationVerdict"]> {
    return this.transact(input, async (client, captured) => {
      const requestId = captured.verdict.resultAdjudicationRequestId;
      const verdictFingerprint = commandFingerprint({
        verdict: captured.verdict,
        verdictHash: captured.verdictHash,
      });
      const priorResult = await client.query<{
        readonly fingerprint: string;
        readonly record: unknown;
      }>(
        `SELECT fingerprint, record FROM ${this.quotedSchema}.verdict_history
          WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        const record = decodeStoredRecord<VerdictHistoryRecord>(
          prior.record,
          validVerdictHistory,
          "verdict_history.record",
        );
        return prior.fingerprint === verdictFingerprint
          ? { kind: "replayed", receipt: record.receipt } as const
          : { kind: "conflict" } as const;
      }
      const adjudicationResult = await client.query<{
        readonly state: string;
        readonly class_id: string;
        readonly record: unknown;
      }>(
        `SELECT state, class_id, record
           FROM ${this.quotedSchema}.result_adjudications
          WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      const adjudicationRow = adjudicationResult.rows[0];
      if (adjudicationRow === undefined ||
          adjudicationRow.state !== "pending_result_adjudication") {
        return { kind: "terminal" } as const;
      }
      const adjudication = decodeStoredRecord<{
        readonly request: ResultVerdictContext["request"];
        readonly openedAt: string;
        readonly state: string;
        readonly charge: unknown;
      }>(
        adjudicationRow.record,
        (record) => validResultAdjudicationRequest(record.request) &&
          isString(record.openedAt) &&
          record.state === "pending_result_adjudication" &&
          isObject(record.charge),
        "result_adjudications.record",
      );
      const request = adjudication.request;
      const verdictMatches = captured.verdict.reason === request.reason &&
        captured.verdict.jobId === request.jobId &&
        captured.verdict.collectionCycle === request.collectionCycle &&
        captured.verdict.inputHash === request.inputHash &&
        equal(captured.verdict.candidateResultHashes, request.candidateResultHashes) &&
        equal(captured.verdict.evidence, request.evidence) &&
        captured.verdict.contractVersion === request.contractVersion &&
        captured.verdict.permitEpoch === request.permitEpoch &&
        captured.verdict.decision.kind === captured.decision;
      if (!verdictMatches) return { kind: "conflict" } as const;
      const context = await this.loadResultVerdictContext(client, requestId, true);
      const expected = {
        request: captured.expectedContext.request,
        jobCycle: captured.expectedContext.jobCycle,
        currentJob: captured.expectedContext.currentJob,
        resultState: captured.expectedContext.resultState,
        classVersion: captured.expectedContext.classVersion,
      };
      if (context === null || !equal(context, expected) ||
          context.currentJob.collectionCycle !== request.collectionCycle ||
          context.resultState !== "pending_result_adjudication" ||
          !this.contextEligible(
            context.classVersion,
            captured.processedAt,
            captured.expectedContext.maxInFlightDeadline,
          )) {
        return { kind: "freshness_conflict" } as const;
      }
      let receipt: Extract<Awaited<ReturnType<
        Store["applyResultAdjudicationVerdict"]
      >>, { kind: "applied" }>["receipt"];
      let adjudicationState: string;
      if (captured.decision === "resolve") {
        const resolved = captured.resolved;
        if (resolved.jobId !== request.jobId ||
            resolved.collectionCycle !== request.collectionCycle ||
            resolved.inputHash !== request.inputHash ||
            resolved.contractVersion !== request.contractVersion ||
            resolved.permitEpoch !== request.permitEpoch ||
            resolved.resultAdjudicationVerdictHash !== captured.verdictHash ||
            resolved.verifiedAt !== captured.processedAt ||
            !equal(resolved.evidence, request.evidence)) {
          return { kind: "conflict" } as const;
        }
        const inserted = await client.query(
          `INSERT INTO ${this.quotedSchema}.decisions
             (decision_result_hash, job_id, collection_cycle, verified_at, record)
           VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
           ON CONFLICT (decision_result_hash) DO NOTHING`,
          [resolved.decisionResultHash, resolved.jobId, resolved.collectionCycle,
            resolved.verifiedAt, JSON.stringify(resolved)],
        );
        if (inserted.rowCount !== 1) return { kind: "conflict" } as const;
        await client.query(
          `UPDATE ${this.quotedSchema}.job_cycles SET result_state = 'verified'
            WHERE job_id = $1 AND collection_cycle = $2`,
          [request.jobId, request.collectionCycle],
        );
        adjudicationState = "resolved";
        receipt = {
          requestId,
          verdictHash: captured.verdictHash,
          decidedAt: captured.verdict.decidedAt,
          outcome: "resolved",
        };
      } else {
        const oldJob = context.jobCycle;
        const requeue = oldJob.rejectedDisputeRequeues < captured.onReject.cap;
        if (requeue && (captured.onReject.newCycleEpoch.length === 0 ||
            captured.onReject.newCycleInputHash.length === 0 ||
            captured.onReject.cycleStartedAt !== captured.processedAt)) {
          return { kind: "conflict" } as const;
        }
        await client.query(
          `UPDATE ${this.quotedSchema}.job_cycles SET result_state = 'rejected'
            WHERE job_id = $1 AND collection_cycle = $2`,
          [request.jobId, request.collectionCycle],
        );
        adjudicationState = "rejected";
        if (requeue) {
          const next: JobRecord = {
            ...oldJob,
            collectionCycle: oldJob.collectionCycle + 1,
            permitEpoch: captured.onReject.newCycleEpoch,
            inputHash: captured.onReject.newCycleInputHash,
            cycleStartedAt: captured.onReject.cycleStartedAt,
            rejectedDisputeRequeues: oldJob.rejectedDisputeRequeues + 1,
          };
          const collision = await client.query(
            `SELECT 1 FROM ${this.quotedSchema}.job_cycles
              WHERE job_id = $1 AND collection_cycle = $2 FOR UPDATE`,
            [next.jobId, next.collectionCycle],
          );
          if (collision.rows[0] !== undefined) return { kind: "conflict" } as const;
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
            [next.jobId, next.collectionCycle, next.permitEpoch, next.inputHash,
              next.cycleStartedAt, JSON.stringify(next)],
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
        receipt = {
          requestId,
          verdictHash: captured.verdictHash,
          decidedAt: captured.verdict.decidedAt,
          outcome: "rejected",
          rejectOutcome: requeue ? "requeued" : "cap_exhausted",
        };
      }
      const nextRecord = { ...adjudication, state: adjudicationState };
      await client.query(
        `UPDATE ${this.quotedSchema}.result_adjudications
            SET state = $2, record = $3::jsonb WHERE request_id = $1`,
        [requestId, adjudicationState, JSON.stringify(nextRecord)],
      );
      const history = {
        kind: "result" as const,
        requestId,
        verdictHash: captured.verdictHash,
        verdict: structuredClone(captured.verdict),
        receipt,
      };
      await client.query(
        `INSERT INTO ${this.quotedSchema}.verdict_history
           (request_id, kind, verdict_hash, processed_at, fingerprint, record)
         VALUES ($1, 'result', $2, $3::timestamptz, $4, $5::jsonb)`,
        [requestId, captured.verdictHash, captured.processedAt,
          verdictFingerprint, JSON.stringify(history)],
      );
      await this.bumpAdjudicationLoad(
        client,
        adjudicationRow.class_id,
        captured.processedAt,
      );
      return { kind: "applied", receipt } as const;
    });
  }
  async getActionAdjudicationRequest(
    authorizationRequestId: Parameters<Store["getActionAdjudicationRequest"]>[0],
  ): ReturnType<Store["getActionAdjudicationRequest"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{ readonly request: unknown }>(
        `SELECT request FROM ${this.quotedSchema}.action_adjudications
          WHERE authorization_request_id = $1`,
        [authorizationRequestId],
      );
      return result.rows[0] === undefined
        ? null
        : decodeStoredRecord<ActionAdjudicationRequest>(
            result.rows[0].request,
            validActionAdjudicationRequest,
            "action_adjudications.request",
          );
    });
  }

  async getPendingAuthorizationContext(
    authorizationRequestId: Parameters<Store["getPendingAuthorizationContext"]>[0],
  ): ReturnType<Store["getPendingAuthorizationContext"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{ readonly context: unknown }>(
        `SELECT context FROM ${this.quotedSchema}.action_adjudications
          WHERE authorization_request_id = $1`,
        [authorizationRequestId],
      );
      return result.rows[0] === undefined
        ? null
        : decodeStoredRecord<PendingAuthorizationContext>(
            result.rows[0].context,
            validAuthorizationContext,
            "action_adjudications.context",
          );
    });
  }

  async listPendingActionAdjudications(
    classId: Parameters<Store["listPendingActionAdjudications"]>[0],
  ): ReturnType<Store["listPendingActionAdjudications"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<{
        readonly request: unknown;
        readonly opened_at: unknown;
      }>(
        `SELECT aa.request, aa.opened_at
           FROM ${this.quotedSchema}.action_adjudications aa
           JOIN ${this.quotedSchema}.authorization_status ast
             ON ast.authorization_request_id = aa.authorization_request_id
          WHERE aa.class_id = $1 AND ast.state = 'pending_adjudication'
          ORDER BY aa.opened_at, aa.authorization_request_id COLLATE "C"`,
        [classId],
      );
      return result.rows.map((row) => ({
        request: decodeStoredRecord<Awaited<ReturnType<
          Store["listPendingActionAdjudications"]
        >>[number]["request"]>(
          row.request,
          validActionAdjudicationRequest,
          "action_adjudications.request",
        ),
        openedAt: row.opened_at instanceof Date
          ? row.opened_at.toISOString()
          : String(row.opened_at),
      }));
    });
  }

  async getVerdictHistory(
    requestId: Parameters<Store["getVerdictHistory"]>[0],
  ): ReturnType<Store["getVerdictHistory"]> {
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.verdict_history
          WHERE request_id = $1`,
        [requestId],
      );
      return result.rows[0] === undefined
        ? null
        : decodeStoredRecord<VerdictHistoryRecord>(
            result.rows[0].record,
            validVerdictHistory,
            "verdict_history.record",
          );
    });
  }
  async applyActionAdjudicationVerdict(
    input: Parameters<Store["applyActionAdjudicationVerdict"]>[0],
  ): ReturnType<Store["applyActionAdjudicationVerdict"]> {
    return this.transact(input, async (client, captured) => {
      const requestId = captured.verdict.authorizationRequestId;
      const verdictFingerprint = commandFingerprint({
        verdict: captured.verdict,
        verdictHash: captured.verdictHash,
      });
      const priorResult = await client.query<{
        readonly fingerprint: string;
        readonly record: unknown;
      }>(
        `SELECT fingerprint, record FROM ${this.quotedSchema}.verdict_history
          WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      const prior = priorResult.rows[0];
      if (prior !== undefined) {
        const record = decodeStoredRecord<VerdictHistoryRecord>(
          prior.record,
          validVerdictHistory,
          "verdict_history.record",
        );
        return prior.fingerprint === verdictFingerprint
          ? { kind: "replayed", receipt: record.receipt } as const
          : { kind: "conflict" } as const;
      }
      const pendingResult = await client.query<{
        readonly request: unknown;
        readonly context: unknown;
        readonly class_id: string;
        readonly status_record: unknown;
        readonly status_revision: string;
        readonly status_state: string;
      }>(
        `SELECT aa.request, aa.context, aa.class_id,
                ast.record AS status_record, ast.revision AS status_revision,
                ast.state AS status_state
           FROM ${this.quotedSchema}.action_adjudications aa
           JOIN ${this.quotedSchema}.authorization_status ast
             ON ast.authorization_request_id = aa.authorization_request_id
          WHERE aa.authorization_request_id = $1
          FOR UPDATE OF aa, ast`,
        [requestId],
      );
      const pendingRow = pendingResult.rows[0];
      if (pendingRow === undefined || pendingRow.status_state !== "pending_adjudication") {
        return { kind: "terminal" } as const;
      }
      const request = decodeStoredRecord<ActionAdjudicationRequest>(
        pendingRow.request,
        validActionAdjudicationRequest,
        "action_adjudications.request",
      );
      const persisted = decodeStoredRecord<PendingAuthorizationContext>(
        pendingRow.context,
        validAuthorizationContext,
        "action_adjudications.context",
      );
      const verdictMatches = captured.verdict.jobId === request.jobId &&
        captured.verdict.collectionCycle === request.collectionCycle &&
        captured.verdict.effectIntentId === request.effectIntent.id &&
        captured.verdict.effectIntentHash === request.effectIntentHash &&
        captured.verdict.inputHash === request.inputHash &&
        captured.verdict.decisionResultHash === request.decisionResultHash &&
        equal(captured.verdict.evidence, request.evidence) &&
        captured.verdict.resultAdjudicationVerdictHash ===
          request.resultAdjudicationVerdictHash &&
        captured.verdict.contractVersion === request.contractVersion &&
        captured.verdict.permitEpoch === request.permitEpoch &&
        captured.verdict.decision === captured.decision;
      if (!verdictMatches) return { kind: "conflict" } as const;
      const current = await this.loadAuthorizationContext(
        client,
        request.decisionResultHash,
        true,
      );
      const expectedCurrent = {
        decision: captured.expectedContext.current.decision,
        jobCycle: captured.expectedContext.current.jobCycle,
        currentJob: captured.expectedContext.current.currentJob,
        resultState: captured.expectedContext.current.resultState,
        classVersion: captured.expectedContext.current.classVersion,
      };
      if (current === null ||
          !equal(persisted, captured.expectedContext.persisted) ||
          !equal(current, expectedCurrent) ||
          current.currentJob.collectionCycle !== request.collectionCycle ||
          current.resultState !== "verified" ||
          !this.contextEligible(
            current.classVersion,
            captured.processedAt,
            captured.expectedContext.persisted.maxInFlightDeadline,
          )) {
        return { kind: "freshness_conflict" } as const;
      }
      const receipt = captured.decision === "approve"
        ? {
            requestId,
            verdictHash: captured.verdictHash,
            decidedAt: captured.verdict.decidedAt,
            outcome: "approved" as const,
          }
        : {
            requestId,
            verdictHash: captured.verdictHash,
            decidedAt: captured.verdict.decidedAt,
            outcome: "denied" as const,
          };
      let status: AuthorizationStatus;
      if (captured.decision === "approve") {
        const authorization = captured.authorization;
        if (authorization.authorizationRequestId !== requestId ||
            authorization.effectIntentId !== request.effectIntent.id ||
            authorization.effectIntentHash !== request.effectIntentHash ||
            authorization.jobId !== request.jobId ||
            authorization.collectionCycle !== request.collectionCycle ||
            authorization.inputHash !== request.inputHash ||
            authorization.decisionResultHash !== request.decisionResultHash ||
            !equal(authorization.evidence, request.evidence) ||
            authorization.resultAdjudicationVerdictHash !==
              request.resultAdjudicationVerdictHash ||
            authorization.actionAdjudicationVerdictHash !== captured.verdictHash ||
            authorization.contractVersion !== request.contractVersion ||
            authorization.permitEpoch !== request.permitEpoch ||
            !equal(authorization.actions, captured.verdict.actions)) {
          return { kind: "conflict" } as const;
        }
        const effect = await client.query<{ readonly effect_intent_id: string }>(
          `SELECT effect_intent_id FROM ${this.quotedSchema}.effect_intents
            WHERE authorization_request_id = $1 FOR UPDATE`,
          [requestId],
        );
        if (effect.rows[0] === undefined) {
          throw new PostgresInfrastructureError(
            "invalid_stored_value",
            `authorization ${requestId} has no effect intent`,
          );
        }
        await client.query(
          `INSERT INTO ${this.quotedSchema}.authorizations
             (authorization_request_id, effect_intent_id, class_id, job_id,
              collection_cycle, record)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [requestId, effect.rows[0].effect_intent_id, pendingRow.class_id,
            authorization.jobId, authorization.collectionCycle,
            JSON.stringify(authorization)],
        );
        status = { state: "authorized", validity: { kind: "valid" } };
      } else {
        status = { state: "denied", reason: "human_rejected" };
      }
      const revision = decodePositiveRevision(
        pendingRow.status_revision,
        "authorization_status.revision",
      );
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.authorization_status
            SET state = $2, revision = $3, record = $4::jsonb
          WHERE authorization_request_id = $1 AND revision = $5`,
        [requestId, status.state, revision + 1, JSON.stringify(status), revision],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
      const history: VerdictHistoryRecord = {
        kind: "action",
        requestId,
        verdictHash: captured.verdictHash,
        verdict: structuredClone(captured.verdict),
        receipt,
      };
      await client.query(
        `INSERT INTO ${this.quotedSchema}.verdict_history
           (request_id, kind, verdict_hash, processed_at, fingerprint, record)
         VALUES ($1, 'action', $2, $3::timestamptz, $4, $5::jsonb)`,
        [requestId, captured.verdictHash, captured.processedAt,
          verdictFingerprint, JSON.stringify(history)],
      );
      await this.bumpAdjudicationLoad(client, pendingRow.class_id, captured.processedAt);
      return { kind: "applied", receipt } as const;
    });
  }
  async inspectAdjudicationLoad(
    input: Parameters<Store["inspectAdjudicationLoad"]>[0],
  ): ReturnType<Store["inspectAdjudicationLoad"]> {
    return withPoolClient(this.#pool, (client) =>
      this.loadAdjudicationLoad(client, input));
  }

  async refreshClassHealth(
    input: Parameters<Store["refreshClassHealth"]>[0],
  ): ReturnType<Store["refreshClassHealth"]> {
    return this.transact(input, async (client, captured) => {
      const replayKey = commandFingerprint(captured);
      const replay = await this.readReplay<{
        readonly kind: "applied";
        readonly health: ClassHealthSnapshot;
        readonly load: AdjudicationLoadSnapshot;
      }>(
        client,
        "refresh_class_health",
        replayKey,
        replayKey,
        validOutcome("applied"),
      );
      if (replay !== null) return { ...replay, kind: "replayed" } as const;
      const healthResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1 FOR UPDATE`,
        [captured.expectedHealth.classId],
      );
      const healthRow = healthResult.rows[0];
      if (healthRow === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `class ${captured.expectedHealth.classId} has no health snapshot`,
        );
      }
      const current = decodeHealth(healthRow);
      const load = await this.loadAdjudicationLoad(client, {
        classId: captured.expectedLoad.classId,
        windowStartsAt: captured.expectedLoad.windowStartsAt,
      });
      const versionsResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 ORDER BY contract_version COLLATE "C"
          FOR UPDATE`,
        [current.classId],
      );
      const versions = versionsResult.rows.map((row) => decodeClassVersion(row));
      if (!equal(current, captured.expectedHealth) ||
          !equal(load, captured.expectedLoad) ||
          !equal(versions, captured.expectedClassVersions) ||
          current.classId !== load.classId) {
        return { kind: "conflict", health: current, load } as const;
      }
      const next: ClassHealthSnapshot = {
        revision: current.revision + 1,
        classId: current.classId,
        health: {
          ...structuredClone(captured.next.health),
          reserves: structuredClone(current.health.reserves),
        },
        updatedAt: captured.next.updatedAt,
        source: captured.next.source,
        ...(captured.next.adjudicationUnsafeSince === undefined
          ? {}
          : { adjudicationUnsafeSince: captured.next.adjudicationUnsafeSince }),
      };
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.class_health
            SET revision = $2, operating = $3, updated_at = $4::timestamptz,
                adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
          WHERE class_id = $1 AND revision = $7`,
        [current.classId, next.revision, next.health.operating, next.updatedAt,
          next.adjudicationUnsafeSince ?? null, JSON.stringify(next), current.revision],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
      const outcome = { kind: "applied" as const, health: next, load };
      await this.writeReplay(
        client,
        "refresh_class_health",
        replayKey,
        replayKey,
        outcome,
      );
      return outcome;
    });
  }
  async enterEmergencyHalt(
    input: Parameters<Store["enterEmergencyHalt"]>[0],
  ): ReturnType<Store["enterEmergencyHalt"]> {
    return this.transact(input, async (client, captured) => {
      const replayKey = commandFingerprint(captured);
      const replay = await this.readReplay<Extract<
        Awaited<ReturnType<Store["enterEmergencyHalt"]>>,
        { kind: "applied" }
      >>(
        client,
        "enter_emergency_halt",
        replayKey,
        replayKey,
        validOutcome("applied"),
      );
      if (replay !== null) return replay;
      const queueResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.queue_state
          WHERE singleton = true FOR UPDATE`,
      );
      const queueRow = queueResult.rows[0];
      if (queueRow === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "queue state is missing",
        );
      }
      const queue = decodeQueue(queueRow);
      const healthResult = await client.query<RevisionedRecordRow>(
        `SELECT revision, record FROM ${this.quotedSchema}.class_health
          ORDER BY class_id COLLATE "C" FOR UPDATE`,
      );
      const classHealth = healthResult.rows.map((row) => decodeHealth(row));
      const currentInvalidations = await Promise.all(captured.invalidations.map((entry) =>
        this.loadInvalidationSnapshot(client, entry.scope, true)));
      const expectedHealth = [...captured.expectedClassHealth].sort((left, right) =>
        compareWireIds(left.classId, right.classId));
      const classIds = classHealth.map((entry) => entry.classId);
      const nextIds = captured.nextClassHealth.map((entry) => entry.classId);
      const invalidationIds = captured.invalidations.map((entry) => entry.scope.classId);
      const invalidationsMatch = equal(invalidationIds, [...invalidationIds].sort(compareWireIds)) &&
        equal(invalidationIds, classIds) &&
        captured.invalidations.every((entry, index) => {
          const expectedTargets = [...entry.expectedTargets].sort((left, right) =>
            compareWireIds(left.jobId, right.jobId) ||
            left.collectionCycle - right.collectionCycle);
          return equal(currentInvalidations[index]?.targets, expectedTargets);
        });
      if (!equal(queue, captured.expectedQueue) ||
          !equal(classHealth, expectedHealth) ||
          !equal(nextIds, classIds) || !invalidationsMatch) {
        return {
          kind: "conflict",
          queue,
          classHealth,
          invalidations: currentInvalidations,
        } as const;
      }
      const invalidations = [] as Extract<Awaited<ReturnType<
        Store["enterEmergencyHalt"]
      >>, { kind: "applied" }>["invalidations"] extends readonly (infer Entry)[]
        ? Entry[]
        : never;
      for (let index = 0; index < captured.invalidations.length; index += 1) {
        const entry = captured.invalidations[index]!;
        invalidations.push(await this.applyInvalidation(
          client,
          currentInvalidations[index]!,
          "emergency_halted",
          entry.requeuePlans,
          captured.at,
        ));
      }
      const nextQueue: QueueModeSnapshot = {
        revision: queue.revision + 1,
        mode: "emergency_halted",
        cause: captured.nextQueue.cause,
        updatedAt: captured.nextQueue.updatedAt,
      };
      await client.query(
        `UPDATE ${this.quotedSchema}.queue_state
            SET revision = $1, mode = $2, cause = $3,
                updated_at = $4::timestamptz, record = $5::jsonb
          WHERE singleton = true`,
        [nextQueue.revision, nextQueue.mode, nextQueue.cause,
          nextQueue.updatedAt, JSON.stringify(nextQueue)],
      );
      const nextHealth: ClassHealthSnapshot[] = [];
      for (let index = 0; index < classHealth.length; index += 1) {
        const current = classHealth[index]!;
        const prepared = captured.nextClassHealth[index]!;
        const next: ClassHealthSnapshot = {
          revision: current.revision + 1,
          classId: current.classId,
          health: {
            ...structuredClone(prepared.health),
            reserves: structuredClone(current.health.reserves),
          },
          updatedAt: prepared.updatedAt,
          source: prepared.source,
          ...(current.adjudicationUnsafeSince === undefined
            ? {}
            : { adjudicationUnsafeSince: current.adjudicationUnsafeSince }),
        };
        await client.query(
          `UPDATE ${this.quotedSchema}.class_health
              SET revision = $2, operating = $3, updated_at = $4::timestamptz,
                  adjudication_unsafe_since = $5::timestamptz, record = $6::jsonb
            WHERE class_id = $1`,
          [next.classId, next.revision, next.health.operating, next.updatedAt,
            next.adjudicationUnsafeSince ?? null, JSON.stringify(next)],
        );
        nextHealth.push(next);
      }
      const outcome = {
        kind: "applied" as const,
        queue: nextQueue,
        classHealth: nextHealth,
        invalidations,
      };
      await this.writeReplay(
        client,
        "enter_emergency_halt",
        replayKey,
        replayKey,
        outcome,
      );
      return outcome;
    });
  }
  async getReservePolicy(
    input: Parameters<Store["getReservePolicy"]>[0],
  ): ReturnType<Store["getReservePolicy"]> {
    return withPoolClient(this.#pool, (client) =>
      this.loadReservePolicy(client, input));
  }

  async initializeReservePolicy(
    input: Parameters<Store["initializeReservePolicy"]>[0],
  ): ReturnType<Store["initializeReservePolicy"]> {
    return this.transact(input, async (client, captured) => {
      const key = `${captured.policy.classId}:${captured.policy.contractVersion}:${captured.policy.lane}`;
      const fingerprint = commandFingerprint(captured.policy);
      const replayResult = await client.query<ReplayRow>(
        `SELECT fingerprint, outcome FROM ${this.quotedSchema}.command_replays
          WHERE command_kind = 'initialize_reserve_policy' AND command_key = $1`,
        [key],
      );
      const prior = replayResult.rows[0];
      if (prior !== undefined && prior.fingerprint === fingerprint) {
        const outcome = decodeStoredRecord<{
          readonly kind: "initialized";
          readonly current: ReservePolicyRecord;
          readonly classHealth: ClassHealthSnapshot;
        }>(
          prior.outcome,
          (record) => record.kind === "initialized" &&
            isObject(record.current) &&
            validReservePolicyRecord(record.current as JsonRecord) &&
            isObject(record.classHealth) &&
            validHealthSnapshot(record.classHealth as JsonRecord),
          "initialize_reserve_policy.outcome",
        );
        return { ...outcome, kind: "replayed" } as const;
      }
      const existing = await this.loadReservePolicy(client, captured.policy, true);
      if (existing !== null) return { kind: "conflict", current: existing } as const;
      const versionResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
        [captured.policy.classId, captured.policy.contractVersion],
      );
      const versionRow = versionResult.rows[0];
      if (versionRow === undefined) {
        return { kind: "refused", reason: "class_version_not_found" } as const;
      }
      const version = decodeClassVersion(versionRow);
      if (version.state === "retired") {
        return { kind: "refused", reason: "class_version_retired" } as const;
      }
      const healthResult = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1 FOR UPDATE`,
        [captured.policy.classId],
      );
      if (healthResult.rows[0] === undefined) {
        return { kind: "refused", reason: "class_health_missing" } as const;
      }
      if (!this.validReservePolicy(captured.policy)) {
        return { kind: "refused", reason: "invalid_policy" } as const;
      }
      const current: ReservePolicyRecord = {
        revision: 1,
        policy: structuredClone(captured.policy),
        used: 0,
        workerUsage: [],
        updatedAt: captured.at,
      };
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.reserve_policies
           (class_id, contract_version, lane, revision, window_id,
            window_starts_at, window_ends_at, record)
         VALUES ($1, $2, $3, 1, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)
         ON CONFLICT (class_id, contract_version, lane) DO NOTHING`,
        [
          current.policy.classId,
          current.policy.contractVersion,
          current.policy.lane,
          current.policy.windowId,
          current.policy.windowStartsAt,
          current.policy.windowEndsAt,
          JSON.stringify(current),
        ],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      await client.query(
        `INSERT INTO ${this.quotedSchema}.reserve_window_history
           (class_id, contract_version, lane, window_id)
         VALUES ($1, $2, $3, $4)`,
        [
          current.policy.classId,
          current.policy.contractVersion,
          current.policy.lane,
          current.policy.windowId,
        ],
      );
      const classHealth = await this.publishReserveHealth(
        client,
        current.policy.classId,
        captured.at,
      );
      const outcome = { kind: "initialized" as const, current, classHealth };
      await this.writeReplay(
        client,
        "initialize_reserve_policy",
        key,
        fingerprint,
        outcome,
      );
      return outcome;
    });
  }

  async transitionReservePolicy(
    input: Parameters<Store["transitionReservePolicy"]>[0],
  ): ReturnType<Store["transitionReservePolicy"]> {
    return this.transact(input, async (client, captured) => {
      const replayKey = commandFingerprint({
        expected: captured.expected,
        next: captured.next,
      });
      const replay = await this.readReplay<{
        readonly kind: "applied";
        readonly current: ReservePolicyRecord;
        readonly classHealth: ClassHealthSnapshot;
      }>(
        client,
        "transition_reserve_policy",
        replayKey,
        replayKey,
        validOutcome("applied"),
      );
      if (replay !== null) return { ...replay, kind: "replayed" } as const;
      const current = await this.loadReservePolicy(
        client,
        captured.expected.policy,
        true,
      );
      if (current === null) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "reserve policy is missing",
        );
      }
      if (!equal(current, captured.expected)) {
        return { kind: "conflict", current } as const;
      }
      const versionResult = await client.query<RecordRow>(
        `SELECT record FROM ${this.quotedSchema}.class_versions
          WHERE class_id = $1 AND contract_version = $2 FOR UPDATE`,
        [captured.next.classId, captured.next.contractVersion],
      );
      const versionRow = versionResult.rows[0];
      if (versionRow !== undefined && decodeClassVersion(versionRow).state === "retired") {
        return { kind: "refused", reason: "class_version_retired" } as const;
      }
      const health = await client.query(
        `SELECT 1 FROM ${this.quotedSchema}.class_health
          WHERE class_id = $1 FOR UPDATE`,
        [captured.next.classId],
      );
      if (health.rows[0] === undefined) {
        return { kind: "refused", reason: "class_health_missing" } as const;
      }
      const sameKey = captured.next.classId === current.policy.classId &&
        captured.next.contractVersion === current.policy.contractVersion &&
        captured.next.lane === current.policy.lane;
      if (!sameKey || !this.validReservePolicy(captured.next)) {
        return { kind: "refused", reason: "invalid_policy" } as const;
      }
      const sameWindow = captured.next.windowId === current.policy.windowId;
      if (sameWindow &&
          (captured.next.windowStartsAt !== current.policy.windowStartsAt ||
            captured.next.windowEndsAt !== current.policy.windowEndsAt)) {
        return { kind: "refused", reason: "window_not_forward" } as const;
      }
      if (!sameWindow) {
        const reused = await client.query(
          `SELECT 1 FROM ${this.quotedSchema}.reserve_window_history
            WHERE class_id = $1 AND contract_version = $2 AND lane = $3
              AND window_id = $4 FOR UPDATE`,
          [
            captured.next.classId,
            captured.next.contractVersion,
            captured.next.lane,
            captured.next.windowId,
          ],
        );
        if (reused.rows[0] !== undefined ||
            Date.parse(captured.next.windowStartsAt) <
              Date.parse(current.policy.windowEndsAt)) {
          return { kind: "refused", reason: "window_not_forward" } as const;
        }
      }
      const next: ReservePolicyRecord = {
        revision: current.revision + 1,
        policy: structuredClone(captured.next),
        used: sameWindow ? current.used : 0,
        workerUsage: sameWindow ? structuredClone(current.workerUsage) : [],
        updatedAt: captured.at,
      };
      const updated = await client.query(
        `UPDATE ${this.quotedSchema}.reserve_policies
            SET revision = $4, window_id = $5,
                window_starts_at = $6::timestamptz,
                window_ends_at = $7::timestamptz, record = $8::jsonb
          WHERE class_id = $1 AND contract_version = $2 AND lane = $3
            AND revision = $9`,
        [
          next.policy.classId,
          next.policy.contractVersion,
          next.policy.lane,
          next.revision,
          next.policy.windowId,
          next.policy.windowStartsAt,
          next.policy.windowEndsAt,
          JSON.stringify(next),
          current.revision,
        ],
      );
      if (updated.rowCount !== 1) restartSerializableTransaction();
      if (!sameWindow) {
        await client.query(
          `INSERT INTO ${this.quotedSchema}.reserve_window_history
             (class_id, contract_version, lane, window_id)
           VALUES ($1, $2, $3, $4)`,
          [next.policy.classId, next.policy.contractVersion, next.policy.lane,
            next.policy.windowId],
        );
      }
      const classHealth = await this.publishReserveHealth(
        client,
        next.policy.classId,
        captured.at,
      );
      const outcome = { kind: "applied" as const, current: next, classHealth };
      await this.writeReplay(
        client,
        "transition_reserve_policy",
        replayKey,
        replayKey,
        outcome,
      );
      return outcome;
    });
  }

  async chargeReserve(
    charge: Parameters<Store["chargeReserve"]>[0],
  ): ReturnType<Store["chargeReserve"]> {
    return this.transact(charge, (client, captured) =>
      this.settleReserve(client, captured));
  }

  async appendLedger(
    entry: Parameters<Store["appendLedger"]>[0],
  ): ReturnType<Store["appendLedger"]> {
    if (!validLedgerEntry(entry)) {
      return { kind: "refused", reason: "invalid_entry" };
    }
    if (entry.privacy === "sensitive" &&
        (entry.body !== undefined || entry.descriptors !== undefined)) {
      return { kind: "refused", reason: "privacy_violation" };
    }
    return this.transact(entry, async (client, captured) => {
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.ledger_entries
           (recorded_at, class_id, kind, privacy, record)
         VALUES ($1::timestamptz, $2, $3, $4, $5::jsonb)`,
        [
          captured.at,
          captured.classId ?? null,
          captured.kind,
          captured.privacy,
          JSON.stringify(captured),
        ],
      );
      if (inserted.rowCount !== 1) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "ledger append did not persist exactly one row",
        );
      }
      return { kind: "recorded" as const };
    });
  }

  listLedger(
    input: Parameters<Store["listLedger"]>[0] = {},
  ): ReturnType<Store["listLedger"]> {
    const captured = snapshotCommandInput(input);
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<LedgerRow>(
        `SELECT recorded_at::text, class_id, kind, privacy, record
           FROM ${this.quotedSchema}.ledger_entries
          WHERE ($1::text IS NULL OR class_id = $1)
            AND ($2::text IS NULL OR kind = $2)
          ORDER BY ledger_sequence`,
        [captured.classId ?? null, captured.kind ?? null],
      );
      return result.rows.map(decodeLedgerRow);
    });
  }

  async recordReputationEvidence(
    record: Parameters<Store["recordReputationEvidence"]>[0],
  ): ReturnType<Store["recordReputationEvidence"]> {
    if (!isObject(record) ||
        !validReputationEvidence(record as unknown as JsonRecord)) {
      throw new PostgresInfrastructureError(
        "invalid_stored_value",
        "reputation evidence has an unknown or invalid shape",
      );
    }
    return this.transact(record, async (client, captured) => {
      const existingResult = await client.query<ReputationEvidenceRow>(
        `SELECT evidence_id, worker_id, source, observed_at::text, record
           FROM ${this.quotedSchema}.reputation_evidence
          WHERE evidence_id = $1 FOR UPDATE`,
        [captured.evidenceId],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow !== undefined) {
        const existing = decodeReputationEvidenceRow(existingRow);
        return equal(existing, captured)
          ? { kind: "replayed" as const, record: existing }
          : { kind: "conflict" as const, existing };
      }

      const identityResult = await client.query<{ readonly identity_kind: unknown }>(
        `SELECT identity_kind FROM ${this.quotedSchema}.core_identities
          WHERE identity_id = $1 FOR UPDATE`,
        [captured.evidenceId],
      );
      if (identityResult.rows[0] !== undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          `reputation evidence identity ${captured.evidenceId} is already owned`,
        );
      }
      const identity = await client.query(
        `INSERT INTO ${this.quotedSchema}.core_identities
           (identity_id, identity_kind)
         VALUES ($1, 'reputation_evidence')
         ON CONFLICT (identity_id) DO NOTHING`,
        [captured.evidenceId],
      );
      if (identity.rowCount !== 1) restartSerializableTransaction();
      const inserted = await client.query(
        `INSERT INTO ${this.quotedSchema}.reputation_evidence
           (evidence_id, worker_id, source, observed_at, record)
         VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)`,
        [
          captured.evidenceId,
          captured.workerId,
          captured.source,
          captured.at,
          JSON.stringify(captured),
        ],
      );
      if (inserted.rowCount !== 1) restartSerializableTransaction();
      const persisted = structuredClone(captured) as ReputationEvidenceRecord;
      return { kind: "recorded" as const, record: persisted };
    });
  }

  async listReputationEvidence(
    workerId: Parameters<Store["listReputationEvidence"]>[0],
  ): ReturnType<Store["listReputationEvidence"]> {
    const captured = snapshotCommandInput(workerId);
    return withPoolClient(this.#pool, async (client) => {
      const result = await client.query<ReputationEvidenceRow>(
        `SELECT evidence_id, worker_id, source, observed_at::text, record
           FROM ${this.quotedSchema}.reputation_evidence
          WHERE worker_id = $1
          ORDER BY observed_at, evidence_id COLLATE "C"`,
        [captured],
      );
      return result.rows.map(decodeReputationEvidenceRow).sort((left, right) =>
        compareWireIds(left.at, right.at) ||
        compareWireIds(left.evidenceId, right.evidenceId)
      );
    });
  }
}
