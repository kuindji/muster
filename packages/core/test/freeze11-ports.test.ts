import type {
  ActionAdjudicationVerdict,
  ResultAdjudicationVerdict,
} from "@kuindji/muster-contract";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AUTHORIZATION_RESERVE_LANE_ORDER,
  type ActionVerdictContextSnapshot,
  type AuthorizationContextSnapshot,
  type AuthorizationReserveBatchResult,
  type ResultVerdictContextSnapshot,
  type Store,
  type VerdictHistoryRecord,
} from "../src/ports.js";

const processedAt = "2026-08-07T13:00:00.000Z";

describe("revision-22 action-authorization port freeze", () => {
  it("freezes the canonical authorization reserve lane order", () => {
    expect(AUTHORIZATION_RESERVE_LANE_ORDER).toEqual([
      "lowCost",
      "urgent",
      "splitAndAdjudication",
    ]);
  });

  it("requires a complete authorization context and a charge batch", () => {
    type Input = Parameters<Store["authorizeOrReplayIntent"]>[0];
    type Context = Input["expectedContext"];
    type Decision = Exclude<Input["decision"], { kind: "deny" }>;
    const context: Context = {} as AuthorizationContextSnapshot;
    const decision = {} as Decision;
    void [context.maxInFlightDeadline, decision.kind];

    // @ts-expect-error a first authorization must compare its live context
    const invalid: Input = {
      authorizationRequestId: "request-1",
      effectIntent: { id: "intent-1", effects: [
        { action: "routeToUrgent", descriptor: {} },
      ] },
      effectIntentHash: "intent-hash",
      decisionResultHash: "decision-hash",
      decision: { kind: "deny", reason: "gate_failed" },
      at: processedAt,
    };
    void invalid;
  });

  it("publishes one aggregate reserve result with ordered settlements", () => {
    const result = {} as AuthorizationReserveBatchResult;
    expectTypeOf(result.settlements).toMatchTypeOf<readonly unknown[]>();
    expectTypeOf(result.skippedLanes).toMatchTypeOf<
      readonly ("lowCost" | "urgent" | "splitAndAdjudication")[]
    >();
    expectTypeOf<AuthorizationReserveBatchResult["classHealth"]["revision"]>()
      .toEqualTypeOf<number>();
  });

  it("separates authenticated decision time from coordinator processing time", () => {
    type ResultInput = Parameters<Store["applyResultAdjudicationVerdict"]>[0];
    type ActionInput = Parameters<Store["applyActionAdjudicationVerdict"]>[0];
    const result = {} as ResultInput;
    const action = {} as ActionInput;
    expectTypeOf(result.processedAt).toEqualTypeOf<string>();
    expectTypeOf(result.expectedContext).toEqualTypeOf<ResultVerdictContextSnapshot>();
    expectTypeOf(action.processedAt).toEqualTypeOf<string>();
    expectTypeOf(action.expectedContext).toEqualTypeOf<ActionVerdictContextSnapshot>();

    // @ts-expect-error the Store command no longer accepts ambiguous `at`
    const oldResultTime: Pick<ResultInput, "at"> = { at: processedAt };
    void oldResultTime;
  });

  it("exposes canonical verdict history before mutable runtime checks", () => {
    type Lookup = Awaited<ReturnType<Store["getVerdictHistory"]>>;
    const history = {} as NonNullable<Lookup>;
    expectTypeOf(history).toEqualTypeOf<VerdictHistoryRecord>();
    expectTypeOf(history.verdict).toEqualTypeOf<
      ResultAdjudicationVerdict | ActionAdjudicationVerdict
    >();
    expectTypeOf(history.kind).toEqualTypeOf<"result" | "action">();
  });
});
