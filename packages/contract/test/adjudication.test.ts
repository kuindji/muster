import { describe, expect, it } from "vitest";

import {
  computeVerdictHash,
  validateActionSet,
  validateCandidateHashes,
  validateResultDisputeProvenance,
} from "../src/adjudication.js";
import type {
  ActionAuthorization,
  AuthorizationInitialReceipt,
  ResultAdjudicationVerdict,
} from "../src/adjudication.js";
import { hashCanonical } from "../src/canonical/sha256.js";

const workerId = (suffix: string) => `worker-${suffix}`;
const evidence = [
  {
    leaseId: "l1",
    collectionCycle: 1,
    resultHash: "aa11",
    workerId: workerId("w1"),
  },
  {
    leaseId: "l2",
    collectionCycle: 1,
    resultHash: "bb22",
    workerId: workerId("w2"),
  },
];

const verdict: ResultAdjudicationVerdict = {
  kind: "human",
  resultAdjudicationRequestId: "rar-1",
  reason: "split_exhausted",
  jobId: "j1",
  collectionCycle: 1,
  inputHash: "ih",
  candidateResultHashes: ["aa11", "bb22"],
  evidence,
  contractVersion: "1.0.0",
  permitEpoch: "e1",
  adjudicatorId: "adj-1",
  decision: { kind: "reject" },
  decidedAt: "2026-08-05T10:00:00.000Z",
};

describe("verdict hashing (spec 6.6)", () => {
  it("is SHA-256(JCS(canonical verdict))", async () => {
    await expect(computeVerdictHash(verdict)).resolves.toBe(
      await hashCanonical(verdict),
    );
  });

  it("caller-supplied evidence order does not change the hash", async () => {
    const reordered = {
      ...verdict,
      evidence: [evidence[1]!, evidence[0]!],
    };

    await expect(computeVerdictHash(reordered)).resolves.toBe(
      await computeVerdictHash(verdict),
    );
  });

  it("semantic changes alter retry/conflict discrimination", async () => {
    const other = {
      ...verdict,
      decision: { kind: "resolve", result: { x: 1 } },
    } as ResultAdjudicationVerdict;

    await expect(computeVerdictHash(other)).resolves.not.toBe(
      await computeVerdictHash(verdict),
    );
  });
});

describe("canonical action sets (spec 8.2)", () => {
  it("accepts a sorted, unique, known set", () => {
    expect(
      validateActionSet(["mutateCanonicalState", "suppress"]),
    ).toEqual({ ok: true });
  });

  it("rejects unsorted, duplicate, unknown, and empty sets", () => {
    expect(
      validateActionSet(["suppress", "mutateCanonicalState"]).ok,
    ).toBe(false);
    expect(validateActionSet(["suppress", "suppress"]).ok).toBe(false);
    expect(validateActionSet(["detonate" as never]).ok).toBe(false);
    expect(validateActionSet([]).ok).toBe(false);
  });
});

describe("result-dispute provenance rule (spec 6.6)", () => {
  it("requires the bound hash after a human-resolved dispute", () => {
    expect(
      validateResultDisputeProvenance(
        { resultAdjudicationVerdictHash: "vh" },
        { humanResolvedDispute: true, boundVerdictHash: "vh" },
      ),
    ).toEqual({ ok: true });
    expect(
      validateResultDisputeProvenance(
        {},
        { humanResolvedDispute: true, boundVerdictHash: "vh" },
      ).ok,
    ).toBe(false);
    expect(
      validateResultDisputeProvenance(
        { resultAdjudicationVerdictHash: "other" },
        { humanResolvedDispute: true, boundVerdictHash: "vh" },
      ).ok,
    ).toBe(false);
  });

  it("requires the hash to be absent without a dispute", () => {
    expect(
      validateResultDisputeProvenance(
        {},
        { humanResolvedDispute: false },
      ),
    ).toEqual({ ok: true });
    expect(
      validateResultDisputeProvenance(
        { resultAdjudicationVerdictHash: "vh" },
        { humanResolvedDispute: false },
      ).ok,
    ).toBe(false);
  });
});

describe("candidate hash set rule (spec 6.6)", () => {
  it("accepts unique, bytewise-sorted, evidence-matching hashes", () => {
    expect(
      validateCandidateHashes(["aa11", "bb22"], evidence, 1),
    ).toEqual({ ok: true });
  });

  it("rejects unsorted hashes", () => {
    expect(
      validateCandidateHashes(["bb22", "aa11"], evidence, 1).ok,
    ).toBe(false);
  });

  it("rejects duplicate hashes", () => {
    expect(
      validateCandidateHashes(
        ["aa11", "aa11", "bb22"],
        evidence,
        1,
      ).ok,
    ).toBe(false);
  });

  it("rejects a set unequal to the evidence projection", () => {
    expect(validateCandidateHashes(["aa11"], evidence, 1).ok).toBe(
      false,
    );
    expect(
      validateCandidateHashes(["aa11", "cc33"], evidence, 1).ok,
    ).toBe(false);
  });

  it("deduplicates the evidence projection", () => {
    const duplicateEvidence = [
      ...evidence,
      {
        leaseId: "l3",
        collectionCycle: 1,
        resultHash: "aa11",
        workerId: workerId("w3"),
      },
    ];

    expect(
      validateCandidateHashes(
        ["aa11", "bb22"],
        duplicateEvidence,
        1,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects evidence from another collection cycle", () => {
    expect(
      validateCandidateHashes(["aa11", "bb22"], evidence, 2).ok,
    ).toBe(false);
  });
});

describe("authorization initial receipt (spec revision 12, 4.3)", () => {
  it("authorized arm contains the complete immutable authorization", () => {
    const authorization = {
      authorizationRequestId: "ar1",
    } as ActionAuthorization;
    const receipt: AuthorizationInitialReceipt = {
      authorizationRequestId: "ar1",
      effectIntentId: "ei1",
      effectIntentHash: "eh",
      jobId: "j1",
      collectionCycle: 1,
      decisionResultHash: "dh",
      at: "2026-08-05T10:00:00.000Z",
      outcome: "authorized",
      authorization,
    };

    expect(receipt.authorization).toBe(authorization);
  });

  it("pending and denied arms cannot invent an authorization", () => {
    const invalid: AuthorizationInitialReceipt = {
      authorizationRequestId: "ar1",
      effectIntentId: "ei1",
      effectIntentHash: "eh",
      jobId: "j1",
      collectionCycle: 1,
      decisionResultHash: "dh",
      at: "t",
      outcome: "pending_adjudication",
      // @ts-expect-error pending receipts never carry an authorization
      authorization: {},
    };
    void invalid;
  });
});
