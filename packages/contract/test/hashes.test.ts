import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/canonical/sha256.js";
import {
  computeDecisionResultHash,
  computeInputHash,
  computeResultHash,
} from "../src/hashes.js";

const envelope = {
  payload: {
    items: [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ],
  },
  payload_schema: {
    type: "object",
    additionalProperties: false,
    properties: { items: { type: "array" } },
  },
  job_class_id: "extract-claims",
  contract_version: "1.0.0",
  output_schema: {
    type: "object",
    additionalProperties: false,
  },
  policy_version: "policy-1",
  permit_epoch: "epoch-1",
};

describe("input_hash (spec revision 12, 5.4)", () => {
  it("is hashCanonical of the frozen seven-key envelope", async () => {
    await expect(computeInputHash(envelope)).resolves.toBe(
      await hashCanonical(envelope),
    );
  });

  it("array order inside the canonical payload is significant", async () => {
    const swapped = {
      ...envelope,
      payload: {
        items: [
          envelope.payload.items[1]!,
          envelope.payload.items[0]!,
        ],
      },
    };

    await expect(computeInputHash(swapped)).resolves.not.toBe(
      await computeInputHash(envelope),
    );
  });

  it("payload schema enters the hash", async () => {
    const changed = {
      ...envelope,
      payload_schema: {
        ...envelope.payload_schema,
        title: "changed",
      },
    };

    await expect(computeInputHash(changed)).resolves.not.toBe(
      await computeInputHash(envelope),
    );
  });

  it("permit epoch enters the hash", async () => {
    await expect(
      computeInputHash({ ...envelope, permit_epoch: "epoch-2" }),
    ).resolves.not.toBe(await computeInputHash(envelope));
  });
});

describe("result_hash (spec 6.5 step 2)", () => {
  it("is canonicalization-then-digest, key-order independent", async () => {
    await expect(computeResultHash({ b: 1, a: 2 })).resolves.toBe(
      await computeResultHash({ a: 2, b: 1 }),
    );
  });
});

describe("decision_result_hash (spec 6.5 step 11)", () => {
  const workerId = (suffix: string) => `worker-${suffix}`;
  const evidence = [
    {
      leaseId: "lease-b",
      collectionCycle: 1,
      resultHash: "hash-1",
      workerId: workerId("w1"),
    },
    {
      leaseId: "lease-a",
      collectionCycle: 1,
      resultHash: "hash-1",
      workerId: workerId("w2"),
    },
  ];

  it("sorts evidence bytewise by leaseId", async () => {
    const sorted = [evidence[1]!, evidence[0]!];

    await expect(
      computeDecisionResultHash({ result: { x: 1 }, evidence }),
    ).resolves.toBe(
      await hashCanonical({ result: { x: 1 }, evidence: sorted }),
    );
  });

  it("evidence input order does not matter", async () => {
    await expect(
      computeDecisionResultHash({ result: { x: 1 }, evidence }),
    ).resolves.toBe(
      await computeDecisionResultHash({
        result: { x: 1 },
        evidence: [evidence[1]!, evidence[0]!],
      }),
    );
  });

  it("rejects mixed collection cycles", async () => {
    const mixed = [
      evidence[0]!,
      { ...evidence[1]!, collectionCycle: 2 },
    ];

    await expect(
      computeDecisionResultHash({ result: { x: 1 }, evidence: mixed }),
    ).rejects.toThrow("mixed collection cycles");
  });

  it("verdict hash present vs absent changes the digest; absent key is omitted", async () => {
    const withVerdict = await computeDecisionResultHash({
      result: { x: 1 },
      evidence,
      result_adjudication_verdict_hash: "vh-1",
    });
    const withoutVerdict = await computeDecisionResultHash({
      result: { x: 1 },
      evidence,
    });

    expect(withVerdict).not.toBe(withoutVerdict);
    expect(withoutVerdict).toBe(
      await hashCanonical({
        result: { x: 1 },
        evidence: [evidence[1]!, evidence[0]!],
      }),
    );
  });
});
