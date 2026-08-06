import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import serializeReference from "canonicalize";
import {
  canonicalize,
  computeDecisionResultHash,
  computeEffectIntentHash,
  computeInputHash,
  computeResultHash,
  computeMusterSchemaHash,
  computeSkillSha256,
  computeVerdictHash,
  renderSkill,
} from "../dist/index.js";

const output = new URL("./golden-hashes.json", import.meta.url);
const checkOnly = process.argv.includes("--check");
if (existsSync(output) && !process.argv.includes("--force") && !checkOnly) {
  console.error(
    "golden-hashes.json exists; refusing to regenerate without --force (freeze discipline)",
  );
  process.exit(1);
}

const nodeSha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function crossChecked(name, envelope, computed) {
  const referenceCanonical = serializeReference(envelope);
  if (canonicalize(envelope) !== referenceCanonical) {
    throw new Error(
      `${name}: canonical form disagrees with reference implementation`,
    );
  }
  const reference = nodeSha256(referenceCanonical);
  if (computed !== reference) {
    throw new Error(`${name}: digest disagrees with node:crypto reference`);
  }
  return computed;
}

const worker = (suffix) => `worker-${suffix}`;
const evidence = [
  {
    leaseId: "lease-b",
    collectionCycle: 1,
    resultHash: "bb22",
    workerId: worker("w1"),
  },
  {
    leaseId: "lease-a",
    collectionCycle: 1,
    resultHash: "aa11",
    workerId: worker("w2"),
  },
];
const sortedEvidence = [
  {
    leaseId: "lease-a",
    collectionCycle: 1,
    resultHash: "aa11",
    workerId: worker("w2"),
  },
  {
    leaseId: "lease-b",
    collectionCycle: 1,
    resultHash: "bb22",
    workerId: worker("w1"),
  },
];

const inputEnvelope = {
  payload: {
    items: [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ],
  },
  payload_schema: {
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
  job_class_id: "extract-claims",
  contract_version: "1.0.0",
  output_schema: {
    $schema: "urn:kuindji:muster:schema:1",
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  policy_version: "policy-1",
  permit_epoch: "epoch-1",
};

const effectIntent = {
  id: "intent-1",
  effects: [
    {
      action: "suppress",
      descriptor: { reason: "duplicate", of: "item-9" },
    },
    {
      action: "mutateCanonicalState",
      descriptor: { dedupKey: "k-1" },
    },
  ],
};
const sortedIntentEnvelope = {
  id: "intent-1",
  effects: [
    {
      action: "mutateCanonicalState",
      descriptor: { dedupKey: "k-1" },
    },
    {
      action: "suppress",
      descriptor: { reason: "duplicate", of: "item-9" },
    },
  ],
};

const resultVerdict = {
  kind: "human",
  resultAdjudicationRequestId: "rar-1",
  reason: "split_exhausted",
  jobId: "j1",
  collectionCycle: 1,
  inputHash: "ih",
  candidateResultHashes: ["aa11", "bb22"],
  evidence,
  contractVersion: "1.0.0",
  permitEpoch: "epoch-1",
  adjudicatorId: "adj-1",
  decision: { kind: "reject" },
  decidedAt: "2026-08-05T10:00:00.000Z",
};

const actionVerdict = {
  kind: "human",
  jobId: "j1",
  collectionCycle: 1,
  authorizationRequestId: "ar-1",
  effectIntentId: "intent-1",
  effectIntentHash: "eih",
  actions: ["suppress"],
  inputHash: "ih",
  decisionResultHash: "drh",
  evidence,
  contractVersion: "1.0.0",
  permitEpoch: "epoch-1",
  adjudicatorId: "adj-1",
  decision: "approve",
  decidedAt: "2026-08-05T10:00:00.000Z",
};

const skillSource = {
  contractVersion: "1.0.0",
  jobClassIds: ["extract-claims"],
  instructions:
    "Lease one job. Complete it in a single turn. Submit exactly one result.",
};
const decisionEnvelope = { result: { x: 1 }, evidence };
const renderedSkill = renderSkill(skillSource);

const schemaPack = JSON.parse(
  readFileSync(new URL("./schema-conformance.json", import.meta.url), "utf8"),
);
for (const fixture of schemaPack.schemas.filter((entry) => entry.schemaHash)) {
  const computed = await computeMusterSchemaHash(fixture.schema);
  await crossChecked(`schema:${fixture.id}`, fixture.schema, computed);
  if (computed !== fixture.schemaHash) {
    throw new Error(`schema:${fixture.id}: frozen hash differs`);
  }
}

const vectors = {
  input_hash: {
    envelope: inputEnvelope,
    hash: await crossChecked(
      "input_hash",
      inputEnvelope,
      await computeInputHash(inputEnvelope),
    ),
  },
  result_hash: {
    body: { b: 1, a: 2 },
    hash: await crossChecked(
      "result_hash",
      { b: 1, a: 2 },
      await computeResultHash({ b: 1, a: 2 }),
    ),
  },
  decision_result_hash: {
    envelope: decisionEnvelope,
    hash: await crossChecked(
      "decision_result_hash",
      { result: { x: 1 }, evidence: sortedEvidence },
      await computeDecisionResultHash(decisionEnvelope),
    ),
  },
  decision_result_hash_with_verdict: {
    envelope: {
      ...decisionEnvelope,
      result_adjudication_verdict_hash: "vh-1",
    },
    hash: await crossChecked(
      "decision_result_hash_with_verdict",
      {
        result: { x: 1 },
        evidence: sortedEvidence,
        result_adjudication_verdict_hash: "vh-1",
      },
      await computeDecisionResultHash({
        ...decisionEnvelope,
        result_adjudication_verdict_hash: "vh-1",
      }),
    ),
  },
  effect_intent_hash: {
    intent: effectIntent,
    hash: await crossChecked(
      "effect_intent_hash",
      sortedIntentEnvelope,
      await computeEffectIntentHash(effectIntent),
    ),
  },
  result_adjudication_verdict_hash: {
    verdict: resultVerdict,
    hash: await crossChecked(
      "result_verdict",
      { ...resultVerdict, evidence: sortedEvidence },
      await computeVerdictHash(resultVerdict),
    ),
  },
  action_adjudication_verdict_hash: {
    verdict: actionVerdict,
    hash: await crossChecked(
      "action_verdict",
      { ...actionVerdict, evidence: sortedEvidence },
      await computeVerdictHash(actionVerdict),
    ),
  },
  skill_sha256: {
    source: skillSource,
    rendered: renderedSkill,
    hash: await (async () => {
      const computed = await computeSkillSha256(renderedSkill);
      if (computed !== nodeSha256(renderedSkill)) {
        throw new Error("skill_sha256 disagrees with node:crypto reference");
      }
      return computed;
    })(),
  },
};

const renderedVectors = `${JSON.stringify(vectors, null, 2)}\n`;
if (checkOnly) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== renderedVectors) {
    console.error("golden-hashes.json differs from cross-checked generation");
    process.exit(1);
  }
  console.log("golden-hashes.json cross-check ok");
} else {
  writeFileSync(output, renderedVectors);
  console.log("golden-hashes.json written");
}
