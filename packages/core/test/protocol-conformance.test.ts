import { readFileSync } from "node:fs";

import {
  REQUIRED_LIFECYCLE_FIXTURE_IDS,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/memory-store.js";
import {
  runTask9ProtocolConformance,
  TASK9_PROMPT_INJECTION_FIXTURE_IDS,
  TASK9_PROTOCOL_CONFORMANCE_CASES,
  type ProtocolConformanceFixturePack,
  type ProtocolPromptInjectionFixture,
  type ProtocolSchemaFixture,
} from "../src/protocol-conformance.js";

const NOW = "2026-08-07T16:00:00.000Z";

const schemas = JSON.parse(
  readFileSync(
    new URL("../../contract/fixtures/schema-conformance.json", import.meta.url),
    "utf8",
  ),
) as { schemas: ProtocolSchemaFixture[] };

const promptInjections = JSON.parse(
  readFileSync(
    new URL("../../contract/fixtures/prompt-injection.json", import.meta.url),
    "utf8",
  ),
) as ProtocolPromptInjectionFixture[];

const fixtures: ProtocolConformanceFixturePack = {
  schemas: schemas.schemas,
  promptInjections,
};

const createStore = (): InMemoryStore => new InMemoryStore({
  initialQueue: { mode: "normal", updatedAt: NOW },
});

describe("M2 Task 9 protocol conformance kit", () => {
  it("passes every public-operation case against the reference Store", async () => {
    const passed = await runTask9ProtocolConformance(createStore, fixtures);
    expect(passed).toEqual(
      TASK9_PROTOCOL_CONFORMANCE_CASES.map((testCase) => testCase.id),
    );
  });

  it("binds every case to a frozen lifecycle or prompt fixture", () => {
    const frozen = new Set([
      ...REQUIRED_LIFECYCLE_FIXTURE_IDS,
      ...TASK9_PROMPT_INJECTION_FIXTURE_IDS,
    ]);
    for (const testCase of TASK9_PROTOCOL_CONFORMANCE_CASES) {
      expect(testCase.fixtureIds.length, testCase.id).toBeGreaterThan(0);
      for (const fixtureId of testCase.fixtureIds) {
        expect(frozen.has(fixtureId), `${testCase.id}: ${fixtureId}`).toBe(true);
      }
    }
  });

  it("fails closed when the published prompt corpus is incomplete", async () => {
    await expect(runTask9ProtocolConformance(createStore, {
      ...fixtures,
      promptInjections: fixtures.promptInjections.slice(1),
    })).rejects.toThrow("missing prompt-injection fixture injection-direct-1");
  });
});
