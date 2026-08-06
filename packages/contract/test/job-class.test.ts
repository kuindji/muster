import { describe, expect, it } from "vitest";

import {
  AXIS_CONFIDENCE,
  PRIVACY_CLASS_RULES,
} from "../src/job-class.js";
import type { JobClass } from "../src/job-class.js";
import { validateMusterSchema } from "../src/schema.js";

type Payload = { items: Array<{ id: string; text: string }> };
type Result = {
  claims: Array<{ itemId: string; claim: string }>;
};

describe("JobClass shape (spec 4.2)", () => {
  it("accepts a fully-declared oneshot class", () => {
    const jobClass: JobClass<Payload, Result> = {
      id: "extract-claims",
      contractVersion: "1.0.0",
      kind: "oneshot",
      outputSchema: {
        $schema: "urn:kuindji:muster:schema:1",
        type: "object",
        additionalProperties: false,
        properties: {
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                itemId: { type: "string" },
                claim: { type: "string" },
              },
              required: ["itemId", "claim"],
              additionalProperties: false,
            },
          },
        },
        required: ["claims"],
      },
      payloadSchema: {
        $schema: "urn:kuindji:muster:schema:1",
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
              },
              required: ["id", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
      },
      maxPayloadBytes: 65_536,
      maxResultBytes: 32_768,
      sanitize: (raw) => raw as Payload,
      verification: "deterministic_oracle",
      resultEvidenceRequirement: {
        predicate: "claims-grounded",
        requiredPayloadPaths: ["$.items"],
        requiredResultPaths: ["$.claims"],
      },
      validators: [{ id: "v1", run: () => ({ kind: "pass" }) }],
      oracles: [
        {
          id: "o1",
          kind: "support",
          predicates: ["claims-grounded"],
          run: () => ({ kind: "pass" }),
          coversPayloadPaths: ["$.items"],
          coversResultPaths: ["$.claims"],
          negativeFixtures: [
            {
              name: "n1",
              predicate: "claims-grounded",
              category: "unsupported_material",
              payload: { items: [] },
              result: {
                claims: [
                  { itemId: "x", claim: "ungrounded" },
                ],
              },
            },
            {
              name: "n2",
              predicate: "claims-grounded",
              category: "out_of_domain",
              payload: { items: [] },
              result: { claims: [] },
            },
          ],
        },
      ],
      agreement: {
        equivalenceKey: (result) => ({ n: result.claims.length }),
        resolveEquivalent: (results) => results[0],
        agreementFixtures: [
          {
            kind: "equivalent",
            results: [
              { claims: [{ itemId: "a", claim: "first" }] },
              { claims: [{ itemId: "b", claim: "second" }] },
            ],
            expected: "equivalent",
          },
          {
            kind: "split",
            results: [
              { claims: [] },
              { claims: [{ itemId: "a", claim: "b" }] },
            ],
            expected: "split",
          },
        ],
      },
      replication: { target: 2, maxSplitEvidenceReroutes: 1 },
      permits: [],
      consequence: "low",
      surface: "unbounded",
      evidenceRequirements: [],
      absenceRequirements: [],
      requires: { unattendedScheduling: true },
      diversity: { axes: ["provider", "slot"], minDistinct: 2 },
      privacy: "internal",
      cost: {
        expectedTurns: 1,
        maxLeaseTtl: 900,
        leaseTtl: () => 900,
        maxInFlightLifetime: 86_400,
      },
      sla: { targetLatency: 3_600, urgency: "normal" },
      escalation: {
        lowCostPerWeek: 50,
        urgentPerWeek: 5,
        splitAndAdjudicationPerWeek: 10,
        auditPerWeek: 10,
        perWorkerLowCostQuotaPerWeek: 5,
        perWorkerUrgentQuotaPerWeek: 1,
      },
      adjudication: {
        requiredRatePerWeek: 65,
        starvationDwell: 172_800,
        restoreAbovePerWeek: 80,
        capacityMaxAge: 86_400,
        maxRejectedDisputeRequeues: 2,
      },
    };

    expect(jobClass.kind).toBe("oneshot");
    expect(jobClass.surface).toBe("unbounded");
    expect(validateMusterSchema(jobClass.payloadSchema).ok).toBe(true);
    expect(validateMusterSchema(jobClass.outputSchema).ok).toBe(true);
  });

  it("freezes axis confidence per spec 6.2", () => {
    expect(AXIS_CONFIDENCE).toEqual({
      slot: "attested",
      provider: "observed",
      accountCluster: "observed",
      language: "observed",
      modelFamily: "self_reported",
    });
  });

  it("freezes privacy-class visibility rules per spec 7", () => {
    expect(PRIVACY_CLASS_RULES.public.ledgerBodies).toBe("full");
    expect(PRIVACY_CLASS_RULES.internal).toEqual({
      bodiesInConsumerNotifications: false,
      descriptorsInConsumerNotifications: false,
      ledgerBodies: "full",
    });
    expect(PRIVACY_CLASS_RULES.sensitive.ledgerBodies).toBe(
      "hash_only",
    );
  });
});
