import type {
  AdjudicationPolicy,
  AdjudicationCapacity,
  JobClass,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/memory-store.js";
import {
  OperationsService,
  projectCapacity,
} from "../src/operations-service.js";
import type {
  OperationsSource,
  QueueCapacityObservation,
} from "../src/ports.js";
import { RuntimeClassRegistry } from "../src/registration.js";
import { ManualClock, RecordingEventSink } from "../src/testing.js";

const NOW = "2026-08-07T15:00:00.000Z";

const policy = (
  requiredRatePerWeek: number,
  restoreAbovePerWeek: number,
  starvationDwell: number,
  capacityMaxAge: number,
): AdjudicationPolicy => ({
  requiredRatePerWeek,
  restoreAbovePerWeek,
  starvationDwell,
  capacityMaxAge,
  maxRejectedDisputeRequeues: 1,
});

const observation = (
  at: string,
  overrides: Partial<QueueCapacityObservation> = {},
): QueueCapacityObservation => ({
  observedAt: at,
  activeWorkers: 10,
  itemsPerBatch: 2,
  combinedCanaryAuditFraction: 0.2,
  meanReplicationFactor: 2,
  minimumEffectiveCapacity: 7,
  slotWindow: {
    startsAt: new Date(Date.parse(at) - 60_000).toISOString(),
    endsAt: at,
    providers: [{
      providerSurface: "provider-a",
      expectedArrivals: 1,
      observedArrivals: 1,
    }],
  },
  ...overrides,
});

const addClass = async (
  store: InMemoryStore,
  registry: RuntimeClassRegistry,
  version: string,
  adjudication: AdjudicationPolicy | undefined,
  state: "active" | "draining" = "active",
): Promise<void> => {
  const registered = await store.registerClassVersion({
    classId: "class-1",
    contractVersion: version,
    payloadSchemaHash: `payload-${version}`,
    outputSchemaHash: `output-${version}`,
    registeredAt: NOW,
  });
  expect(registered.kind).toBe("registered");
  if (await store.getClassHealth("class-1") === null) {
    await store.initializeClassHealth({
      initial: {
        classId: "class-1",
        health: {
          operating: "ready",
          reserves: {
            lowCost: "available",
            urgent: "available",
            splitAndAdjudication: "available",
            audit: "available",
          },
        },
        updatedAt: NOW,
        source: "automatic",
      },
    });
  }
  await store.transitionClassVersion({
    classId: "class-1",
    contractVersion: version,
    from: "draft",
    to: "active",
    at: NOW,
  });
  if (state === "draining") {
    await store.transitionClassVersion({
      classId: "class-1",
      contractVersion: version,
      from: "active",
      to: "draining",
      at: NOW,
      leaseDisabledAt: NOW,
      acceptedUntil: "2026-08-07T16:00:00.000Z",
    });
  }
  registry.load({
    jobClass: {
      id: "class-1",
      contractVersion: version,
      privacy: "internal",
      ...(adjudication === undefined ? {} : { adjudication }),
    } as unknown as JobClass<unknown, unknown>,
    payloadSchemaHash: `payload-${version}`,
    outputSchemaHash: `output-${version}`,
  });
};

const setup = () => {
  const clock = new ManualClock(NOW);
  const store = new InMemoryStore({
    initialQueue: { mode: "normal", updatedAt: NOW },
  });
  const registry = new RuntimeClassRegistry();
  const events = new RecordingEventSink();
  let currentObservation = observation(NOW);
  let capacity: AdjudicationCapacity = {
    classId: "class-1",
    availableReviewsPerWeek: 10,
    observedAt: NOW,
  };
  const operations: OperationsSource = {
    observeQueue: () => currentObservation,
  };
  const service = new OperationsService({
    store,
    registry,
    clock,
    operations,
    adjudication: {
      capacity: () => capacity,
      authenticate: () => true,
    },
    events,
  });
  return {
    service,
    store,
    registry,
    clock,
    events,
    setObservation: (next: QueueCapacityObservation) => {
      currentObservation = next;
    },
    setCapacity: (next: AdjudicationCapacity) => {
      capacity = next;
    },
  };
};

describe("M2 Task 8 operations service", () => {
  it("projects effective throughput and rejects non-finite policy inputs", () => {
    expect(projectCapacity({
      activeWorkers: 10,
      itemsPerBatch: 2,
      combinedCanaryAuditFraction: 0.2,
      meanReplicationFactor: 2,
    })).toBe(8);
    expect(() => projectCapacity({
      activeWorkers: 1,
      itemsPerBatch: 1,
      combinedCanaryAuditFraction: Number.NaN,
      meanReplicationFactor: 1,
    })).toThrow(RangeError);
  });

  it("derives degraded, healthy, and pool-offline queue modes truthfully", async () => {
    const subject = setup();
    subject.setObservation(observation(NOW, { minimumEffectiveCapacity: 9 }));
    await expect(subject.service.refreshQueueMode()).resolves.toMatchObject({
      kind: "applied",
      queue: { mode: "degraded", cause: "capacity" },
      effectiveCapacity: 8,
    });
    expect(subject.events.all().map((event) => event.type)).toContain("backpressure");

    subject.clock.advance(60);
    let at = subject.clock.now();
    subject.setObservation(observation(at));
    await expect(subject.service.refreshQueueMode()).resolves.toMatchObject({
      kind: "applied",
      queue: { mode: "normal" },
    });

    subject.clock.advance(60);
    at = subject.clock.now();
    subject.setObservation(observation(at, {
      activeWorkers: 0,
      slotWindow: {
        startsAt: new Date(Date.parse(at) - 60_000).toISOString(),
        endsAt: at,
        providers: [{
          providerSurface: "provider-a",
          expectedArrivals: 2,
          observedArrivals: 0,
        }],
      },
    }));
    await expect(subject.service.refreshQueueMode()).resolves.toMatchObject({
      kind: "applied",
      queue: { mode: "admission_halted", cause: "pool_offline" },
      offlineProviders: ["provider-a"],
    });
    expect(subject.events.all().map((event) => event.type)).toContain("pool_offline");

    subject.clock.advance(60);
    at = subject.clock.now();
    subject.setObservation(observation(at));
    await expect(subject.service.refreshQueueMode()).resolves.toMatchObject({
      kind: "retained",
      queue: { mode: "admission_halted" },
    });
    await expect(subject.service.restoreAdmission()).resolves.toMatchObject({
      kind: "applied",
      queue: { mode: "normal", cause: "operator" },
    });
    expect((await subject.store.listLedger({ kind: "queue_refresh" })).length)
      .toBe(4);
  });

  it("fails malformed observations closed and never auto-restores operator state", async () => {
    const subject = setup();
    subject.setObservation({
      ...observation(NOW),
      observedAt: "2026-08-07T14:59:59.000Z",
    });
    await expect(subject.service.refreshQueueMode()).resolves.toMatchObject({
      kind: "invalid_observation",
      queue: { mode: "normal" },
    });
    await subject.service.pauseAdmission();
    subject.setObservation(observation(NOW));
    await expect(subject.service.refreshQueueMode()).resolves.toMatchObject({
      kind: "retained",
      queue: { mode: "admission_halted", cause: "operator" },
    });
  });

  it("aggregates active and draining policy, persists dwell, and restores explicitly", async () => {
    const subject = setup();
    await addClass(
      subject.store,
      subject.registry,
      "v1",
      policy(2, 3, 60, 300),
      "draining",
    );
    await addClass(
      subject.store,
      subject.registry,
      "v2",
      policy(3, 4, 120, 600),
    );
    subject.setCapacity({
      classId: "class-1",
      availableReviewsPerWeek: 4,
      observedAt: NOW,
    });
    const first = await subject.service.refreshClassHealth("class-1");
    expect(first).toMatchObject({
      kind: "applied",
      health: { health: { operating: "ready" }, adjudicationUnsafeSince: NOW },
      policy: {
        requiredRatePerWeek: 5,
        restoreAbovePerWeek: 7,
        starvationDwell: 60,
        capacityMaxAge: 300,
      },
    });

    subject.clock.advance(61);
    const at = subject.clock.now();
    subject.setCapacity({
      classId: "class-1",
      availableReviewsPerWeek: 4,
      observedAt: at,
    });
    await expect(subject.service.refreshClassHealth("class-1")).resolves
      .toMatchObject({
        kind: "applied",
        health: { health: { operating: "adjudication_starved" } },
      });

    subject.setCapacity({
      classId: "class-1",
      availableReviewsPerWeek: 8,
      observedAt: at,
    });
    await expect(subject.service.refreshClassHealth("class-1")).resolves
      .toMatchObject({
        kind: "unchanged",
        health: { health: { operating: "adjudication_starved" } },
      });
    await expect(subject.service.restoreClassHealth("class-1")).resolves
      .toMatchObject({
        kind: "applied",
        health: { health: { operating: "ready" } },
      });
    expect(subject.events.all().filter((event) =>
      event.type === "class_health_changed"
    )).toHaveLength(2);
  });

  it("keeps operator class admission separate from automatic starvation", async () => {
    const subject = setup();
    await addClass(subject.store, subject.registry, "v1", policy(1, 2, 60, 300));
    await expect(subject.service.setClassAdmission("class-1", true)).resolves
      .toMatchObject({
        kind: "applied",
        health: { health: { operating: "admission_halted" } },
      });
    await expect(subject.service.refreshClassHealth("class-1")).resolves
      .toMatchObject({ kind: "retained" });
    await expect(subject.service.setClassAdmission("class-1", false)).resolves
      .toMatchObject({
        kind: "applied",
        health: { health: { operating: "ready" } },
      });
  });

  it("publishes a two-class emergency halt and health events atomically", async () => {
    const subject = setup();
    await addClass(subject.store, subject.registry, "v1", policy(1, 2, 60, 300));
    await subject.store.registerClassVersion({
      classId: "class-2",
      contractVersion: "v1",
      payloadSchemaHash: "payload-v1",
      outputSchemaHash: "output-v1",
      registeredAt: NOW,
    });
    await subject.store.initializeClassHealth({
      initial: {
        classId: "class-2",
        health: {
          operating: "ready",
          reserves: {
            lowCost: "available",
            urgent: "available",
            splitAndAdjudication: "available",
            audit: "available",
          },
        },
        updatedAt: NOW,
        source: "automatic",
      },
    });
    const outcome = await subject.service.enterEmergencyHalt();
    expect(outcome).toMatchObject({
      kind: "applied",
      queue: { mode: "emergency_halted", cause: "emergency" },
    });
    if (outcome.kind !== "applied") throw new Error("expected emergency halt");
    expect(outcome.classHealth).toHaveLength(2);
    expect(outcome.invalidations).toHaveLength(2);
    expect(subject.events.all().filter((event) =>
      event.type === "class_health_changed"
    )).toHaveLength(2);
    await expect(subject.service.restoreAdmission()).resolves.toMatchObject({
      kind: "retained",
      queue: { mode: "emergency_halted" },
    });
  });
});
