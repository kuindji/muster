import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresInfrastructureError } from "../src/errors.js";
import { withPoolClient } from "../src/transactions.js";
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
