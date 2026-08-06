import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computeDecisionResultHash,
  computeEffectIntentHash,
  computeInputHash,
  computeResultHash,
  computeSkillSha256,
  computeVerdictHash,
  renderSkill,
  MUSTER_WIRE_CONTRACT_VERSION,
} from "../src/index.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../fixtures/golden-hashes.json", import.meta.url),
    "utf8",
  ),
);

describe("frozen golden vectors (spec 8.2)", () => {
  it("keeps the revision-14 wire contract at 1.1.0", () => {
    expect(MUSTER_WIRE_CONTRACT_VERSION).toBe("1.1.0");
  });
  it("input_hash", async () => {
    expect(await computeInputHash(vectors.input_hash.envelope)).toBe(
      vectors.input_hash.hash,
    );
  });

  it("result_hash", async () => {
    expect(await computeResultHash(vectors.result_hash.body)).toBe(
      vectors.result_hash.hash,
    );
  });

  it("decision_result_hash", async () => {
    expect(
      await computeDecisionResultHash(
        vectors.decision_result_hash.envelope,
      ),
    ).toBe(vectors.decision_result_hash.hash);
  });

  it("decision_result_hash with a bound dispute-verdict hash", async () => {
    expect(
      await computeDecisionResultHash(
        vectors.decision_result_hash_with_verdict.envelope,
      ),
    ).toBe(vectors.decision_result_hash_with_verdict.hash);
    expect(vectors.decision_result_hash_with_verdict.hash).not.toBe(
      vectors.decision_result_hash.hash,
    );
  });

  it("effect_intent_hash", async () => {
    expect(
      await computeEffectIntentHash(vectors.effect_intent_hash.intent),
    ).toBe(vectors.effect_intent_hash.hash);
  });

  it("both adjudication verdict hashes", async () => {
    expect(
      await computeVerdictHash(
        vectors.result_adjudication_verdict_hash.verdict,
      ),
    ).toBe(vectors.result_adjudication_verdict_hash.hash);
    expect(
      await computeVerdictHash(
        vectors.action_adjudication_verdict_hash.verdict,
      ),
    ).toBe(vectors.action_adjudication_verdict_hash.hash);
  });

  it("skill rendering and skill_sha256", async () => {
    const rendered = renderSkill(vectors.skill_sha256.source);
    expect(rendered).toBe(vectors.skill_sha256.rendered);
    expect(await computeSkillSha256(rendered)).toBe(
      vectors.skill_sha256.hash,
    );
  });

  it("hashes are 64 lowercase hex chars", () => {
    for (const key of Object.keys(vectors)) {
      expect(vectors[key].hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
