import type { PoolClient } from "pg";
import { PostgresInfrastructureError } from "./errors.js";

export const DEFAULT_MUSTER_POSTGRES_SCHEMA = "muster";
export const MAX_TRANSACTION_ATTEMPTS = 8;
export const MAX_POSTGRES_TIMEOUT_MS = 2_147_483_647;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export type QueryableClient = Pick<PoolClient, "query" | "release">;

/** The adapter borrows clients but never owns or closes the caller's pool. */
export interface QueryablePool {
  connect(): Promise<QueryableClient>;
}

export interface TransactionOptions {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly maxAttempts: number;
}

export interface PostgresStoreOptions {
  readonly pool: QueryablePool;
  readonly schema?: string;
  readonly transaction?: Partial<TransactionOptions>;
}

export interface ValidatedPostgresStoreOptions {
  readonly pool: QueryablePool;
  readonly schema: string;
  readonly quotedSchema: string;
  readonly transaction: Readonly<TransactionOptions>;
}

const DEFAULT_TRANSACTION_OPTIONS: TransactionOptions = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
  maxAttempts: 3,
};

const invalidConfiguration = (message: string): never => {
  throw new PostgresInfrastructureError("invalid_configuration", message);
};

export function validateSchemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    return invalidConfiguration(
      "PostgreSQL schema must match ^[a-z_][a-z0-9_]{0,62}$",
    );
  }
  return schema;
}

/** Quote only after validation; dynamic values must never reach this helper. */
export function quoteSchemaName(schema: string): string {
  return `"${validateSchemaName(schema)}"`;
}

function validateTimeout(name: string, value: number): number {
  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_POSTGRES_TIMEOUT_MS
  ) {
    return invalidConfiguration(
      `${name} must be a positive safe integer no greater than ${MAX_POSTGRES_TIMEOUT_MS}`,
    );
  }
  return value;
}

function validateMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRANSACTION_ATTEMPTS) {
    return invalidConfiguration(
      `maxAttempts must be an integer from 1 through ${MAX_TRANSACTION_ATTEMPTS}`,
    );
  }
  return value;
}

export function validatePostgresStoreOptions(
  options: PostgresStoreOptions,
): ValidatedPostgresStoreOptions {
  if (options === null || typeof options !== "object" || options.pool === undefined) {
    return invalidConfiguration("a caller-owned PostgreSQL pool is required");
  }
  if (typeof options.pool.connect !== "function") {
    return invalidConfiguration("pool.connect must be a function");
  }

  const schema = validateSchemaName(
    options.schema ?? DEFAULT_MUSTER_POSTGRES_SCHEMA,
  );
  const transaction = options.transaction ?? {};
  const lockTimeoutMs = validateTimeout(
    "lockTimeoutMs",
    transaction.lockTimeoutMs ?? DEFAULT_TRANSACTION_OPTIONS.lockTimeoutMs,
  );
  const statementTimeoutMs = validateTimeout(
    "statementTimeoutMs",
    transaction.statementTimeoutMs ??
      DEFAULT_TRANSACTION_OPTIONS.statementTimeoutMs,
  );
  const maxAttempts = validateMaxAttempts(
    transaction.maxAttempts ?? DEFAULT_TRANSACTION_OPTIONS.maxAttempts,
  );

  return Object.freeze({
    pool: options.pool,
    schema,
    quotedSchema: quoteSchemaName(schema),
    transaction: Object.freeze({
      lockTimeoutMs,
      statementTimeoutMs,
      maxAttempts,
    }),
  });
}
