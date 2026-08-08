import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  InMemoryStoreOptions,
  QueueModeSnapshot,
} from "@kuindji/muster-core";
import type { PostgresStoreOptions, QueryableClient } from "./config.js";
import { validatePostgresStoreOptions } from "./config.js";
import {
  commandFingerprint,
  decodePositiveRevision,
  decodeStoredRecord,
  snapshotCommandInput,
  type JsonValue,
} from "./codecs.js";
import { PostgresInfrastructureError } from "./errors.js";
import {
  withPoolClient,
  withSerializableTransaction,
} from "./transactions.js";

export interface MigrateMusterPostgresOptions extends PostgresStoreOptions {}

export interface BootstrapMusterPostgresOptions extends PostgresStoreOptions {
  readonly initialQueue: InMemoryStoreOptions["initialQueue"];
}

export interface MusterPostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export const MUSTER_POSTGRES_MIGRATIONS: readonly MusterPostgresMigration[] =
  Object.freeze([
    Object.freeze({
      version: 1,
      name: "0001_initial.sql",
      checksum: "d6ca933080ad050bbe8e263c3be59f49068e5eb8f410d231cea642a43b226dde",
    }),
    Object.freeze({
      version: 2,
      name: "0002_invalidation_scope_indexes.sql",
      checksum: "aa38e34715561746a03310004ebfbc2e262e6d36c40359c229a957cce78cb5cc",
    }),
  ]);

export interface MigrateMusterPostgresOutcome {
  readonly applied: readonly string[];
}

export type BootstrapMusterPostgresOutcome =
  | { readonly kind: "created" | "replayed"; readonly queue: QueueModeSnapshot }
  | { readonly kind: "conflict"; readonly current: QueueModeSnapshot };

const migrationAssetPath = (name: string): string =>
  resolve(__dirname, "..", "migrations", name);

