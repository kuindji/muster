import { readFileSync } from "node:fs";

import {
  runTask8StoreConformance,
  runTask9ProtocolConformance,
  type ProtocolConformanceFixturePack,
  type ProtocolPromptInjectionFixture,
  type ProtocolSchemaFixture,
  type Store,
} from "@kuindji/muster-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapMusterPostgres,
  migrateMusterPostgres,
  PostgresStore,
} from "../src/index.js";
import {
  startPostgresHarness,
  type PostgresTestHarness,
} from "./postgres-harness.js";

const NOW = "2026-08-08T10:00:00.000Z";

const schemas = JSON.parse(
  readFileSync(
    new URL("../../contract/fixtures/schema-conformance.json", import.meta.url),
    "utf8",
  ),
) as { schemas: ProtocolSchemaFixture[] };

const promptInjections = JSON.parse(
  readFileSync(
    new URL("../../contract/fixtures/prompt-injection.json", import.meta.url),
    "utf8",
  ),
) as ProtocolPromptInjectionFixture[];

const fixtures: ProtocolConformanceFixturePack = {
  schemas: schemas.schemas,
  promptInjections,
};

describe("PostgreSQL public protocol and restart conformance", () => {
  let harness: PostgresTestHarness;
  const allocatedSchemas: string[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    for (const schema of allocatedSchemas) await harness.dropSchema(schema);
    await harness.stop();
  });

  const createRestartingStore = async (): Promise<Store> => {
    const schema = await harness.createSchema();
    allocatedSchemas.push(schema);
    await migrateMusterPostgres({ pool: harness.pool, schema });
    await bootstrapMusterPostgres({
      pool: harness.pool,
      schema,
      initialQueue: { mode: "normal", updatedAt: NOW },
    });

    return new Proxy({} as Store, {
      get: (_target, property) => {
        if (property === "then") return undefined;
        return (...arguments_: unknown[]) => {
          const restarted = new PostgresStore({ pool: harness.pool, schema });
          const method = Reflect.get(restarted, property) as unknown;
          if (typeof method !== "function") {
            throw new TypeError(`PostgresStore.${String(property)} is not callable`);
          }
          return Reflect.apply(method, restarted, arguments_);
        };
      },
    });
  };

  it("passes Store and published-fixture protocol suites across adapter restarts", async () => {
    const storeCases = await runTask8StoreConformance(createRestartingStore);
    const protocolCases = await runTask9ProtocolConformance(
      createRestartingStore,
      fixtures,
    );

    expect(storeCases.length).toBeGreaterThan(0);
    expect(protocolCases.length).toBeGreaterThan(0);
  }, 120_000);
});
