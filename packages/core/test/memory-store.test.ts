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
  runTask5StoreConformance,
  TASK5_STORE_CONFORMANCE_CASES,
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

describe("M2 Task 5 reference Store boundary", () => {
  it("passes the reusable Store conformance suite through submission settlement", async () => {
    const passed = await runTask5StoreConformance(createStore);
    expect(passed).toEqual(TASK5_STORE_CONFORMANCE_CASES.map((entry) => entry.id));
  });

  it("binds every conformance case to a frozen fixture identity", () => {
    const frozen = new Set([
      ...REQUIRED_CONCURRENCY_CASE_IDS,
      ...REQUIRED_LIFECYCLE_FIXTURE_IDS,
    ]);
    for (const testCase of TASK5_STORE_CONFORMANCE_CASES) {
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
    await expect(store.authorizeOrReplayIntent({} as never)).rejects.toEqual(
      expect.objectContaining<Partial<StoreOperationNotImplementedError>>({
        name: "StoreOperationNotImplementedError",
        operation: "authorizeOrReplayIntent",
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

describe("reference Store reputation evidence needed by Task 3 probation", () => {
  it("records idempotently, conflicts on identity reuse, and reads in order", async () => {
    const store = createStore();
    const later = {
      evidenceId: "evidence-b",
      workerId: "worker-1",
      at: "2026-08-06T16:02:00.000Z",
      source: "checked_success" as const,
      impact: "positive" as const,
    };
    const earlier = {
      ...later,
      evidenceId: "evidence-a",
      at: "2026-08-06T16:01:00.000Z",
    };
    await expect(store.recordReputationEvidence(later))
      .resolves.toMatchObject({ kind: "recorded" });
    await expect(store.recordReputationEvidence(earlier))
      .resolves.toMatchObject({ kind: "recorded" });
    await expect(store.recordReputationEvidence(later))
      .resolves.toMatchObject({ kind: "replayed" });
    await expect(store.recordReputationEvidence({
      ...later,
      workerId: "worker-2",
    })).resolves.toMatchObject({
      kind: "conflict",
      existing: { workerId: "worker-1" },
    });
    expect(await store.listReputationEvidence("worker-1"))
      .toEqual([earlier, later]);
    expect(await store.listReputationEvidence("worker-2")).toEqual([]);
  });
});
