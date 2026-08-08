import type { QueryableClient, QueryablePool } from "./config.js";
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
