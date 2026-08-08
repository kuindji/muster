import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  computeSkillSha256,
  renderSkill,
  type ClassHealth,
  type JobClass,
  type JSONSchema,
  type SkillSource,
} from "@kuindji/muster-contract";
import {
  ControlPlaneService,
  InMemoryStore,
  LeaseService,
  ManualClock,
  RecordingEventSink,
  RuntimeClassRegistry,
  SequenceIdSource,
  SubmissionService,
  WorkerStatusService,
  type ReputationPolicy,
  type Store,
  type WorkerControlPolicy,
} from "@kuindji/muster-core";
import {
  PostgresStore,
  bootstrapMusterPostgres,
  migrateMusterPostgres,
  quoteSchemaName,
  validateSchemaName,
} from "@kuindji/muster-store-postgres";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHandlerFetch,
  createMusterMcpConfig,
  createMusterMcpHandler,
  InMemoryMcpStateStore,
  MUSTER_MCP_CONFORMANCE_FIXTURE_IDS,
  runMusterMcpConformance,
  SkillReleaseRegistry,
  type MusterMcpConformanceFixturePack,
  type MusterMcpConformanceHarness,
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

type Payload = { instruction: string };
type Result = { answer: string };

const objectSchema = (property: string): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: { [property]: { type: "string" } },
  required: [property],
});

const jobClass = (): JobClass<Payload, Result> => ({
  id: "class-test-1",
  contractVersion: "1.0.0",
  kind: "oneshot",
  payloadSchema: objectSchema("instruction"),
  outputSchema: objectSchema("answer"),
  maxPayloadBytes: 4_096,
  maxResultBytes: 4_096,
  sanitize: (raw) => ({
    instruction: String((raw as { instruction?: unknown }).instruction ?? "").trim(),
  }),
  verification: "structural_only",
  validators: [],
  oracles: [],
  replication: { target: 1, maxSplitEvidenceReroutes: 0 },
  permits: [],
  consequence: "low",
  surface: "unbounded",
  evidenceRequirements: [],
  absenceRequirements: [],
  requires: {
    providerSurfaces: ["provider.example"],
    unattendedScheduling: true,
    languages: ["en"],
  },
  privacy: "internal",
  cost: {
    expectedTurns: 1,
    maxLeaseTtl: 300,
    leaseTtl: () => 240,
    maxInFlightLifetime: 1_801,
  },
  escalation: {
    lowCostPerWeek: 0,
    urgentPerWeek: 0,
    splitAndAdjudicationPerWeek: 0,
    retrospectiveAuditProjectionPerWeek: 0,
    auditPerWeek: 0,
    perWorkerLowCostQuotaPerWeek: 0,
    perWorkerUrgentQuotaPerWeek: 0,
  },
});

const readyHealth = (): ClassHealth => ({
  operating: "ready",
  reserves: {
    lowCost: "available",
    urgent: "available",
    splitAndAdjudication: "available",
    audit: "available",
  },
});

const workerPolicy: WorkerControlPolicy = {
  probationCheckedSuccesses: 1,
  probationMinimumEnrollmentAge: 0,
  assignSlot: () => 2,
  routingAt: ({ slot, at }) => ({
    contributionWindowId: at.slice(0, 10),
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
    slotOpen: true,
  }),
  nextSlot: ({ slot, at }) => ({
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
    startsInSeconds: 0,
  }),
};

const reputationPolicy: ReputationPolicy = {
  assess: () => ({ eligible: true }),
};

interface StoreFixture {
  readonly store: Store;
  cleanup(): Promise<void>;
}

const lifecycleFixtures = JSON.parse(
  readFileSync(
    new URL("../../contract/fixtures/lifecycle-fixtures.json", import.meta.url),
    "utf8",
  ),
) as readonly { readonly id: string }[];

const promptInjections = JSON.parse(
  readFileSync(
    new URL("../../contract/fixtures/prompt-injection.json", import.meta.url),
    "utf8",
  ),
) as MusterMcpConformanceFixturePack["promptInjections"];

const conformanceFixtures: MusterMcpConformanceFixturePack = {
  lifecycleFixtureIds: lifecycleFixtures.map(({ id }) => id),
  promptInjections,
};

let postgresContainer: StartedPostgreSqlContainer | undefined;
let postgresPool: Pool;

beforeAll(async () => {
  const explicitUrl = process.env.MUSTER_POSTGRES_TEST_URL;
  let connectionString: string;
  if (explicitUrl === undefined || explicitUrl === "") {
    postgresContainer = await new PostgreSqlContainer(
      process.env.MUSTER_POSTGRES_TEST_IMAGE || "postgres:16-alpine",
    ).start();
    connectionString = postgresContainer.getConnectionUri();
  } else {
    connectionString = explicitUrl;
  }
  postgresPool = new Pool({ connectionString, max: 8 });
}, 120_000);

