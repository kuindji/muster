import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startPostgresHarness,
  type PostgresTestHarness,
} from "./postgres-harness.js";

describe("PostgreSQL compatibility harness", () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("uses UTF-8 and isolates each allocated Store schema", async () => {
    const encoding = await harness.pool.query<{ server_encoding: string }>(
      "SELECT current_setting('server_encoding') AS server_encoding",
    );
    expect(encoding.rows).toEqual([{ server_encoding: "UTF8" }]);

    const first = await harness.createSchema();
    const second = await harness.createSchema();
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);

    await harness.dropSchema(first);
    await harness.dropSchema(second);
  });
});
