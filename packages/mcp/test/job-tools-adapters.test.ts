import { randomUUID } from "node:crypto";
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
  SkillReleaseRegistry,
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
    store: new PostgresStore({ pool: postgresPool, schema }),
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
    leaseService,
    submissionService,
    workerStatus,
  };
}

async function enqueue(leaseService: LeaseService, jobId: string) {
  const result = await leaseService.enqueue({
    jobId,
    classId: "class-test-1",
    contractVersion: "1.0.0",
    rawPayload: { instruction: ` answer ${jobId} ` },
    policyVersion: "policy-test-1",
    priority: { lane: "normal", value: 1, sequence: `sequence-${jobId}` },
  });
  expect(result).toMatchObject({ ok: true, kind: "enqueued" });
}

async function authenticatedClient(store: Store) {
  const services = await runtime(store);
  const config = createMusterMcpConfig(validConfigInput());
  const auth = await createTestAuthentication(config);
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
  const handler = createMusterMcpHandler(config, {
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
  const client = new Client(
    { name: "muster-adapter-conformance", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  return { client, handler, services };
}

describe("all authenticated tools over real core adapters", () => {
  it.each([
    ["InMemoryStore", inMemoryFixture],
    ["PostgresStore", postgresFixture],
  ] as const)(
    "runs all six tools, including replay and availability, through %s",
    async (_name, createFixture) => {
      const fixture = await createFixture();
      const test = await authenticatedClient(fixture.store);
      try {
        await enqueue(test.services.leaseService, "job-adapter-1");
        const leased = await test.client.callTool({
          name: "lease_job",
          arguments: { availability: { budget_bucket: 3 } },
        });
        expect(leased.structuredContent).toMatchObject({
          job_class_id: "class-test-1",
          contract_version: "1.0.0",
          ttl_bucket_seconds: 300,
          payload: { instruction: "answer job-adapter-1" },
        });
        const lease = leased.structuredContent as {
          lease_id: string;
          input_hash: string;
        };

        const extended = await test.client.callTool({
          name: "extend_lease",
          arguments: { lease_id: lease.lease_id },
        });
        expect(extended.structuredContent).toEqual({
          new_expiry_bucket_seconds: 900,
        });

        const submissionArguments = {
          lease_id: lease.lease_id,
          input_hash: lease.input_hash,
          result: { answer: "accepted adapter result" },
        };
        const accepted = await test.client.callTool({
          name: "submit_result",
          arguments: submissionArguments,
        });
        const replayed = await test.client.callTool({
          name: "submit_result",
          arguments: submissionArguments,
        });
        expect(accepted).toEqual(replayed);
        expect(accepted.structuredContent).toMatchObject({
          lease_id: lease.lease_id,
          input_hash: lease.input_hash,
          outcome: "accepted",
        });

        await enqueue(test.services.leaseService, "job-adapter-2");
        const second = await test.client.callTool({
          name: "lease_job",
          arguments: { availability: { budget_bucket: 3 } },
        });
        const secondLease = second.structuredContent as { lease_id: string };
        const abandoned = await test.client.callTool({
          name: "abandon_job",
          arguments: {
            lease_id: secondLease.lease_id,
            reason: "platform_failure",
          },
        });
        expect(abandoned.structuredContent).toEqual({ outcome: "recorded" });

        const active = await test.client.callTool({
          name: "get_worker_status",
          arguments: {},
        });
        expect(active.structuredContent).toMatchObject({
          status: "active",
          contract_version: "1.1.0",
          cap_usage_bucket: 1,
          next_slot_bucket: 0,
        });
        const maintenance = await test.client.callTool({
          name: "set_availability",
          arguments: { state: "maintenance" },
        });
        expect(maintenance.structuredContent).toEqual({ outcome: "recorded" });
        const changed = await test.client.callTool({
          name: "get_worker_status",
          arguments: {},
        });
        expect(changed.structuredContent).toMatchObject({ status: "maintenance" });
      } finally {
        await test.client.close();
        await test.handler.close();
        await fixture.cleanup();
      }
    },
    120_000,
  );
});
