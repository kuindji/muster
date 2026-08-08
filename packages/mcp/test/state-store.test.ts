import {
  mcpRateWindow,
  type McpRateLimitPolicy,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";
import {
  createMusterMcpConfig,
  createMusterMcpHandler,
  InMemoryMcpStateStore,
  MCP_STATE_STORE_CONFORMANCE_CASES,
  McpSubjectLifecycleService,
  runMcpStateStoreConformance,
} from "../src/index.js";
import {
  TEST_SUBJECT,
  TEST_WORKER_ID,
  createTestAuthentication,
  createTestJobTools,
  validConfigInput,
} from "./helpers.js";

const NOW = "2026-08-08T10:00:30.000Z";
const policy: McpRateLimitPolicy = {
  version: "rate-test-1",
  windowSeconds: 60,
  maxCallsPerWindow: {
    lease_job: 4,
    submit_result: 4,
    abandon_job: 4,
    extend_lease: 4,
    get_worker_status: 4,
    set_availability: 4,
  },
  maxLeaseAttemptsPerSlot: 4,
};

describe("InMemoryMcpStateStore", () => {
  it("passes the exported adapter-parametric conformance suite", async () => {
    const passed = await runMcpStateStoreConformance(
      () => new InMemoryMcpStateStore(),
    );
    expect(passed).toEqual(MCP_STATE_STORE_CONFORMANCE_CASES.map(({ id }) => id));
  });

  it("exposes operator mapping lifecycle without adding an MCP tool", async () => {
    const store = new InMemoryMcpStateStore();
    const service = new McpSubjectLifecycleService(store);
    const bound = await service.bindSubject({
      bindingId: "binding-test-1",
      subject: {
        issuer: "https://issuer.example/",
        subject: "subject-test-1",
      },
      workerId: "worker-test-1",
      at: NOW,
    });
    expect(bound.kind).toBe("bound");
    if (bound.kind !== "bound") return;

    await expect(store.authorizeCall({
      expectedBinding: bound.binding,
      tool: "lease_job",
      policy,
      window: mcpRateWindow(policy, NOW),
      assignedSlotOccurrence: "slot-test-1",
      availabilityBudgetBucket: 2,
      at: NOW,
    })).resolves.toMatchObject({ kind: "authorized" });

    const severed = await service.severSubject({
      severanceId: "severance-test-1",
      expectedBinding: bound.binding,
      at: "2026-08-08T10:00:31.000Z",
    });
    expect(severed).toMatchObject({ kind: "severed" });
    expect(await store.resolveSubject(bound.binding.subject)).toBeNull();

    const snapshot = await store.snapshot();
    expect(snapshot.bindings).toEqual([]);
    expect(snapshot.severances).toEqual([{
      severanceId: "severance-test-1",
      bindingId: "binding-test-1",
      workerId: "worker-test-1",
      severedAt: "2026-08-08T10:00:31.000Z",
    }]);
    expect(snapshot.rateUsage).toEqual([expect.objectContaining({
      workerId: "worker-test-1",
      callsUsed: 1,
    })]);
    expect(JSON.stringify(snapshot)).not.toContain("subject-test-1");
  });

  it("fails authentication after severance while retaining pseudonymous usage", async () => {
    const config = createMusterMcpConfig(validConfigInput());
    const fixture = await createTestAuthentication(config);
    const store = new InMemoryMcpStateStore();
    const bound = await store.bindSubject({
      bindingId: "binding-auth-1",
      subject: {
        issuer: config.authorizationServers[0]!.issuerUrl,
        subject: TEST_SUBJECT,
      },
      workerId: TEST_WORKER_ID,
      at: NOW,
    });
    expect(bound.kind).toBe("bound");
    if (bound.kind !== "bound") return;
    await store.authorizeCall({
      expectedBinding: bound.binding,
      tool: "get_worker_status",
      policy,
      window: mcpRateWindow(policy, NOW),
      assignedSlotOccurrence: "slot-auth-1",
      at: NOW,
    });
    const handler = createMusterMcpHandler(config, {
      authentication: {
        ...fixture.authentication,
        stateStore: store,
      },
      jobTools: createTestJobTools({ stateStore: store }),
    });
    const request = () => new Request(config.resourceUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: fixture.authorizationHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect((await handler.fetch(request())).status).toBe(200);
    await store.severSubject({
      severanceId: "severance-auth-1",
      expectedBinding: bound.binding,
      at: "2026-08-08T10:00:31.000Z",
    });
    const refused = await handler.fetch(request());
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const snapshot = await store.snapshot();
    expect(snapshot.rateUsage).toEqual([expect.objectContaining({
      workerId: TEST_WORKER_ID,
      callsUsed: 1,
    })]);
    expect(JSON.stringify(snapshot)).not.toContain(TEST_SUBJECT);
    await handler.close();
  });

  it("returns stable sorted snapshots and refuses malformed state inputs", async () => {
    const store = new InMemoryMcpStateStore();
    for (const suffix of ["b", "a"] as const) {
      await store.bindSubject({
        bindingId: `binding-${suffix}`,
        subject: {
          issuer: "https://issuer.example/",
          subject: `subject-${suffix}`,
        },
        workerId: `worker-${suffix}`,
        at: NOW,
      });
    }
    expect((await store.snapshot()).bindings.map(({ bindingId }) => bindingId))
      .toEqual(["binding-a", "binding-b"]);
    await expect(store.bindSubject({
      bindingId: "bad id",
      subject: { issuer: "http://issuer.example/", subject: "bad" },
      workerId: "worker-c",
      at: NOW,
    })).resolves.toMatchObject({ kind: "conflict" });
    await expect(store.authorizeCall(null as never)).resolves.toEqual({
      kind: "refused",
      reason: "policy_or_window_invalid",
    });
  });
});
