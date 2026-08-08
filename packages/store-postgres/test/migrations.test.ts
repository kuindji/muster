import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryableClient, QueryablePool } from "../src/config.js";
import {
  bootstrapMusterPostgres,
  migrateMusterPostgres,
  MUSTER_POSTGRES_MIGRATIONS,
} from "../src/migrations.js";
import {
  startPostgresHarness,
  type PostgresTestHarness,
} from "./postgres-harness.js";

const NOW = "2026-08-08T04:00:00.000Z";
const schemaName = (): string =>
  `muster_test_${randomUUID().replaceAll("-", "")}`;

describe("PostgreSQL migrations and bootstrap", () => {
  let harness: PostgresTestHarness;
  const schemas = new Set<string>();

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    for (const schema of schemas) await harness.dropSchema(schema);
    await harness.stop();
  });

  const allocate = (): string => {
    const schema = schemaName();
    schemas.add(schema);
    return schema;
  };

  it("installs every table once and keeps schemas isolated", async () => {
    const first = allocate();
    const second = allocate();
    const [firstResult, secondResult] = await Promise.all([
      migrateMusterPostgres({ pool: harness.pool, schema: first }),
      migrateMusterPostgres({ pool: harness.pool, schema: second }),
    ]);
    expect(firstResult.applied).toEqual(["0001_initial.sql"]);
    expect(secondResult.applied).toEqual(["0001_initial.sql"]);
    await expect(
      migrateMusterPostgres({ pool: harness.pool, schema: first }),
    ).resolves.toEqual({ applied: [] });

    const tables = await harness.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name`,
      [first],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "accepted_submissions",
        "action_adjudications",
        "authorization_status",
        "authorizations",
        "class_health",
        "class_versions",
        "command_replays",
        "jobs",
        "leases",
        "muster_migrations",
        "queue_state",
        "reserve_window_history",
        "verdict_history",
      ]),
    );
  });

  it("serializes same-schema migrators", async () => {
    const schema = allocate();
    const results = await Promise.all([
      migrateMusterPostgres({ pool: harness.pool, schema }),
      migrateMusterPostgres({ pool: harness.pool, schema }),
    ]);
    expect(results.flatMap((result) => result.applied)).toEqual([
      "0001_initial.sql",
    ]);
  });

  it("creates, replays, and conflicts explicit queue bootstrap", async () => {
    const schema = allocate();
    await migrateMusterPostgres({ pool: harness.pool, schema });
    const options = {
      pool: harness.pool,
      schema,
      initialQueue: { mode: "normal" as const, updatedAt: NOW },
    };
    await expect(bootstrapMusterPostgres(options)).resolves.toEqual({
      kind: "created",
      queue: { revision: 1, mode: "normal", cause: "bootstrap", updatedAt: NOW },
    });
    await expect(bootstrapMusterPostgres({
      ...options,
      initialQueue: { ...options.initialQueue, cause: "bootstrap" as const },
    })).resolves.toMatchObject({ kind: "replayed" });
    await expect(bootstrapMusterPostgres({
      ...options,
      initialQueue: { mode: "degraded", cause: "capacity", updatedAt: NOW },
    })).resolves.toMatchObject({
      kind: "conflict",
      current: { revision: 1, mode: "normal", cause: "bootstrap", updatedAt: NOW },
    });
  });

  it("refuses unknown and checksum-drifted applied migrations", async () => {
    const unknownSchema = allocate();
    await migrateMusterPostgres({ pool: harness.pool, schema: unknownSchema });
    await harness.pool.query(
      `INSERT INTO "${unknownSchema}".muster_migrations (version, name, checksum)
       VALUES (999, 'future.sql', $1)`,
      ["a".repeat(64)],
    );
    await expect(
      migrateMusterPostgres({ pool: harness.pool, schema: unknownSchema }),
    ).rejects.toMatchObject({ code: "migration_unknown" });

    const driftSchema = allocate();
    await migrateMusterPostgres({ pool: harness.pool, schema: driftSchema });
    await harness.pool.query(
      `UPDATE "${driftSchema}".muster_migrations SET checksum = $1 WHERE version = 1`,
      ["b".repeat(64)],
    );
    await expect(
      migrateMusterPostgres({ pool: harness.pool, schema: driftSchema }),
    ).rejects.toMatchObject({ code: "migration_checksum_mismatch" });
  });

  it("ships the exact checksummed SQL asset", async () => {
    const migration = MUSTER_POSTGRES_MIGRATIONS[0]!;
    const manifest = JSON.parse(
      await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(manifest).toEqual(MUSTER_POSTGRES_MIGRATIONS);
    const sql = await readFile(
      new URL(`../migrations/${migration.name}`, import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      migration.checksum,
    );
  });
});

describe("migration failure handling", () => {
  const fakeClient = (
    query: QueryableClient["query"],
  ): QueryableClient => ({ query, release: vi.fn() });

  it("rejects non-UTF-8 before creating the schema", async () => {
    const queryMock = vi.fn(async (sql: string) => {
      if (sql.includes("server_encoding")) {
        return { rows: [{ server_encoding: "LATIN1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const query = queryMock as unknown as QueryableClient["query"];
    const pool: QueryablePool = { connect: vi.fn(async () => fakeClient(query)) };

    await expect(migrateMusterPostgres({ pool, schema: "encoding_test" }))
      .rejects.toMatchObject({ code: "invalid_database_encoding" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("CREATE SCHEMA")))
      .toBe(false);
  });

  it("rolls back a failed migration DDL statement", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("server_encoding")) {
        return { rows: [{ server_encoding: "UTF8" }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT version")) return { rows: [], rowCount: 0 };
      if (sql.includes("CREATE TABLE \"ddl_failure\".queue_state")) {
        throw new Error("injected DDL failure");
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as QueryableClient["query"];
    const client = fakeClient(query);
    const pool: QueryablePool = { connect: vi.fn(async () => client) };

    await expect(migrateMusterPostgres({ pool, schema: "ddl_failure" }))
      .rejects.toMatchObject({ code: "migration_failed" });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
