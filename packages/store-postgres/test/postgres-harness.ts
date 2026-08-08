import { randomUUID } from "node:crypto";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { quoteSchemaName, validateSchemaName } from "../src/config.js";

const TEST_CONNECTION_URL_ENV = "MUSTER_POSTGRES_TEST_URL";

export interface PostgresTestHarness {
  readonly pool: Pool;
  readonly source: "external" | "testcontainers";
  createSchema(): Promise<string>;
  dropSchema(schema: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start once in beforeAll for a test file. Each future StoreFactory receives a
 * separately allocated schema and may drop only that validated schema.
 */
export async function startPostgresHarness(): Promise<PostgresTestHarness> {
  const explicitConnectionUrl = process.env[TEST_CONNECTION_URL_ENV];
  let container: StartedPostgreSqlContainer | undefined;
  let connectionString: string;

  if (explicitConnectionUrl === undefined || explicitConnectionUrl === "") {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    connectionString = container.getConnectionUri();
  } else {
    connectionString = explicitConnectionUrl;
  }

  const pool = new Pool({ connectionString, max: 12 });
  let stopped = false;

  return {
    pool,
    source: container === undefined ? "external" : "testcontainers",
    async createSchema(): Promise<string> {
      const schema = validateSchemaName(
        `muster_test_${randomUUID().replaceAll("-", "")}`,
      );
      await pool.query(`CREATE SCHEMA ${quoteSchemaName(schema)}`);
      return schema;
    },
    async dropSchema(schema: string): Promise<void> {
      await pool.query(`DROP SCHEMA ${quoteSchemaName(schema)} CASCADE`);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await pool.end();
      await container?.stop();
    },
  };
}
