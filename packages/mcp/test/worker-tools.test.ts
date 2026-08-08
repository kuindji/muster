import {
  canonicalize,
  computeSkillSha256,
  renderSkill,
  type McpRateLimitPolicy,
  type McpSubjectBinding,
  type SkillSource,
  type WorkerState,
} from "@kuindji/muster-contract";
import type { WorkerRecord, WorkerStatusSnapshot } from "@kuindji/muster-core";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE,
  SkillReleaseRegistry,
  createHandlerFetch,
  createMusterMcpConfig,
  createMusterMcpHandler,
  InMemoryMcpStateStore,
  type MusterMcpWorkerToolDependencies,
} from "../src/index.js";
import {
  TEST_NOW,
  TEST_RATE_LIMIT_POLICY,
  TEST_SUBJECT,
  TEST_WORKER_ID,
  createTestAuthentication,
  createTestJobTools,
  validConfigInput,
} from "./helpers.js";

const skillSource: SkillSource = {
  contractVersion: "1.1.0",
  jobClassIds: ["class-test-1"],
  instructions: "Lease one registered test job and submit its result.",
};

function workerRecord(state: WorkerState): WorkerRecord {
  return {
    workerId: TEST_WORKER_ID,
    state,
    enrolledAt: TEST_NOW,
    declaredCapPerWeek: 4,
    capabilities: {
      providerSurface: "provider.example",
      unattendedScheduling: true,
      languages: ["en"],
      jobClassIds: ["class-test-1"],
    },
    accountCluster: "cluster-test-1",
    slot: 1,
    contractAcceptance: { contractVersion: "1.1.0", acceptedAt: TEST_NOW },
  };
}

function successfulTransition(state: "active" | "maintenance") {
  return {
    ok: true as const,
    kind: "applied" as const,
    worker: workerRecord(state),
    requeuedLeaseCount: 0,
  };
}

async function releaseRegistry(
  source: SkillSource = skillSource,
): Promise<SkillReleaseRegistry> {
  const rendered = renderSkill(source);
  return SkillReleaseRegistry.create([{
    source,
    skillSha256: await computeSkillSha256(rendered),
  }]);
}

interface HarnessOptions {
  readonly status?: Partial<WorkerStatusSnapshot>;
  readonly registry?: SkillReleaseRegistry;
  readonly controlPlaneService?: MusterMcpWorkerToolDependencies["controlPlaneService"];
  readonly rateLimitPolicy?: McpRateLimitPolicy;
}

