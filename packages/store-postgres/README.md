# @kuindji/muster-store-postgres

Node-only PostgreSQL persistence for the revision-26 Muster `Store` boundary.
The adapter supports PostgreSQL 16 and 18, requires Node.js 20 or newer, and
uses a caller-owned `pg.Pool`. It never reads a connection string, runs a
migration, bootstraps queue state, or closes a pool implicitly.

## Construct the Store

Migration and initial queue installation are explicit deployment steps. Run
both before constructing a Store for application traffic:

```ts
import {
  PostgresStore,
  bootstrapMusterPostgres,
  migrateMusterPostgres,
} from "@kuindji/muster-store-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: deploymentConnectionString });

await migrateMusterPostgres({ pool, schema: "muster" });

const bootstrap = await bootstrapMusterPostgres({
  pool,
  schema: "muster",
  initialQueue: {
    mode: "normal",
    updatedAt: "2026-08-08T12:00:00.000Z",
  },
});

if (bootstrap.kind === "conflict") {
  throw new Error("the deployed queue bootstrap does not match durable state");
}

const store = new PostgresStore({
  pool,
  schema: "muster",
  transaction: {
    lockTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    maxAttempts: 3,
  },
});

// Use `store` while the application is running. After Store traffic stops,
// the process that created the pool remains responsible for shutdown.
await pool.end();
```

The default schema is `muster`. A custom name must match
`^[a-z_][a-z0-9_]{0,62}$`; every object is schema-qualified and the adapter does
not depend on `search_path`. The database must use UTF-8.

Queue bootstrap is create/replay/conflict. It does not use database time or
generate domain state. Treat `conflict` as a deployment configuration error;
do not overwrite the live queue snapshot during startup.

## Transactions and retries

Each Store command borrows one client and runs one short `SERIALIZABLE`
transaction. Defaults are a 5-second lock timeout, a 30-second statement
timeout, and at most three attempts. Timeouts must be positive integer
milliseconds no greater than PostgreSQL's signed 32-bit millisecond limit;
`maxAttempts` may be 1 through 8.

Only SQLSTATE `40001` (serialization failure) and `40P01` (deadlock) restart a
command. Every attempt receives the same detached pre-I/O input snapshot. The
adapter does not retry unique/exclusion violations or reinterpret them as a
domain outcome unless the relevant command handles a named identity race
itself. Exhaustion and infrastructure failures throw
`PostgresInfrastructureError`; they are distinct from frozen Store outcomes.

## Deployment roles

Use separate caller-owned pools or credentials for deployment and runtime:

- The migration role owns, or can create and alter, the target schema and its
  objects. It needs database connectivity and the privileges required by the
  checked-in forward migrations. Only this role should write
  `muster_migrations`.
- A bootstrap deployment role needs the queue-state read/write privileges
  required for the one explicit bootstrap operation. It may be the migration
  role; it does not need to remain available to the running service.
- The runtime role needs `USAGE` on the schema, DML privileges on Muster's
  domain tables, and sequence use for `ledger_entries_ledger_sequence_seq`. It
  should not have schema create/alter/drop privileges or write access to the
  migration ledger.

Grant future migration-created objects deliberately as part of the deployment
runbook; do not rely on broad `public` privileges or a mutable `search_path`.
The package accepts a pool rather than credentials so secret loading, TLS,
rotation, connection limits, and role selection stay deployment-owned.

## Safe rollout and recovery

Migrations are ordered, checksummed, forward-only assets. The migrator takes a
schema-qualified transaction advisory lock, applies DDL and its ledger row in
one transaction, and refuses unknown versions or checksum drift.

For each release:

1. Test the exact package and every checked-in migration prefix against a copy
   of production data on a supported PostgreSQL version.
2. Take and verify a database backup or snapshot using deployment-owned backup
   tooling. This package does not schedule backups or restore them.
3. Quiesce writers when a migration's release notes require it, then run
   `migrateMusterPostgres` once with the migration role. Concurrent migrators
   are safe but unnecessary.
4. Run `bootstrapMusterPostgres` only for a new deployment, or as an exact
   replay check for an existing deployment. Refuse a conflict.
5. Deploy the matching application package and start Store traffic with the
   runtime role. Confirm migration versions, queue state, and error telemetry
   before completing the rollout.

There are no down migrations. Application rollback is safe only while the old
binary is compatible with the newly applied forward schema. Otherwise recover
through the deployment's tested backup/restore procedure.

## Verification

Docker/Testcontainers uses PostgreSQL 16 by default:

```sh
pnpm --filter @kuindji/muster-store-postgres test
pnpm --filter @kuindji/muster-store-postgres test:packed
```

Select PostgreSQL 18 explicitly:

```sh
MUSTER_POSTGRES_TEST_IMAGE=postgres:18-alpine pnpm --filter @kuindji/muster-store-postgres test
MUSTER_POSTGRES_TEST_IMAGE=postgres:18-alpine pnpm --filter @kuindji/muster-store-postgres test:packed
```

For a managed test database, set `MUSTER_POSTGRES_TEST_URL` in the shell or CI
secret store. The harness passes it to `node-postgres` unchanged; include the
required TLS mode in the URL and supply private trust roots through the process
environment. Tests create and remove only randomly named `muster_test_*` or
`muster_pack_*` schemas.