afterAll(async () => {
  await postgresPool?.end();
  await postgresContainer?.stop();
});

async function postgresFixture(): Promise<StoreFixture> {
  const schema = validateSchemaName(
    `muster_test_${randomUUID().replaceAll("-", "")}`,
  );
  await postgresPool.query(`CREATE SCHEMA ${quoteSchemaName(schema)}`);
  await migrateMusterPostgres({ pool: postgresPool, schema });
  await bootstrapMusterPostgres({
    pool: postgresPool,
    schema,
    initialQueue: { mode: "normal", updatedAt: TEST_NOW },
  });
  return {
    store: new Proxy({} as Store, {
      get: (_target, property) => {
        if (property === "then") return undefined;
        return (...arguments_: unknown[]) => {
          const restarted = new PostgresStore({ pool: postgresPool, schema });
          const method = Reflect.get(restarted, property) as unknown;
          if (typeof method !== "function") {
            throw new TypeError(
              `PostgresStore.${String(property)} is not callable`,
            );
          }
          return Reflect.apply(method, restarted, arguments_);
        };
      },
    }),
    cleanup: async () => {
      await postgresPool.query(`DROP SCHEMA ${quoteSchemaName(schema)} CASCADE`);
    },
  };
}

async function inMemoryFixture(): Promise<StoreFixture> {
  return {
    store: new InMemoryStore({
      initialQueue: { mode: "normal", updatedAt: TEST_NOW },
    }),
    cleanup: async () => undefined,
  };
}

async function runtime(store: Store) {
  const clock = new ManualClock(TEST_NOW);
  const registry = new RuntimeClassRegistry();
  const definition = jobClass();
  const events = new RecordingEventSink();
  const ids = new SequenceIdSource("mcp-task5");
  registry.load({
    jobClass: definition,
    payloadSchemaHash: "payload-schema-test-1",
    outputSchemaHash: "output-schema-test-1",
  });
  await store.registerClassVersion({
    classId: definition.id,
    contractVersion: definition.contractVersion,
    payloadSchemaHash: "payload-schema-test-1",
    outputSchemaHash: "output-schema-test-1",
    registeredAt: TEST_NOW,
  });
  await store.initializeClassHealth({
    initial: {
      classId: definition.id,
      health: readyHealth(),
      updatedAt: TEST_NOW,
      source: "automatic",
    },
  });
  await store.transitionClassVersion({
    classId: definition.id,
    contractVersion: definition.contractVersion,
    from: "draft",
    to: "active",
    at: TEST_NOW,
  });
  await store.transitionPermitEpoch({
    classId: definition.id,
    fromEpoch: null,
    toEpoch: "epoch-test-1",
    at: TEST_NOW,
  });
  await store.registerWorker({
    worker: {
      workerId: TEST_WORKER_ID,
      state: "active",
      enrolledAt: TEST_NOW,
      declaredCapPerWeek: 20,
      capabilities: {
        providerSurface: "provider.example",
        unattendedScheduling: true,
        languages: ["en"],
        jobClassIds: [definition.id],
      },
      accountCluster: "cluster-test-1",
      slot: 2,
      contractAcceptance: {
        contractVersion: "1.1.0",
        acceptedAt: TEST_NOW,
      },
    },
    routing: {
      contributionWindowId: TEST_NOW.slice(0, 10),
      contributionUsed: 0,
      assignedSlotOccurrence: `${TEST_NOW.slice(0, 10)}-slot-2`,
    },
  });
  const leaseService = new LeaseService({
    store,
    registry,
    clock,
    ids,
    events,
    workerPolicy,
    reputationPolicy,
    deploymentPolicy: {
      version: "deployment-test-1",
      extensionTtl: 300,
      maxExtensionsPerLease: 2,
    },
  });
  const submissionService = new SubmissionService({
    store,
    registry,
    clock,
    ids,
    events,
  });
  const workerStatus = new WorkerStatusService({ store, clock, workerPolicy });
  const controlPlaneService = new ControlPlaneService({
    store,
    clock,
    events,
    admission: { admit: async () => ({ admit: true }) },
    workerPolicy,
    registry,
  });
  return {
    clock,
    controlPlaneService,
    events,
    leaseService,
    submissionService,
    workerStatus,
  };
}

async function enqueue(
  leaseService: LeaseService,
  jobId: string,
  payloadText = `answer ${jobId}`,
) {
  const result = await leaseService.enqueue({
    jobId,
    classId: "class-test-1",
    contractVersion: "1.0.0",
    rawPayload: { instruction: ` ${payloadText} ` },
    policyVersion: "policy-test-1",
    priority: { lane: "normal", value: 1, sequence: `sequence-${jobId}` },
  });
  expect(result).toMatchObject({ ok: true, kind: "enqueued" });
}

