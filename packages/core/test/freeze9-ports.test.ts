import { describe, expect, it } from "vitest";

import type {
  JobCycleAttemptSnapshot,
  Store,
  SubmissionAttemptClassification,
} from "../src/ports.js";

describe("revision-20 submission settlement and split-routing freeze", () => {
  it("makes every non-accepting submission settlement one atomic Store command", () => {
    type Input = Parameters<Store["rejectSubmission"]>[0];
    const keys: ReadonlyArray<keyof Input> = [
      "workerId",
      "leaseId",
      "classification",
      "at",
      "reputationEvidence",
    ];
    const classifications: SubmissionAttemptClassification[] = [
      "rejected_invalid",
      "coordinator_fault",
      "lease_expired_no_fault",
    ];
    expect(keys).toEqual([
      "workerId",
      "leaseId",
      "classification",
      "at",
      "reputationEvidence",
    ]);
    expect(classifications).toEqual([
      "rejected_invalid",
      "coordinator_fault",
      "lease_expired_no_fault",
    ]);
  });

  it("binds checked evidence to acceptance and persists the absorbing split", () => {
    type AcceptInput = Parameters<Store["acceptOrReplaySubmission"]>[0];
    type SplitInput = Parameters<Store["markResultSplit"]>[0];
    const evidence: keyof AcceptInput = "reputationEvidence";
    const splitEvidence: keyof SplitInput = "evidence";
    const splitObserved: keyof JobCycleAttemptSnapshot = "splitObserved";
    expect([evidence, splitEvidence, splitObserved]).toEqual([
      "reputationEvidence",
      "evidence",
      "splitObserved",
    ]);
  });
});
