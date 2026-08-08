import type {
  ClassHealthSnapshot,
  ClassVersionRecord,
  ContractTransitionOutcome,
  InitializeClassHealthOutcome,
  JobCycleAttemptSnapshot,
  LeaseRecord,
  OperationalTransitionOutcome,
  PermitEpochTransitionOutcome,
  QueueModeSnapshot,
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
    isString(record.permitEpoch) && typeof record.open === "boolean";
}

function validAttemptSnapshot(record: JsonRecord): boolean {
  return isNonNegativeSafeInteger(record.attemptCount) &&
    Array.isArray(record.openLeaseIds) && record.openLeaseIds.every(isString) &&
    Array.isArray(record.acceptedWorkerIds) &&
    record.acceptedWorkerIds.every(isString) &&
    Array.isArray(record.acceptedDiversity) &&
    typeof record.splitObserved === "boolean";
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
 * shutdown. Task 3 implements only control-plane state; later plan slices are
 * explicit infrastructure stubs so the class is already Store-assignable.
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

  readonly enqueueJob = notImplemented<Store["enqueueJob"]>("enqueueJob");
  readonly getJob = notImplemented<Store["getJob"]>("getJob");
  readonly getPayload = notImplemented<Store["getPayload"]>("getPayload");
  readonly listLeaseCandidates = notImplemented<Store["listLeaseCandidates"]>("listLeaseCandidates");
  readonly compareAndClaimLease = notImplemented<Store["compareAndClaimLease"]>("compareAndClaimLease");
  readonly recordNoWorkAttempt = notImplemented<Store["recordNoWorkAttempt"]>("recordNoWorkAttempt");
  readonly getLease = notImplemented<Store["getLease"]>("getLease");
  readonly extendLease = notImplemented<Store["extendLease"]>("extendLease");
  readonly abandonLease = notImplemented<Store["abandonLease"]>("abandonLease");
  readonly expireAndRequeue = notImplemented<Store["expireAndRequeue"]>("expireAndRequeue");
  readonly acceptOrReplaySubmission = notImplemented<Store["acceptOrReplaySubmission"]>("acceptOrReplaySubmission");
  readonly rejectSubmission = notImplemented<Store["rejectSubmission"]>("rejectSubmission");
  readonly getAcceptedSubmission = notImplemented<Store["getAcceptedSubmission"]>("getAcceptedSubmission");
  readonly listAcceptedReplicas = notImplemented<Store["listAcceptedReplicas"]>("listAcceptedReplicas");
  readonly getResultState = notImplemented<Store["getResultState"]>("getResultState");
  readonly markResultSplit = notImplemented<Store["markResultSplit"]>("markResultSplit");
  readonly transitionResult = notImplemented<Store["transitionResult"]>("transitionResult");
  readonly recordDecisionResult = notImplemented<Store["recordDecisionResult"]>("recordDecisionResult");
  readonly getDecisionResult = notImplemented<Store["getDecisionResult"]>("getDecisionResult");
  readonly inspectAuthorizationContext = notImplemented<Store["inspectAuthorizationContext"]>("inspectAuthorizationContext");
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
  readonly listReputationEvidence = notImplemented<Store["listReputationEvidence"]>("listReputationEvidence");
}