async function authenticatedHarness(
  store: Store,
): Promise<MusterMcpConformanceHarness> {
  const coreBoundaryArtifacts: unknown[] = [];
  const auditedStore = new Proxy({} as Store, {
    get: (_target, property) => {
      if (property === "then") return undefined;
      const method = Reflect.get(store, property) as unknown;
      if (typeof method !== "function") return method;
      return async (...arguments_: unknown[]) => {
        coreBoundaryArtifacts.push({ method: String(property), arguments_ });
        try {
          const result = await Reflect.apply(method, store, arguments_);
          coreBoundaryArtifacts.push({ method: String(property), result });
          return result;
        } catch (error) {
          coreBoundaryArtifacts.push({
            method: String(property),
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
    },
  });
  const services = await runtime(auditedStore);
  const config = createMusterMcpConfig(validConfigInput());
  const stateStore = new InMemoryMcpStateStore();
  await stateStore.bindSubject({
    bindingId: "binding-adapter-test-1",
    subject: {
      issuer: config.authorizationServers[0]!.issuerUrl,
      subject: TEST_SUBJECT,
    },
    workerId: TEST_WORKER_ID,
    at: TEST_NOW,
  });
  const skillSource: SkillSource = {
    contractVersion: "1.1.0",
    jobClassIds: ["class-test-1"],
    instructions: "Lease one adapter test job and submit its result.",
  };
  const renderedSkill = renderSkill(skillSource);
  const skillReleaseRegistry = await SkillReleaseRegistry.create([{
    source: skillSource,
    skillSha256: await computeSkillSha256(renderedSkill),
  }]);
  let handler: ReturnType<typeof createMusterMcpHandler>;
  let client: Client;
  let bearer = "";

  const connect = async (): Promise<void> => {
    const auth = await createTestAuthentication(config);
    bearer = auth.token;
    handler = createMusterMcpHandler(config, {
      authentication: {
        ...auth.authentication,
        stateStore,
        workerStatus: services.workerStatus,
      },
      jobTools: createTestJobTools({
        stateStore,
        rateLimitPolicy: TEST_RATE_LIMIT_POLICY,
        leaseService: services.leaseService,
        submissionService: services.submissionService,
      }),
      workerTools: {
        stateStore,
        rateLimitPolicy: TEST_RATE_LIMIT_POLICY,
        controlPlaneService: services.controlPlaneService,
        skillReleaseRegistry,
      },
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(config.resourceUrl),
      {
        fetch: createHandlerFetch(handler),
        requestInit: { headers: { authorization: auth.authorizationHeader } },
      },
    );
    client = new Client(
      { name: "muster-adapter-conformance", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
  };

  await connect();
  return {
    listTools: () => client.listTools(),
    callTool: (input) => client.callTool(input),
    enqueue: (jobId, payloadText) => enqueue(
      services.leaseService,
      jobId,
      payloadText,
    ),
    async enterDegradedMode(): Promise<void> {
      const expected = await auditedStore.getQueueMode();
      const outcome = await auditedStore.transitionQueueMode({
        expected,
        next: {
          mode: "degraded",
          cause: "capacity",
          updatedAt: TEST_NOW,
        },
      });
      expect(outcome.kind).toBe("applied");
    },
    async restart(): Promise<void> {
      await client.close();
      await handler.close();
      await connect();
    },
    auditArtifacts: async () => [
      ...services.events.all(),
      ...coreBoundaryArtifacts,
    ],
    get sensitiveValues() {
      return [TEST_SUBJECT, bearer];
    },
    async close(): Promise<void> {
      await client.close();
      await handler.close();
    },
  };
}

describe("exported MCP cross-adapter conformance", () => {
  it("passes unchanged over in-memory and restart-per-call PostgreSQL Stores", async () => {
    const reports = [];
    for (const createFixture of [inMemoryFixture, postgresFixture]) {
      const allocated: StoreFixture[] = [];
      try {
        const report = await runMusterMcpConformance({
          createHarness: async () => {
            const fixture = await createFixture();
            allocated.push(fixture);
            const harness = await authenticatedHarness(fixture.store);
            return {
              ...harness,
              close: async () => {
                await harness.close();
                await fixture.cleanup();
                allocated.splice(allocated.indexOf(fixture), 1);
              },
            };
          },
          stateStoreFactory: () => new InMemoryMcpStateStore(),
        }, conformanceFixtures);
        expect(report.fixtureIds).toEqual(MUSTER_MCP_CONFORMANCE_FIXTURE_IDS);
        expect(report.promptInjectionIds).toEqual(
          promptInjections.map(({ id }) => id),
        );
        reports.push(report);
      } finally {
        for (const fixture of allocated) await fixture.cleanup();
      }
    }

    expect(reports[0]!.successfulResultBytes).toEqual(
      reports[1]!.successfulResultBytes,
    );
    expect(reports[0]!.stateStoreCaseIds).toEqual(
      reports[1]!.stateStoreCaseIds,
    );
  }, 120_000);
});