async function verifyPackagedManifest(): Promise<void> {
  let text: string;
  try {
    text = await readFile(migrationAssetPath("manifest.json"), "utf8");
  } catch (cause) {
    throw new PostgresInfrastructureError(
      "migration_asset_missing",
      "missing packaged PostgreSQL migration manifest",
      { cause },
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    throw new PostgresInfrastructureError(
      "migration_checksum_mismatch",
      "packaged PostgreSQL migration manifest is invalid JSON",
      { cause },
    );
  }
  if (JSON.stringify(manifest) !== JSON.stringify(MUSTER_POSTGRES_MIGRATIONS)) {
    throw new PostgresInfrastructureError(
      "migration_checksum_mismatch",
      "packaged PostgreSQL migration manifest does not match the compiled manifest",
    );
  }
}

async function loadMigration(
  migration: MusterPostgresMigration,
): Promise<string> {
  let sql: string;
  try {
    sql = await readFile(migrationAssetPath(migration.name), "utf8");
  } catch (cause) {
    throw new PostgresInfrastructureError(
      "migration_asset_missing",
      `missing packaged PostgreSQL migration ${migration.name}`,
      { cause },
    );
  }
  const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
  if (checksum !== migration.checksum) {
    throw new PostgresInfrastructureError(
      "migration_checksum_mismatch",
      `packaged PostgreSQL migration checksum mismatch for ${migration.name}`,
    );
  }
  return sql;
}

function migrationLedgerSql(quotedSchema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${quotedSchema}.muster_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    name text COLLATE "C" NOT NULL UNIQUE,
    checksum text COLLATE "C" NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`;
}

async function requireUtf8(client: QueryableClient): Promise<void> {
  const result = await client.query<{ server_encoding: string }>(
    "SELECT current_setting('server_encoding') AS server_encoding",
  );
  if (result.rows[0]?.server_encoding !== "UTF8") {
    throw new PostgresInfrastructureError(
      "invalid_database_encoding",
      "Muster PostgreSQL requires a UTF-8 database",
    );
  }
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function verifyAppliedMigrations(rows: readonly AppliedMigrationRow[]): void {
  const known = new Map(
    MUSTER_POSTGRES_MIGRATIONS.map((migration) => [migration.version, migration]),
  );
  for (const row of rows) {
    const migration = known.get(row.version);
    if (migration === undefined || migration.name !== row.name) {
      throw new PostgresInfrastructureError(
        "migration_unknown",
        `database contains unknown PostgreSQL migration ${row.version}:${row.name}`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new PostgresInfrastructureError(
        "migration_checksum_mismatch",
        `database checksum mismatch for PostgreSQL migration ${row.name}`,
      );
    }
  }
}

/** Apply the complete ordered migration set under one schema-qualified lock. */
export async function migrateMusterPostgres(
  options: MigrateMusterPostgresOptions,
): Promise<MigrateMusterPostgresOutcome> {
  const validated = validatePostgresStoreOptions(options);
  await verifyPackagedManifest();
  const assets = await Promise.all(
    MUSTER_POSTGRES_MIGRATIONS.map(async (migration) => ({
      migration,
      sql: await loadMigration(migration),
    })),
  );

  return withPoolClient(validated.pool, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${validated.transaction.lockTimeoutMs}ms`,
      ]);
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${validated.transaction.statementTimeoutMs}ms`,
      ]);
      await requireUtf8(client);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`muster:migrations:${validated.schema}`],
      );
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${validated.quotedSchema}`);
      await client.query(migrationLedgerSql(validated.quotedSchema));

      const appliedResult = await client.query<AppliedMigrationRow>(
        `SELECT version, name, checksum
           FROM ${validated.quotedSchema}.muster_migrations
          ORDER BY version`,
      );
      verifyAppliedMigrations(appliedResult.rows);
      const appliedVersions = new Set(appliedResult.rows.map((row) => row.version));
      const applied: string[] = [];

      for (const asset of assets) {
        if (appliedVersions.has(asset.migration.version)) continue;
        const rendered = asset.sql.replaceAll("{{schema}}", validated.quotedSchema);
        if (rendered.includes("{{schema}}")) {
          throw new PostgresInfrastructureError(
            "migration_failed",
            `unresolved schema placeholder in ${asset.migration.name}`,
          );
        }
        await client.query(rendered);
        await client.query(
          `INSERT INTO ${validated.quotedSchema}.muster_migrations
             (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [asset.migration.version, asset.migration.name, asset.migration.checksum],
        );
        applied.push(asset.migration.name);
      }

      await client.query("COMMIT");
      return Object.freeze({ applied: Object.freeze(applied) });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the migration error; pg discards a broken connection.
      }
      if (error instanceof PostgresInfrastructureError) throw error;
      throw new PostgresInfrastructureError(
        "migration_failed",
        "failed to migrate Muster PostgreSQL schema",
        { cause: error },
      );
    }
  });
}

const queueModes = new Set(["normal", "degraded", "admission_halted", "emergency_halted"]);
const queueCauses = new Set(["bootstrap", "capacity", "sla", "pool_offline", "operator", "emergency"]);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const validTimestamp = (value: string): boolean =>
  timestampPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function validateInitialQueue(
  initialQueue: InMemoryStoreOptions["initialQueue"],
): Readonly<QueueModeSnapshot> {
  if (initialQueue === null || typeof initialQueue !== "object") {
    throw new PostgresInfrastructureError(
      "invalid_configuration",
      "initialQueue must be an object",
    );
  }
  const mode = initialQueue.mode;
  const cause = initialQueue.cause ?? "bootstrap";
  if (!queueModes.has(mode) || !queueCauses.has(cause)) {
    throw new PostgresInfrastructureError(
      "invalid_configuration",
      "initialQueue contains an unknown mode or cause",
    );
  }
  if (
    typeof initialQueue.updatedAt !== "string" ||
    !validTimestamp(initialQueue.updatedAt)
  ) {
    throw new PostgresInfrastructureError(
      "invalid_configuration",
      "initialQueue.updatedAt must be an ISO 8601 UTC timestamp with milliseconds",
    );
  }
  return snapshotCommandInput({
    revision: 1,
    mode,
    cause,
    updatedAt: initialQueue.updatedAt,
  });
}

function isQueueModeSnapshot(
  record: Readonly<Record<string, JsonValue>>,
): boolean {
  return decodePositiveRevision(record.revision) >= 1 &&
    typeof record.mode === "string" && queueModes.has(record.mode) &&
    typeof record.cause === "string" && queueCauses.has(record.cause) &&
    typeof record.updatedAt === "string" && validTimestamp(record.updatedAt);
}

interface QueueRow {
  readonly revision: string;
  readonly record: unknown;
  readonly bootstrap_fingerprint: string;
}

function decodeQueue(row: QueueRow): QueueModeSnapshot {
  const record = decodeStoredRecord<QueueModeSnapshot>(
    row.record,
    isQueueModeSnapshot,
    "queue_state.record",
  );
  const revision = decodePositiveRevision(row.revision, "queue_state.revision");
  if (record.revision !== revision) {
    throw new PostgresInfrastructureError(
      "invalid_stored_value",
      "queue_state revision projection does not match its record",
    );
  }
  return record;
}

/** Install the deployment-owned initial queue exactly once. */
export async function bootstrapMusterPostgres(
  options: BootstrapMusterPostgresOptions,
): Promise<BootstrapMusterPostgresOutcome> {
  const validated = validatePostgresStoreOptions(options);
  const initial = validateInitialQueue(options.initialQueue);
  const fingerprint = commandFingerprint(initial);

  return withSerializableTransaction({
    pool: validated.pool,
    options: validated.transaction,
    input: { initial, fingerprint },
    operation: async (client, captured) => {
      const inserted = await client.query(
        `INSERT INTO ${validated.quotedSchema}.queue_state
           (singleton, revision, mode, cause, updated_at, record, bootstrap_fingerprint)
         VALUES (true, 1, $1, $2, $3::timestamptz, $4::jsonb, $5)
         ON CONFLICT (singleton) DO NOTHING`,
        [
          captured.initial.mode,
          captured.initial.cause,
          captured.initial.updatedAt,
          JSON.stringify(captured.initial),
          captured.fingerprint,
        ],
      );
      const currentResult = await client.query<QueueRow>(
        `SELECT revision, record, bootstrap_fingerprint
           FROM ${validated.quotedSchema}.queue_state
          WHERE singleton = true`,
      );
      const row = currentResult.rows[0];
      if (row === undefined) {
        throw new PostgresInfrastructureError(
          "invalid_stored_value",
          "queue bootstrap did not produce a singleton row",
        );
      }
      const queue = decodeQueue(row);
      if (inserted.rowCount === 1) return { kind: "created", queue } as const;
      return row.bootstrap_fingerprint === captured.fingerprint
        ? { kind: "replayed", queue } as const
        : { kind: "conflict", current: queue } as const;
    },
  });
}
