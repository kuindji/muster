import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresInfrastructureError } from "../src/errors.js";
import {
  withPoolClient,
  withSerializableTransaction,
} from "../src/transactions.js";
import type { QueryableClient, QueryablePool } from "../src/config.js";

const clientWith = (release: () => void): QueryableClient =>
  ({ query: vi.fn(), release } as unknown as Pick<
    PoolClient,
    "query" | "release"
  >);

describe("caller-owned pool client lifecycle", () => {
  it("releases the borrowed client after success", async () => {
    const release = vi.fn();
    const client = clientWith(release);
    const pool: QueryablePool = { connect: vi.fn(async () => client) };

    await expect(withPoolClient(pool, async () => "ok")).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the borrowed client and preserves the operation error", async () => {
    const release = vi.fn();
    const client = clientWith(release);
    const pool: QueryablePool = { connect: vi.fn(async () => client) };
    const failure = new Error("operation failed");

    await expect(
      withPoolClient(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
  });

  it("classifies connection and release failures as infrastructure errors", async () => {
    const failedPool: QueryablePool = {
      connect: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    await expect(withPoolClient(failedPool, async () => undefined)).rejects
      .toMatchObject({ code: "connection_failed" });

    const releasePool: QueryablePool = {
      connect: vi.fn(async () =>
        clientWith(() => {
          throw new Error("release failed");
        }),
      ),
    };
    await expect(withPoolClient(releasePool, async () => undefined)).rejects
      .toBeInstanceOf(PostgresInfrastructureError);
  });
});

const transactionOptions = {
  lockTimeoutMs: 250,
  statementTimeoutMs: 2_000,
  maxAttempts: 3,
} as const;

const postgresError = (code: string): Error & { code: string } =>
  Object.assign(new Error(code), { code });

describe("serializable transaction runner", () => {
  it.each(["40001", "40P01"])(
    "retries SQLSTATE %s from the beginning with one immutable snapshot",
    async (code) => {
      const release = vi.fn();
      const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      const client = { query, release } as unknown as QueryableClient;
      const pool: QueryablePool = { connect: vi.fn(async () => client) };
      const input = { nested: { value: 1 } };
      const seen: number[] = [];
      let calls = 0;

      const result = withSerializableTransaction({
        pool,
        options: transactionOptions,
        input,
        operation: async (_client, captured) => {
          calls += 1;
          seen.push(captured.nested.value);
          if (calls === 1) throw postgresError(code);
          return "committed";
        },
      });
      input.nested.value = 99;

      await expect(result).resolves.toBe("committed");
      expect(seen).toEqual([1, 1]);
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL SERIALIZABLE");
      expect(query).toHaveBeenCalledWith(
        "SELECT set_config('lock_timeout', $1, true)",
        ["250ms"],
      );
    },
  );

  it("rolls back callback failure without retrying", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const client = clientWith(vi.fn());
    client.query = query as unknown as QueryableClient["query"];
    const pool: QueryablePool = { connect: vi.fn(async () => client) };
    const failure = new Error("callback failed");

    await expect(withSerializableTransaction({
      pool,
      options: transactionOptions,
      input: { value: 1 },
      operation: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("fails closed on retry exhaustion and unexpected constraints", async () => {
    const retryClient = clientWith(vi.fn());
    retryClient.query = vi.fn(async () => ({ rows: [], rowCount: 0 })) as unknown as QueryableClient["query"];
    const retryPool: QueryablePool = {
      connect: vi.fn(async () => retryClient),
    };
    await expect(withSerializableTransaction({
      pool: retryPool,
      options: { ...transactionOptions, maxAttempts: 2 },
      input: {},
      operation: async () => { throw postgresError("40001"); },
    })).rejects.toMatchObject({ code: "transaction_retry_exhausted" });

    const uniqueClient = clientWith(vi.fn());
    uniqueClient.query = vi.fn(async () => ({ rows: [], rowCount: 0 })) as unknown as QueryableClient["query"];
    const uniquePool: QueryablePool = {
      connect: vi.fn(async () => uniqueClient),
    };
    await expect(withSerializableTransaction({
      pool: uniquePool,
      options: transactionOptions,
      input: {},
      operation: async () => { throw postgresError("23505"); },
    })).rejects.toMatchObject({ code: "unexpected_constraint_violation" });

    await expect(withSerializableTransaction({
      pool: uniquePool,
      options: transactionOptions,
      input: {},
      operation: async () => { throw postgresError("42P01"); },
    })).rejects.toMatchObject({ code: "transaction_failed" });
  });
});
