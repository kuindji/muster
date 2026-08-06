import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_FIXTURE_AREAS,
  REQUIRED_CONCURRENCY_CASE_IDS,
  REQUIRED_INJECTION_CATEGORIES,
  REQUIRED_LIFECYCLE_FIXTURE_IDS,
  isLifecycleFixture,
} from "../src/lifecycle-fixtures.js";

const fixtures: unknown[] = JSON.parse(
  readFileSync(
    new URL("../fixtures/lifecycle-fixtures.json", import.meta.url),
    "utf8",
  ),
);
const cases: Array<{ id: string; description: string }> = JSON.parse(
  readFileSync(
    new URL("../fixtures/store-concurrency-cases.json", import.meta.url),
    "utf8",
  ),
);
const corpus: Array<{ id: string; category: string; payloadText: string }> =
  JSON.parse(
    readFileSync(
      new URL("../fixtures/prompt-injection.json", import.meta.url),
      "utf8",
    ),
  );
const packageManifest: {
  files: string[];
  exports: Record<string, unknown>;
} = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("lifecycle fixture pack (spec 11.1)", () => {
  it("every fixture is well-formed with a unique id", () => {
    const ids = new Set<string>();
    for (const fixture of fixtures) {
      expect(isLifecycleFixture(fixture), JSON.stringify(fixture)).toBe(true);
      const id = (fixture as { id: string }).id;
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it("rejects malformed fixtures instead of ignoring the malformation", () => {
    const wellFormed = {
      id: "x",
      version: 1,
      description: "d",
      area: "submission_retry",
      setup: {},
      conditions: [],
      steps: [{ command: "submit", args: {} }],
      expectFinal: { states: { job1: "completed" } },
    };
    expect(isLifecycleFixture(wellFormed)).toBe(true);

    const malformed: Array<[string, unknown]> = [
      ["typo'd barrier key", { ...wellFormed, steps: [
        { command: "submit", args: {}, barier: "r" },
        { command: "submit", args: {}, barier: "r" },
      ] }],
      ["typo'd step expect key", { ...wellFormed, steps: [
        { command: "submit", args: {}, expct: { kind: "accepted" } },
      ] }],
      ["unknown top-level key", { ...wellFormed, expectFnial: {} }],
      ["unknown expectFinal key", {
        ...wellFormed, expectFinal: { staets: {} },
      }],
      ["array where a record is required", {
        ...wellFormed, expectFinal: { states: ["completed"] },
      }],
      ["array as step args", { ...wellFormed, steps: [
        { command: "submit", args: [] },
      ] }],
      ["null step must fail", { ...wellFormed, steps: [null] }],
      ["barrier without expectOneOf", { ...wellFormed, steps: [
        { command: "submit", args: {}, barrier: "r" },
      ] }],
      ["empty expectOneOf", { ...wellFormed, expectOneOf: [] }],
      ["unknown command", { ...wellFormed, steps: [
        { command: "teleport", args: {} },
      ] }],
      ["missing revision-14 required arg", { ...wellFormed, steps: [
        { command: "compareAndClaimLease", args: {
          leaseId: "l1", candidateRevision: "cr1",
        } },
      ] }],
      ["unknown revision-14 arg", { ...wellFormed, steps: [
        { command: "compareAndClaimLease", args: {
          leaseId: "l1", candidateRevision: "cr1", workerRevision: "wr1",
          candidateRevison: "typo",
        } },
      ] }],
      ["non-finite charge", {
        ...wellFormed, expectFinal: { charges: { urgent: NaN } },
      }],
    ];
    for (const [why, fixture] of malformed) {
      expect(
        () => isLifecycleFixture(fixture),
        `${why} - threw instead of returning false`,
      ).not.toThrow();
      expect(isLifecycleFixture(fixture), why).toBe(false);
    }
  });

  it("every area has at least one fixture", () => {
    for (const area of LIFECYCLE_FIXTURE_AREAS) {
      expect(
        fixtures.some((fixture) =>
          (fixture as { area: string }).area === area,
        ),
        `no fixtures for area ${area}`,
      ).toBe(true);
    }
  });

  it("the 11.1 required-case matrix is fully present", () => {
    const ids = new Set(fixtures.map((fixture) =>
      (fixture as { id: string }).id,
    ));
    for (const required of REQUIRED_LIFECYCLE_FIXTURE_IDS) {
      expect(ids.has(required), `missing required fixture ${required}`).toBe(true);
    }
  });

  it("class-qualifies every frozen invalidation command", () => {
    const invalidationCommands = new Set([
      "contractExpire",
      "emergencyHalt",
      "emergencyWithdrawEpoch",
      "operatorCancel",
    ]);
    for (const fixture of fixtures as Array<{
      id: string;
      steps: Array<{ command: string; args: Record<string, unknown> }>;
    }>) {
      for (const step of fixture.steps) {
        if (invalidationCommands.has(step.command)) {
          expect(typeof step.args.classId, `${fixture.id}:${step.command}`)
            .toBe("string");
        }
      }
    }
  });

  it("the store concurrency case list covers the frozen 8.1 matrix", () => {
    const ids = new Set(cases.map((entry) => entry.id));
    expect(ids.size).toBe(cases.length);
    for (const entry of cases) {
      expect(Object.keys(entry).sort(), entry.id).toEqual([
        "description",
        "id",
      ]);
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    for (const required of REQUIRED_CONCURRENCY_CASE_IDS) {
      expect(ids.has(required), `missing concurrency case ${required}`).toBe(true);
    }
  });

  it("the injection corpus covers every frozen category", () => {
    const categories = new Set(corpus.map((entry) => entry.category));
    for (const required of REQUIRED_INJECTION_CATEGORIES) {
      expect(
        categories.has(required),
        `missing injection category ${required}`,
      ).toBe(true);
    }
    for (const entry of corpus) {
      expect(Object.keys(entry).sort(), entry.id).toEqual([
        "category",
        "id",
        "payloadText",
      ]);
      expect(entry.payloadText.length).toBeGreaterThan(0);
    }
  });

  it("publishes every frozen fixture through an explicit package export", () => {
    const fixtureNames = [
      "golden-hashes.json",
      "jcs-rfc8785.json",
      "lifecycle-fixtures.json",
      "prompt-injection.json",
      "schema-conformance.json",
      "store-concurrency-cases.json",
    ];
    expect(packageManifest.files).toContain("fixtures/*.json");
    for (const name of fixtureNames) {
      expect(Object.hasOwn(packageManifest.exports, `./fixtures/${name}`))
        .toBe(true);
    }
  });
});
