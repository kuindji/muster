import {
  REQUIRED_CONCURRENCY_CASE_IDS,
  REQUIRED_LIFECYCLE_FIXTURE_IDS,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import {
  InMemoryStore,
  StoreOperationNotImplementedError,
} from "../src/memory-store.js";
import {
  runTask1StoreConformance,
  TASK1_STORE_CONFORMANCE_CASES,
} from "../src/store-conformance.js";
import {
  ManualClock,
  RecordingEventSink,
  SequenceIdSource,
} from "../src/testing.js";

const now = "2026-08-06T16:00:00.000Z";

const createStore = (): InMemoryStore => new InMemoryStore({
  initialQueue: { mode: "normal", updatedAt: now },
});

describe("M2 Task 1 reference Store", () => {
  it("passes the reusable control-plane conformance suite", async () => {
    const passed = await runTask1StoreConformance(createStore);
    expect(passed).toEqual(TASK1_STORE_CONFORMANCE_CASES.map((entry) => entry.id));
  });

  it("binds every conformance case to a frozen fixture identity", () => {
    const frozen = new Set([
      ...REQUIRED_CONCURRENCY_CASE_IDS,
      ...REQUIRED_LIFECYCLE_FIXTURE_IDS,
    ]);
    for (const testCase of TASK1_STORE_CONFORMANCE_CASES) {
      expect(frozen.has(testCase.id), testCase.id).toBe(true);
    }
  });

  it("resets deterministically to an explicit queue bootstrap", async () => {
    const store = createStore();
    await store.transitionPermitEpoch({
      classId: "class-1",
      fromEpoch: null,
      toEpoch: "epoch-1",
      at: now,
    });
    await store.reset({
      initialQueue: {
        mode: "degraded",
        updatedAt: "2026-08-06T17:00:00.000Z",
      },
    });
    expect(await store.getCurrentPermitEpoch("class-1")).toBeNull();
    expect(await store.getQueueMode()).toEqual({
      revision: 1,
      mode: "degraded",
      updatedAt: "2026-08-06T17:00:00.000Z",
    });
  });

  it("snapshots command inputs before queued execution", async () => {
    const store = createStore();
    const registration = {
      worker: {
        workerId: "worker-input-snapshot",
        state: "active" as const,
        enrolledAt: now,
        declaredCapPerWeek: 2,
        capabilities: {
          providerSurface: "provider.example",
          unattendedScheduling: true,
          languages: ["en"],
          jobClassIds: ["class-1"],
        },
        accountCluster: "cluster-1",
        slot: 1,
        contractAcceptance: {
          contractVersion: "1.1.0",
          acceptedAt: now,
        },
      },
      routing: {
        contributionWindowId: "2026-W32",
        contributionUsed: 0 as const,
        assignedSlotOccurrence: "2026-W32-slot-1",
      },
    };
    const pending = store.registerWorker(registration);
    registration.worker.capabilities.languages.push("mutated-before-await");
    await pending;
    expect((await store.getWorker("worker-input-snapshot"))?.capabilities.languages)
      .toEqual(["en"]);
  });

  it("fails explicitly for Store slices owned by later M2 tasks", async () => {
    const store = createStore();
    await expect(store.extendLease({
      workerId: "worker-1",
      leaseId: "lease-1",
      expectedExpiry: now,
      expectedExtensionsUsed: 0,
      newExpiry: "2026-08-06T16:05:00.000Z",
      newExtensionsUsed: 1,
    })).rejects.toEqual(
      expect.objectContaining<Partial<StoreOperationNotImplementedError>>({
        name: "StoreOperationNotImplementedError",
        operation: "extendLease",
      }),
    );
  });
});

describe("deterministic Task 1 test ports", () => {
  it("advances manual time and allocates closed identity streams", () => {
    const clock = new ManualClock(now);
    const ids = new SequenceIdSource("suite");
    expect(clock.advance(90)).toBe("2026-08-06T16:01:30.000Z");
    expect(ids.next("lease")).toBe("suite-lease-1");
    expect(ids.next("lease")).toBe("suite-lease-2");
    expect(ids.next("authorization_request")).toBe(
      "suite-authorization_request-1",
    );
    ids.reset();
    expect(ids.next("lease")).toBe("suite-lease-1");
  });

  it("clones emitted events and reset state", () => {
    const sink = new RecordingEventSink();
    const event = {
      type: "pool_offline" as const,
      at: now,
    };
    sink.emit(event);
    const first = sink.all();
    expect(first).toEqual([event]);
    sink.reset();
    expect(sink.all()).toEqual([]);
  });
});
