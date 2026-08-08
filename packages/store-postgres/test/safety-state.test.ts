import {
  runTask6StoreConformance,
  TASK8_STORE_CONFORMANCE_CASES,
} from "@kuindji/muster-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  bootstrapMusterPostgres,
  migrateMusterPostgres,
  PostgresStore,
} from "../src/index.js";
import {
  startPostgresHarness,
  type PostgresTestHarness,
} from "./postgres-harness.js";

const NOW = "2026-08-08T08:00:00.000Z";
const selectedIds = new Set([
  "reserve-policy-change-race-fails-closed",
  "reserve-last-unit-race-fails-closed",
  "pending-backlog-preserves-opened-at",
  "queue-class-precedence-atomic",
  "health-refresh-load-race-fails-closed",
  "emergency-new-class-race-fails-closed",
  "health-refresh-version-race-fails-closed",
]);
const selectedCases = TASK8_STORE_CONFORMANCE_CASES.filter(({ id }) =>
  selectedIds.has(id)
);
if (selectedCases.length !== selectedIds.size) {
  throw new Error("PostgreSQL Task-6 conformance selection is incomplete");
}

describe("PostgreSQL reserve and adjudication safety slice", () => {
  let harness: PostgresTestHarness;
  const schemas: string[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    for (const schema of schemas) await harness.dropSchema(schema);
    await harness.stop();
  });

  const createStore = async (): Promise<PostgresStore> => {
    const schema = await harness.createSchema();
    schemas.push(schema);
    await migrateMusterPostgres({ pool: harness.pool, schema });
    await bootstrapMusterPostgres({
      pool: harness.pool,
      schema,
      initialQueue: { mode: "normal", updatedAt: NOW },
    });
    return new PostgresStore({ pool: harness.pool, schema });
  };

  it.each(selectedCases)("passes frozen case $id", async (testCase) => {
    await testCase.run(createStore);
  });

  it("passes the complete cumulative Task-6 Store conformance runner", async () => {
    await runTask6StoreConformance(createStore);
  });
});