async function harness(options: HarnessOptions = {}) {
  const config = createMusterMcpConfig(validConfigInput());
  const auth = await createTestAuthentication(config);
  const stateStore = new InMemoryMcpStateStore();
  const bound = await stateStore.bindSubject({
    bindingId: "binding-test-1",
    subject: {
      issuer: config.authorizationServers[0]!.issuerUrl,
      subject: TEST_SUBJECT,
    },
    workerId: TEST_WORKER_ID,
    at: TEST_NOW,
  });
  if (bound.kind === "conflict") throw new Error("test binding conflict");

  let status: WorkerStatusSnapshot = {
    workerId: TEST_WORKER_ID,
    state: "active",
    contractVersion: "1.1.0",
    jobClassIds: ["class-test-1"],
    capUsageBucket: 0,
    nextSlotBucket: 0,
    assignedSlotOccurrence: "slot-test-1",
    nextSlotOccurrence: "slot-test-1",
    ...options.status,
  };
  let tokenRevoked = false;
  const setWorkerAvailability = options.controlPlaneService
    ?.setWorkerAvailability ?? vi.fn(async (
      _workerId: string,
      to: "active" | "maintenance",
    ) => successfulTransition(to));
  const rateLimitPolicy: McpRateLimitPolicy = options.rateLimitPolicy ?? {
    ...TEST_RATE_LIMIT_POLICY,
    maxCallsPerWindow: {
      ...TEST_RATE_LIMIT_POLICY.maxCallsPerWindow,
      get_worker_status: 100,
      set_availability: 100,
    },
  };
  const registry = options.registry ?? await releaseRegistry();
  const handler = createMusterMcpHandler(config, {
    authentication: {
      ...auth.authentication,
      stateStore,
      revocationSource: { isRevoked: async () => tokenRevoked },
      workerStatus: {
        getWorkerStatus: async () => ({ ok: true as const, status }),
      },
    },
    jobTools: createTestJobTools({ stateStore, rateLimitPolicy }),
    workerTools: {
      stateStore,
      rateLimitPolicy,
      controlPlaneService: { setWorkerAvailability },
      skillReleaseRegistry: registry,
    },
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(config.resourceUrl),
    {
      fetch: createHandlerFetch(handler),
      requestInit: { headers: { authorization: auth.authorizationHeader } },
    },
  );
  const client = new Client(
    { name: "muster-worker-tool-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  return {
    binding: bound.binding,
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
    setStatus(next: Partial<WorkerStatusSnapshot>) {
      status = { ...status, ...next };
    },
    setTokenRevoked(value: boolean) {
      tokenRevoked = value;
    },
    setWorkerAvailability,
    stateStore,
  };
}

function expectCanonicalMirror(result: CallToolResult) {
  expect(result.content).toEqual([{
    type: "text",
    text: canonicalize(result.structuredContent),
  }]);
}

describe("canonical skill release registry", () => {
  it("verifies canonical bytes and selects by sorted complete class set", async () => {
    const source: SkillSource = {
      ...skillSource,
      jobClassIds: ["class-b", "class-a"],
    };
    const registry = await releaseRegistry(source);
    const release = registry.select({
      contractVersion: "1.1.0",
      jobClassIds: ["class-a", "class-b"],
    });
    expect(release).toMatchObject({
      contractVersion: "1.1.0",
      jobClassIds: ["class-a", "class-b"],
      rendered: renderSkill(source),
    });
    expect(release?.skillSha256).toBe(await computeSkillSha256(renderSkill(source)));
    expect(registry.getBySha256(release!.skillSha256)).toEqual(release);
    (release!.jobClassIds as string[]).reverse();
    source.instructions = "mutated after registry creation";
    expect(registry.select({
      contractVersion: "1.1.0",
      jobClassIds: ["class-b", "class-a"],
    })?.rendered).not.toContain("mutated after registry creation");
    expect(registry.select({
      contractVersion: "1.1.0",
      jobClassIds: ["class-a"],
    })).toBeNull();
  });

  it("rejects hash mismatch, duplicate selection, and ambiguous duplicate release", async () => {
    const skillSha256 = await computeSkillSha256(renderSkill(skillSource));
    await expect(SkillReleaseRegistry.create([{
      source: skillSource,
      skillSha256: "0".repeat(64),
    }])).rejects.toThrow("mismatch");
    await expect(SkillReleaseRegistry.create([
      { source: skillSource, skillSha256 },
      { source: { ...skillSource }, skillSha256 },
    ])).rejects.toThrow("duplicate or ambiguous");
  });
});

describe("authenticated MCP worker tools", () => {
  it.each([
    "enrolled",
    "active",
    "maintenance",
    "paused",
    "suspended",
  ] as const)("returns schema-exact coarse %s status", async (state) => {
    const test = await harness({
      status: {
        state,
        capUsageBucket: state === "enrolled" ? 1 : 2,
        nextSlotBucket: state === "suspended" ? 5 : 3,
      },
    });
    const result = await test.client.callTool({
      name: "get_worker_status",
      arguments: {},
    });
    expect(result.structuredContent).toEqual({
      status: state,
      contract_version: "1.1.0",
      skill_sha256: await computeSkillSha256(renderSkill(skillSource)),
      cap_usage_bucket: state === "enrolled" ? 1 : 2,
      next_slot_bucket: state === "suspended" ? 5 : 3,
    });
    expect(Object.keys(result.structuredContent!)).toEqual([
      "status",
      "contract_version",
      "skill_sha256",
      "cap_usage_bucket",
      "next_slot_bucket",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /worker-test|subject|queue|lease|provider|assignedSlot|nextSlotOccurrence/,
    );
    expectCanonicalMirror(result);
    await test.close();
  });

  it("preserves every frozen cap and next-slot bucket edge exactly", async () => {
    const test = await harness();
    for (const capUsageBucket of [0, 1, 2, 3] as const) {
      for (const nextSlotBucket of [0, 1, 2, 3, 4, 5] as const) {
        test.setStatus({ capUsageBucket, nextSlotBucket });
        const result = await test.client.callTool({
          name: "get_worker_status",
          arguments: {},
        });
        expect(result.structuredContent).toMatchObject({
          cap_usage_bucket: capUsageBucket,
          next_slot_bucket: nextSlotBucket,
        });
      }
    }
    await test.close();
  });

  it("fails closed when the complete accepted class set has no release", async () => {
    const test = await harness({ status: { jobClassIds: ["class-missing"] } });
    const result = await test.client.callTool({
      name: "get_worker_status",
      arguments: {},
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE }],
    });
    expect(result.structuredContent).toBeUndefined();
    await test.close();
  });

  it("routes active, maintenance, and exact replay only through core", async () => {
    const setWorkerAvailability = vi.fn()
      .mockResolvedValueOnce(successfulTransition("maintenance"))
      .mockResolvedValueOnce({
        ...successfulTransition("maintenance"),
        kind: "replayed" as const,
      })
      .mockResolvedValueOnce(successfulTransition("active"));
    const test = await harness({
      controlPlaneService: { setWorkerAvailability },
    });
    for (const state of ["maintenance", "maintenance", "active"] as const) {
      const result = await test.client.callTool({
        name: "set_availability",
        arguments: { state },
      });
      expect(result.structuredContent).toEqual({ outcome: "recorded" });
      expectCanonicalMirror(result);
    }
    expect(setWorkerAvailability.mock.calls).toEqual([
      [TEST_WORKER_ID, "maintenance", TEST_NOW],
      [TEST_WORKER_ID, "maintenance", TEST_NOW],
      [TEST_WORKER_ID, "active", TEST_NOW],
    ]);
    await test.close();
  });

  it("projects invalid and concurrent transition conflicts through one error", async () => {
    const setWorkerAvailability = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        kind: "state_conflict" as const,
        actual: "paused" as const,
      })
      .mockResolvedValueOnce(successfulTransition("maintenance"))
      .mockResolvedValueOnce({
        ok: false as const,
        kind: "state_conflict" as const,
        actual: "maintenance" as const,
      });
    const test = await harness({
      controlPlaneService: { setWorkerAvailability },
    });
    const invalid = await test.client.callTool({
      name: "set_availability",
      arguments: { state: "active" },
    });
    expect(invalid).toMatchObject({
      isError: true,
      content: [{ type: "text", text: MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE }],
    });
    const raced = await Promise.all([
      test.client.callTool({
        name: "set_availability",
        arguments: { state: "maintenance" },
      }),
      test.client.callTool({
        name: "set_availability",
        arguments: { state: "maintenance" },
      }),
    ]);
    expect(raced.filter((result) => result.isError === true)).toHaveLength(1);
    expect(raced.filter(
      (result) => (result.structuredContent as { outcome?: unknown } | undefined)
        ?.outcome === "recorded",
    )).toHaveLength(1);
    expect(JSON.stringify(raced)).not.toMatch(/paused|maintenance|state_conflict/);
    await test.close();
  });

  it("rejects closed-input violations before MCP-state and core mutation", async () => {
    const authorizeCall = vi.fn();
    const setWorkerAvailability = vi.fn();
    const test = await harness({
      controlPlaneService: { setWorkerAvailability },
    });
    const originalAuthorize = test.stateStore.authorizeCall.bind(test.stateStore);
    test.stateStore.authorizeCall = async (input) => {
      authorizeCall(input);
      return originalAuthorize(input);
    };
    await expect(test.client.callTool({
      name: "set_availability",
      arguments: { state: "active", exact_time: TEST_NOW },
    })).rejects.toThrow();
    expect(authorizeCall).not.toHaveBeenCalled();
    expect(setWorkerAvailability).not.toHaveBeenCalled();
    await test.close();
  });

  it("observes mapping severance and token revocation before core dispatch", async () => {
    const setWorkerAvailability = vi.fn(async () => successfulTransition("maintenance"));
    const test = await harness({
      controlPlaneService: { setWorkerAvailability },
    });
    const severed = await test.stateStore.severSubject({
      severanceId: "severance-test-1",
      expectedBinding: test.binding as McpSubjectBinding,
      at: TEST_NOW,
    });
    expect(severed.kind).toBe("severed");
    await expect(test.client.callTool({
      name: "set_availability",
      arguments: { state: "maintenance" },
    })).rejects.toThrow();
    expect(setWorkerAvailability).not.toHaveBeenCalled();
    await test.close();

    const revoked = await harness({
      controlPlaneService: { setWorkerAvailability },
    });
    revoked.setTokenRevoked(true);
    await expect(revoked.client.callTool({
      name: "set_availability",
      arguments: { state: "maintenance" },
    })).rejects.toThrow();
    expect(setWorkerAvailability).not.toHaveBeenCalled();
    await revoked.close();
  });
});
