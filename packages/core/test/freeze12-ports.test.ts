import { describe, expectTypeOf, it } from "vitest";

import type { MusterAuditEvent } from "../src/events.js";
import type {
  AdjudicationLoadSnapshot,
  LedgerEntry,
  OperationsSource,
  QueueCapacityObservation,
  QueueModeSnapshot,
  Store,
} from "../src/ports.js";

describe("revision-23 operations and observability port freeze", () => {
  it("gives queue observations one closed body-blind owner", () => {
    type Observation = ReturnType<OperationsSource["observeQueue"]>;
    expectTypeOf<Observation>().toEqualTypeOf<QueueCapacityObservation>();

    const observation: QueueCapacityObservation = {
      observedAt: "2026-08-07T14:00:00.000Z",
      activeWorkers: 2,
      itemsPerBatch: 1,
      combinedCanaryAuditFraction: 0.1,
      meanReplicationFactor: 2,
      minimumEffectiveCapacity: 0.5,
      slotWindow: {
        startsAt: "2026-08-07T13:00:00.000Z",
        endsAt: "2026-08-07T14:00:00.000Z",
        providers: [{
          providerSurface: "provider-a",
          expectedArrivals: 1,
          observedArrivals: 1,
        }],
      },
    };
    void observation;

    // @ts-expect-error observations cannot select or inspect a job payload
    const invalid: QueueCapacityObservation = { ...observation, payload: {} };
    void invalid;
  });

  it("persists truthful queue causes", () => {
    expectTypeOf<QueueModeSnapshot["cause"]>().toEqualTypeOf<
      | "bootstrap"
      | "capacity"
      | "sla"
      | "pool_offline"
      | "operator"
      | "emergency"
    >();
  });

  it("compares backlog and health in one refresh command", () => {
    type Inspect = Awaited<ReturnType<Store["inspectAdjudicationLoad"]>>;
    type Refresh = Parameters<Store["refreshClassHealth"]>[0];
    expectTypeOf<Inspect>().toEqualTypeOf<AdjudicationLoadSnapshot>();
    expectTypeOf<Refresh["expectedLoad"]>().toEqualTypeOf<
      AdjudicationLoadSnapshot
    >();
    expectTypeOf<Refresh["expectedHealth"]["adjudicationUnsafeSince"]>()
      .toEqualTypeOf<string | undefined>();
  });

  it("makes privacy identity mandatory on closed ledger entries", () => {
    type Append = Parameters<Store["appendLedger"]>[0];
    expectTypeOf<Append>().toEqualTypeOf<LedgerEntry>();
    // @ts-expect-error an unclassified body cannot enter the ledger
    const invalid: LedgerEntry = {
      at: "2026-08-07T14:00:00.000Z",
      kind: "submit",
      outcome: "accepted",
      hashes: { result: "rh1" },
      body: { secret: true },
    };
    void invalid;
  });

  it("keeps contract-transition audit detail hash-only", () => {
    type Transition = Extract<MusterAuditEvent, { type: "contract_transition" }>;
    expectTypeOf<Transition["detailHash"]>().toEqualTypeOf<string | undefined>();
    const invalid: Transition = {
      type: "contract_transition",
      at: "2026-08-07T14:00:00.000Z",
      classId: "class-1",
      contractVersion: "v1",
      from: "active",
      to: "draining",
      // @ts-expect-error arbitrary detail bodies are not audit-event fields
      detail: { acceptedUntil: "later" },
    };
    void invalid;
  });
});
