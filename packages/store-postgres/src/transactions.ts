import type {
  QueryableClient,
  QueryablePool,
  TransactionOptions,
} from "./config.js";
import { snapshotCommandInput } from "./codecs.js";
import { PostgresInfrastructureError } from "./errors.js";

/** Acquire exactly one client for an adapter operation and always release it. */
export async function withPoolClient<T>(
  pool: QueryablePool,
  operation: (client: QueryableClient) => Promise<T>,
): Promise<T> {
  let client: QueryableClient;
  try {
    client = await pool.connect();
  } catch (cause) {
    throw new PostgresInfrastructureError(
      "connection_failed",
      "failed to acquire a PostgreSQL pool client",
      { cause },
    );
  }

  let operationFailed = false;
  try {
    return await operation(client);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      client.release();
    } catch (cause) {
      if (!operationFailed) {
        throw new PostgresInfrastructureError(
          "client_release_failed",
          "failed to release a PostgreSQL pool client",
          { cause },
        );
      }
    }
  }
}

interface PostgresErrorLike {
  readonly code?: unknown;
}

const retryableSqlStates = new Set(["40001", "40P01"]);
const expectedConstraintSqlStates = new Set(["23505", "23P01"]);

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as PostgresErrorLike).code;
  return typeof code === "string" ? code : undefined;
}

export interface SerializableTransactionInput<Input> {
  readonly pool: QueryablePool;
  readonly options: Readonly<TransactionOptions>;
  readonly input: Input;
  readonly operation: (
    client: QueryableClient,
    input: Readonly<Input>,
  ) => Promise<unknown>;
}

/**
 * Run one immutable command snapshot in a short serializable transaction.
 * Only serialization aborts and deadlocks restart the internal adapter closure.
 */
export function withSerializableTransaction<Input, Output>(
  request: Omit<SerializableTransactionInput<Input>, "operation"> & {
    readonly operation: (
      client: QueryableClient,
      input: Readonly<Input>,
    ) => Promise<Output>;
  },
): Promise<Output> {
  const captured = snapshotCommandInput(request.input);

  return (async () => {
    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= request.options.maxAttempts; attempt += 1) {
      try {
        return await withPoolClient(request.pool, async (client) => {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          try {
            await client.query("SELECT set_config('lock_timeout', $1, true)", [
              `${request.options.lockTimeoutMs}ms`,
            ]);
            await client.query(
              "SELECT set_config('statement_timeout', $1, true)",
              [`${request.options.statementTimeoutMs}ms`],
            );
            const output = await request.operation(client, captured);
            await client.query("COMMIT");
            return output;
          } catch (error) {
            try {
              await client.query("ROLLBACK");
            } catch {
              // Preserve the command failure; a broken connection is discarded by pg.
            }
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        const code = sqlState(error);
        if (code !== undefined && expectedConstraintSqlStates.has(code)) {
          throw new PostgresInfrastructureError(
            "unexpected_constraint_violation",
            `unexpected PostgreSQL constraint violation ${code}`,
            { cause: error },
          );
        }
        if (code !== undefined && !retryableSqlStates.has(code)) {
          throw new PostgresInfrastructureError(
            "transaction_failed",
            `PostgreSQL transaction failed with SQLSTATE ${code}`,
            { cause: error },
          );
        }
        if (code === undefined) throw error;
        lastRetryableError = error;
      }
    }

    throw new PostgresInfrastructureError(
      "transaction_retry_exhausted",
      `serializable transaction did not commit after ${request.options.maxAttempts} attempts`,
      { cause: lastRetryableError },
    );
  })();
}
