import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MUSTER_POSTGRES_SCHEMA,
  MAX_TRANSACTION_ATTEMPTS,
  PostgresInfrastructureError,
  PostgresStore,
  quoteSchemaName,
  validatePostgresStoreOptions,
  validateSchemaName,
  type QueryablePool,
} from "../src/index.js";

const pool = (): QueryablePool => ({
  connect: vi.fn(),
});

describe("PostgreSQL adapter configuration", () => {
  it("defaults to the validated muster schema", () => {
    const store = new PostgresStore({ pool: pool() });
    expect(store.schema).toBe(DEFAULT_MUSTER_POSTGRES_SCHEMA);
    expect(store.quotedSchema).toBe('"muster"');
  });

  it.each([
    "",
    "Muster",
    "1muster",
    "muster-test",
    "muster.test",
    "muster test",
    'muster"test',
    "é",
  ])("rejects unsafe schema name %j", (schema) => {
    expect(() => validateSchemaName(schema)).toThrow(
      PostgresInfrastructureError,
    );
  });

  it("accepts 63 ASCII bytes and rejects the anti-truncation boundary", () => {
    const sixtyThree = `_${"a".repeat(62)}`;
    const sixtyFour = `_${"a".repeat(63)}`;
    expect(validateSchemaName(sixtyThree)).toBe(sixtyThree);
    expect(quoteSchemaName(sixtyThree)).toBe(`"${sixtyThree}"`);
    expect(() => validateSchemaName(sixtyFour)).toThrow(
      PostgresInfrastructureError,
    );
  });

  it("validates positive finite timeouts and a closed attempt maximum", () => {
    for (const lockTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validatePostgresStoreOptions({
          pool: pool(),
          transaction: { lockTimeoutMs },
        }),
      ).toThrow(PostgresInfrastructureError);
    }
    expect(() =>
      validatePostgresStoreOptions({
        pool: pool(),
        transaction: { maxAttempts: MAX_TRANSACTION_ATTEMPTS + 1 },
      }),
    ).toThrow(PostgresInfrastructureError);
  });

  it("retains caller ownership of pool shutdown", () => {
    const end = vi.fn();
    const callerPool = { connect: vi.fn(), end };
    const store = new PostgresStore({ pool: callerPool });
    expect(store.schema).toBe("muster");
    expect(end).not.toHaveBeenCalled();
  });
});
