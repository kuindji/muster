import {
  TASK1_STORE_CONFORMANCE_CASES,
  type ClassHealthSnapshot,
  type ReservePolicyRecord,
  type Store,
  type WorkerRegistration,
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

const NOW = "2026-08-08T08:00:00.000Z";
const LATER = "2026-08-08T08:01:00.000Z";
const LATEST = "2026-08-08T08:02:00.000Z";

const readyHealth = () => ({
  operating: "ready" as const,
  reserves: {
    lowCost: "available" as const,
    urgent: "available" as const,
    splitAndAdjudication: "available" as const,
    audit: "available" as const,
  },
});

const workerRegistration = (workerId = "worker-1"): WorkerRegistration => ({
  worker: {
    workerId,
    state: "active",
    enrolledAt: NOW,
    declaredCapPerWeek: 4,
    capabilities: {
      providerSurface: "provider.example",
      unattendedScheduling: true,
      languages: ["en"],
      jobClassIds: ["class-1"],
    },
    accountCluster: "cluster-1",
    slot: 1,
    contractAcceptance: { contractVersion: "1.1.0", acceptedAt: NOW },
  },
  routing: {
    contributionWindowId: "2026-W32",
    contributionUsed: 0,
    assignedSlotOccurrence: "2026-W32-slot-1",
  },
});

describe("PostgreSQL control-state Store slice", () => {
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

  const selectedIds = new Set([
    "class-version-schema-digest-conflict",
    "worker-registration-routing-atomic",
    "class-health-initialization-replay-conflict",
  ]);
  const selectedCases = TASK1_STORE_CONFORMANCE_CASES.filter(({ id }) =>
    selectedIds.has(id)
  );

  it.each(selectedCases)("passes frozen case $id", async (testCase) => {
    await testCase.run(createStore);
  });

  it("compares and replays complete queue snapshots across adapter restart", async () => {
    const store = await createStore();
    const racer = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const initial = await store.getQueueMode();
    const inputs = [
      {
        expected: initial,
        next: { mode: "degraded" as const, cause: "capacity" as const, updatedAt: LATER },
      },
      {
        expected: initial,
        next: { mode: "admission_halted" as const, cause: "operator" as const, updatedAt: LATER },
      },
    ];
    const raced = await Promise.all([
      store.transitionQueueMode(inputs[0]!),
      racer.transitionQueueMode(inputs[1]!),
    ]);
    expect(raced.filter(({ kind }) => kind === "applied")).toHaveLength(1);
    expect(raced.filter(({ kind }) => kind === "conflict")).toHaveLength(1);

    const winner = raced.findIndex(({ kind }) => kind === "applied");
    const applied = raced[winner]!;
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") throw new Error("queue race has no winner");
    const advanced = await store.transitionQueueMode({
      expected: applied.current,
      next: { mode: "normal", cause: "operator", updatedAt: LATEST },
    });
    expect(advanced.kind).toBe("applied");

    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const replay = await restarted.transitionQueueMode(inputs[winner]!);
    expect(replay).toEqual({ ...applied, kind: "replayed" });
  });

  it("fences stale routing and worker-state commands with durable replays", async () => {
    const store = await createStore();
    const racer = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const registered = await store.registerWorker(workerRegistration());
    expect(registered.kind).toBe("registered");
    if (registered.kind !== "registered") throw new Error("worker registration failed");

    const routingInputs = [
      {
        expected: registered.routing,
        next: {
          contributionWindowId: "2026-W33",
          contributionUsed: 0,
          assignedSlotOccurrence: "2026-W33-slot-1",
        },
      },
      {
        expected: registered.routing,
        next: {
          contributionWindowId: "2026-W34",
          contributionUsed: 0,
          assignedSlotOccurrence: "2026-W34-slot-1",
        },
      },
    ];
    const routed = await Promise.all([
      store.transitionWorkerRouting(routingInputs[0]!),
      racer.transitionWorkerRouting(routingInputs[1]!),
    ]);
    expect(routed.filter(({ kind }) => kind === "applied")).toHaveLength(1);
    expect(routed.filter(({ kind }) => kind === "conflict")).toHaveLength(1);
    const routingWinner = routed.findIndex(({ kind }) => kind === "applied");
    const routingApplied = routed[routingWinner]!;
    if (routingApplied.kind !== "applied") throw new Error("routing race has no winner");

    const maintenanceInput = {
      workerId: "worker-1",
      from: "active" as const,
      to: "maintenance" as const,
      at: LATER,
    };
    const maintained = await store.transitionWorkerState(maintenanceInput);
    expect(maintained).toMatchObject({ kind: "applied", requeuedOpenLeases: [] });
    const returned = await store.transitionWorkerState({
      workerId: "worker-1",
      from: "maintenance",
      to: "active",
      at: LATEST,
    });
    expect(returned.kind).toBe("applied");

    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    expect(await restarted.transitionWorkerRouting(routingInputs[routingWinner]!))
      .toEqual({ ...routingApplied, kind: "replayed" });
    expect(await restarted.transitionWorkerState(maintenanceInput))
      .toEqual({ ...maintained, kind: "replayed" });
  });

  it("preserves accounting-owned reserves through health races and replay", async () => {
    const store = await createStore();
    const racer = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const initialized = await store.initializeClassHealth({
      initial: {
        classId: "class-1",
        health: readyHealth(),
        updatedAt: NOW,
        source: "automatic",
      },
    });
    expect(initialized.kind).toBe("initialized");
    if (initialized.kind !== "initialized") throw new Error("health initialization failed");
    const expected = initialized.current;
    const inputs: Parameters<Store["transitionClassHealth"]>[0][] = [
      {
        expected,
        next: {
          health: { operating: "adjudication_starved" },
          updatedAt: LATER,
          source: "automatic",
        },
      },
      {
        expected,
        next: {
          health: { operating: "admission_halted" },
          updatedAt: LATER,
          source: "operator",
        },
      },
    ];
    const raced = await Promise.all([
      store.transitionClassHealth(inputs[0]!),
      racer.transitionClassHealth(inputs[1]!),
    ]);
    expect(raced.filter(({ kind }) => kind === "applied")).toHaveLength(1);
    expect(raced.filter(({ kind }) => kind === "conflict")).toHaveLength(1);
    const winner = raced.findIndex(({ kind }) => kind === "applied");
    const applied = raced[winner]!;
    if (applied.kind !== "applied") throw new Error("health race has no winner");
    expect(applied.current.health.reserves).toEqual(readyHealth().reserves);

    const later = await store.transitionClassHealth({
      expected: applied.current,
      next: { health: { operating: "ready" }, updatedAt: LATEST, source: "operator" },
    });
    expect(later.kind).toBe("applied");
    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    expect(await restarted.transitionClassHealth(inputs[winner]!))
      .toEqual({ ...applied, kind: "replayed" });
  });

  it("locks whole class-version sets canonically during concurrent retirement", async () => {
    const store = await createStore();
    const racer = new PostgresStore({ pool: harness.pool, schema: store.schema });
    for (const contractVersion of ["2.0.0", "1.0.0"]) {
      expect(await store.registerClassVersion({
        classId: "class-1",
        contractVersion,
        payloadSchemaHash: `payload-${contractVersion}`,
        outputSchemaHash: `output-${contractVersion}`,
        registeredAt: NOW,
      })).toMatchObject({ kind: "registered" });
    }
    const health = await store.initializeClassHealth({
      initial: {
        classId: "class-1",
        health: readyHealth(),
        updatedAt: NOW,
        source: "automatic",
      },
    });
    expect(health.kind).toBe("initialized");

    const retirements = ["2.0.0", "1.0.0"].map((contractVersion) => ({
      classId: "class-1",
      contractVersion,
      from: "draft" as const,
      to: "retired" as const,
      at: LATER,
    }));
    const outcomes = await Promise.all([
      store.transitionClassVersion(retirements[0]!),
      racer.transitionClassVersion(retirements[1]!),
    ]);
    expect(outcomes.every(({ kind }) => kind === "applied")).toBe(true);
    expect((await store.listClassVersions("class-1")).map(({ contractVersion }) =>
      contractVersion
    )).toEqual(["1.0.0", "2.0.0"]);
    expect((await store.getClassHealth("class-1"))?.revision).toBe(3);

    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const replay = await restarted.transitionClassVersion(retirements[0]!);
    const original = outcomes[0];
    if (original?.kind !== "applied") throw new Error("first retirement did not apply");
    expect(replay).toEqual({ ...original, kind: "replayed" });
  });

  it("preserves lifecycle cutoffs and republishes reserve health on retirement", async () => {
    const store = await createStore();
    for (const contractVersion of ["1.0.0", "2.0.0"]) {
      await store.registerClassVersion({
        classId: "class-1",
        contractVersion,
        payloadSchemaHash: `payload-${contractVersion}`,
        outputSchemaHash: `output-${contractVersion}`,
        registeredAt: NOW,
      });
      await store.transitionClassVersion({
        classId: "class-1",
        contractVersion,
        from: "draft",
        to: "active",
        at: NOW,
      });
    }
    await store.initializeClassHealth({
      initial: {
        classId: "class-1",
        health: {
          ...readyHealth(),
          reserves: { ...readyHealth().reserves, audit: "saturated" },
        },
        updatedAt: NOW,
        source: "automatic",
      },
    });
    const saturatedPolicy: ReservePolicyRecord = {
      revision: 1,
      policy: {
        classId: "class-1",
        contractVersion: "1.0.0",
        policyVersion: "policy-1",
        windowId: "2026-W32",
        windowStartsAt: NOW,
        windowEndsAt: "2026-08-15T08:00:00.000Z",
        lane: "audit",
        laneLimit: 1,
      },
      used: 1,
      workerUsage: [],
      updatedAt: NOW,
    };
    await harness.pool.query(
      `INSERT INTO ${store.quotedSchema}.reserve_policies
         (class_id, contract_version, lane, revision, window_id,
          window_starts_at, window_ends_at, record)
       VALUES ($1, $2, $3, 1, $4, $5::timestamptz, $6::timestamptz, $7::jsonb)`,
      [
        saturatedPolicy.policy.classId,
        saturatedPolicy.policy.contractVersion,
        saturatedPolicy.policy.lane,
        saturatedPolicy.policy.windowId,
        saturatedPolicy.policy.windowStartsAt,
        saturatedPolicy.policy.windowEndsAt,
        JSON.stringify(saturatedPolicy),
      ],
    );

    const retired = await store.transitionClassVersion({
      classId: "class-1",
      contractVersion: "1.0.0",
      from: "active",
      to: "retired",
      at: LATEST,
      leaseDisabledAt: LATER,
      acceptedUntil: LATEST,
    });
    expect(retired.kind).toBe("applied");
    if (retired.kind !== "applied" || retired.record.state !== "retired" ||
        retired.classHealth === undefined) {
      throw new Error("class retirement failed");
    }
    expect(retired.record).toMatchObject({
      leaseDisabledAt: LATER,
      acceptedUntil: LATEST,
    });
    expect(retired.classHealth.health.reserves.audit).toBe("available");
  });

  it("returns detached records from every implemented read boundary", async () => {
    const store = await createStore();
    const registered = await store.registerWorker(workerRegistration());
    if (registered.kind !== "registered") throw new Error("worker registration failed");
    const first = await store.getWorker("worker-1");
    first?.capabilities.languages.push("fr");
    expect((await store.getWorker("worker-1"))?.capabilities.languages).toEqual(["en"]);

    const health: Omit<ClassHealthSnapshot, "revision"> = {
      classId: "z-class",
      health: readyHealth(),
      updatedAt: NOW,
      source: "automatic",
    };
    await store.initializeClassHealth({ initial: health });
    const listed = await store.listClassHealth();
    const mutable = listed[0] as unknown as {
      health: { reserves: { lowCost: "available" | "saturated" } };
    };
    mutable.health.reserves.lowCost = "saturated";
    expect((await store.getClassHealth("z-class"))?.health.reserves.lowCost)
      .toBe("available");
  });
});
