import type {
  ActionPermit,
  JobClass,
  JSONSchema,
} from "@kuindji/muster-contract";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/memory-store.js";
import {
  ClassRegistrationService,
  RuntimeClassRegistry,
} from "../src/registration.js";
import { ManualClock } from "../src/testing.js";

type Payload = { items: string[] };
type Result = { items: string[] };

const now = "2026-08-06T20:00:00.000Z";
const deploymentPolicy = {
  version: "deployment-1",
  extensionTtl: 300,
  maxExtensionsPerLease: 1,
};

const objectSchema = (property: string, itemType: "string" | "integer" = "string"): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: {
    [property]: {
      type: "array",
      items: { type: itemType },
    },
  },
  required: [property],
});

const effectSchema: JSONSchema = {
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: {
    count: { type: "integer" },
    note: { type: "string" },
  },
  required: ["count", "note"],
};

const minimalClass = (): JobClass<Payload, Result> => ({
  id: "minimal-class",
  contractVersion: "1.0.0",
  kind: "oneshot",
  payloadSchema: objectSchema("items"),
  outputSchema: objectSchema("items"),
  maxPayloadBytes: 4_096,
  maxResultBytes: 4_096,
  sanitize: (raw) => raw as Payload,
  verification: "structural_only",
  validators: [],
  oracles: [],
  replication: { target: 1, maxSplitEvidenceReroutes: 0 },
  permits: [],
  consequence: "low",
  surface: "unbounded",
  evidenceRequirements: [],
  absenceRequirements: [],
  requires: {},
  privacy: "internal",
  cost: {
    expectedTurns: 1,
    maxLeaseTtl: 300,
    leaseTtl: () => 300,
    maxInFlightLifetime: 601,
  },
  escalation: {
    lowCostPerWeek: 0,
    urgentPerWeek: 0,
    splitAndAdjudicationPerWeek: 0,
    retrospectiveAuditProjectionPerWeek: 0,
    auditPerWeek: 0,
    perWorkerLowCostQuotaPerWeek: 0,
    perWorkerUrgentQuotaPerWeek: 0,
  },
});

const automaticClass = (): JobClass<Payload, Result> => {
  const jobClass = minimalClass();
  jobClass.id = "automatic-class";
  jobClass.verification = "deterministic_oracle";
  jobClass.resultEvidenceRequirement = {
    predicate: "items-supported",
    requiredPayloadPaths: ["$.items"],
    requiredResultPaths: ["$.items"],
  };
  jobClass.oracles = [
    {
      id: "support-oracle",
      kind: "support",
      predicates: ["items-supported"],
      run: (payload, result) =>
        result.items.every((item) => payload.items.includes(item))
          ? { kind: "pass" }
          : { kind: "fail", code: "unsupported" },
      coversPayloadPaths: ["$.items"],
      coversResultPaths: ["$.items"],
      negativeFixtures: [
        {
          name: "support-out-of-domain",
          predicate: "items-supported",
          category: "out_of_domain",
          payload: { items: [] },
          result: { items: ["outside"] },
        },
        {
          name: "support-unsupported",
          predicate: "items-supported",
          category: "unsupported_material",
          payload: { items: ["known"] },
          result: { items: ["invented"] },
        },
      ],
    },
    {
      id: "completeness-oracle",
      kind: "completeness",
      predicates: ["items-complete"],
      run: (payload, result) =>
        payload.items.every((item) => result.items.includes(item))
          ? { kind: "pass" }
          : { kind: "fail", code: "omitted" },
      coversPayloadPaths: ["$.items"],
      coversResultPaths: ["$.items"],
      absenceDomain: { id: "all-items", payloadPaths: ["$.items"] },
      negativeFixtures: [
        {
          name: "complete-out-of-domain",
          predicate: "items-complete",
          category: "out_of_domain",
          payload: { items: ["outside"] },
          result: { items: [] },
        },
        {
          name: "complete-omission",
          predicate: "items-complete",
          category: "omitted_material",
          payload: { items: ["missing"] },
          result: { items: [] },
        },
      ],
    },
  ];
  jobClass.permits = [{
    action: "updateRetrievalIndex",
    mode: "automatic",
    effectSchema,
    effectInput: {
      payloadPaths: ["$.items"],
      resultPaths: ["$.items"],
    },
    deriveEffect: ({ result }) => ({
      count: (result as Result).items.length,
      note: "fixture",
    }),
    effectFixtures: [{
      input: {
        payload: { items: ["one"] },
        result: { items: ["one"] },
      },
      expectedDescriptor: { count: 1, note: "fixture" },
    }],
  }];
  jobClass.evidenceRequirements = [{
    action: "updateRetrievalIndex",
    predicate: "items-supported",
    requiredPayloadPaths: ["$.items"],
    requiredResultPaths: ["$.items"],
  }];
  jobClass.absenceRequirements = [{
    action: "updateRetrievalIndex",
    predicate: "items-complete",
    requiredPayloadPaths: ["$.items"],
    requiredResultPaths: ["$.items"],
    requiredDomain: { id: "required-items", payloadPaths: ["$.items"] },
  }];
  return jobClass;
};

const humanClass = (): JobClass<Payload, Result> => {
  const jobClass = minimalClass();
  jobClass.id = "human-class";
  const permit: ActionPermit = {
    action: "suppress",
    mode: "human_only",
    effectSchema,
    reviewRequirement: {
      predicate: "human-confirms-suppression",
      requiredPayloadPaths: ["$.items"],
      requiredResultPaths: ["$.items"],
      requiredEffectPaths: ["$.count", "$.note"],
      requiredAbsenceDomain: {
        id: "human-items",
        payloadPaths: ["$.items"],
      },
    },
  };
  jobClass.permits = [permit];
  jobClass.adjudication = {
    requiredRatePerWeek: 0,
    restoreAbovePerWeek: 1,
    starvationDwell: 60,
    capacityMaxAge: 60,
    maxRejectedDisputeRequeues: 0,
  };
  return jobClass;
};

const serviceFor = (store = new InMemoryStore({
  initialQueue: { mode: "normal", updatedAt: now },
})) => {
  const clock = new ManualClock(now);
  const registry = new RuntimeClassRegistry();
  return {
    clock,
    registry,
    store,
    service: new ClassRegistrationService({
      store,
      clock,
      registry,
      deploymentPolicy,
    }),
  };
};

describe("M2 Task 2 class registration", () => {
  it("registers a minimal class, initializes health, and replays across time", async () => {
    const { clock, registry, service, store } = serviceFor();
    const jobClass = minimalClass();
    const first = await service.register(jobClass);
    expect(first).toMatchObject({
      ok: true,
      kind: "registered",
      record: { state: "draft", registeredAt: now },
      health: { revision: 1, health: { operating: "ready" } },
    });

    clock.advance(60);
    const replay = await service.register(jobClass);
    expect(replay).toMatchObject({
      ok: true,
      kind: "replayed",
      record: { registeredAt: now },
      health: { revision: 1, updatedAt: now },
    });
    expect(await registry.compatibility(store, jobClass.id, jobClass.contractVersion))
      .toMatchObject({ ok: true });
    expect(Object.isFrozen(jobClass)).toBe(true);
    expect(Object.isFrozen(jobClass.payloadSchema)).toBe(true);
    expect(() => {
      jobClass.payloadSchema.type = "string";
    }).toThrow(TypeError);
  });

  it("accepts automatic completeness-gated and human-only classes", async () => {
    const { service } = serviceFor();
    await expect(service.register(automaticClass())).resolves.toMatchObject({
      ok: true,
      kind: "registered",
    });
    await expect(service.register(humanClass())).resolves.toMatchObject({
      ok: true,
      kind: "registered",
    });
  });

  it("shares durable class health across contract versions", async () => {
    const { service, store } = serviceFor();
    const first = minimalClass();
    const second = minimalClass();
    second.contractVersion = "2.0.0";
    expect((await service.register(first)).ok).toBe(true);
    const health = await store.getClassHealth(first.id);
    expect(health).not.toBeNull();
    await store.transitionClassHealth({
      expected: health!,
      next: {
        health: { operating: "admission_halted" },
        updatedAt: "2026-08-06T20:01:00.000Z",
        source: "operator",
      },
    });
    const registered = await service.register(second);
    expect(registered).toMatchObject({
      ok: true,
      health: { revision: 2, health: { operating: "admission_halted" } },
    });
  });

  it("returns deterministic issues spanning policy, paths, and coverage", async () => {
    const { service } = serviceFor();
    const jobClass = automaticClass();
    jobClass.maxPayloadBytes = 0;
    jobClass.cost.maxInFlightLifetime = 600;
    jobClass.escalation.auditPerWeek = 1;
    jobClass.escalation.retrospectiveAuditProjectionPerWeek = 2;
    jobClass.evidenceRequirements = [];
    jobClass.oracles[0]!.coversPayloadPaths = ["$.missing"];
    const result = await service.register(jobClass);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "size_limit_invalid",
      "lease_policy_invalid",
      "reserve_invalid",
      "requirement_invalid",
      "path_not_declared",
    ]));
    expect(result.issues).toEqual([...result.issues].sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      (left.detail ?? "").localeCompare(right.detail ?? "")
    ));
  });

  it("never lets a completeness oracle satisfy ordinary support", async () => {
    const { service } = serviceFor();
    const jobClass = automaticClass();
    jobClass.resultEvidenceRequirement!.predicate = "items-complete";
    const result = await service.register(jobClass);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "oracle_coverage_missing",
        path: "$.resultEvidenceRequirement",
      }),
    ]));
  });

  it.each([
    {
      name: "duplicate ids",
      change: (jobClass: JobClass<Payload, Result>) => {
        jobClass.validators = [
          { id: "same", run: () => ({ kind: "pass" }) },
          { id: "same", run: () => ({ kind: "pass" }) },
        ];
      },
      code: "duplicate_id",
    },
    {
      name: "malformed requirement paths",
      change: (jobClass: JobClass<Payload, Result>) => {
        jobClass.resultEvidenceRequirement!.requiredPayloadPaths = ["$..items"];
      },
      code: "path_invalid",
    },
    {
      name: "incomplete support coverage",
      change: (jobClass: JobClass<Payload, Result>) => {
        jobClass.oracles[0]!.coversResultPaths = [];
      },
      code: "oracle_coverage_missing",
    },
    {
      name: "absence-domain containment failures",
      change: (jobClass: JobClass<Payload, Result>) => {
        jobClass.oracles[1]!.absenceDomain = {
          id: "only-array-elements",
          payloadPaths: ["$.items[*]"],
        };
      },
      code: "oracle_coverage_missing",
    },
    {
      name: "invalid negative-fixture families",
      change: (jobClass: JobClass<Payload, Result>) => {
        jobClass.oracles[0]!.negativeFixtures = [
          jobClass.oracles[0]!.negativeFixtures[0]!,
        ];
      },
      code: "oracle_fixture_invalid",
    },
  ])("rejects $name", async ({ change, code }) => {
    const { service } = serviceFor();
    const jobClass = automaticClass();
    change(jobClass);
    const result = await service.register(jobClass);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((entry) => entry.code)).toContain(code);
  });

  it("rejects uncovered human effect leaves and absence domains", async () => {
    const { service } = serviceFor();
    const jobClass = humanClass();
    const permit = jobClass.permits[0];
    if (permit?.mode !== "human_only") throw new Error("bad test permit");
    permit.reviewRequirement.requiredEffectPaths = ["$.count"];
    permit.reviewRequirement.requiredAbsenceDomain = {
      id: "wrong",
      payloadPaths: ["$.missing"],
    };
    const result = await service.register(jobClass);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "requirement_invalid" }),
      expect.objectContaining({ code: "path_not_declared" }),
    ]));
  });

  it("requires adjudication capacity whenever a human gate is possible", async () => {
    const { service } = serviceFor();
    const jobClass = humanClass();
    delete jobClass.adjudication;
    const result = await service.register(jobClass);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "adjudication_invalid",
      path: "$.adjudication",
    }));
  });

  it("does not invoke consumer functions for malformed closed fixtures", async () => {
    const { service } = serviceFor();
    const jobClass = automaticClass();
    let oracleCalls = 0;
    let derivationCalls = 0;
    jobClass.oracles[0]!.run = () => {
      oracleCalls += 1;
      return { kind: "fail", code: "expected" };
    };
    const permit = jobClass.permits[0];
    if (permit?.mode !== "automatic") throw new Error("bad test permit");
    permit.deriveEffect = () => {
      derivationCalls += 1;
      return { count: 0, note: "called" };
    };
    (jobClass.oracles[0]!.negativeFixtures[0] as unknown as Record<string, unknown>).typo = true;
    (permit.effectFixtures[0] as unknown as Record<string, unknown>).typo = true;
    const result = await service.register(jobClass);
    expect(result.ok).toBe(false);
    expect(oracleCalls).toBe(1);
    expect(derivationCalls).toBe(0);
  });

  it("rejects agreement and effect fixture mismatches", async () => {
    const { service } = serviceFor();
    const jobClass = automaticClass();
    const permit = jobClass.permits[0];
    if (permit?.mode !== "automatic") throw new Error("bad test permit");
    permit.effectFixtures[0]!.expectedDescriptor = { count: 2, note: "fixture" };
    jobClass.replication = { target: 2, maxSplitEvidenceReroutes: 1 };
    jobClass.agreement = {
      equivalenceKey: (result) => ({ first: result.items[0] ?? null }),
      resolveEquivalent: (results) => results[0],
      agreementFixtures: [
        {
          kind: "equivalent",
          payload: { items: ["one"] },
          results: [{ items: ["one"] }, { items: ["two"] }],
          expected: "equivalent",
        },
        {
          kind: "split",
          payload: { items: ["one"] },
          results: [{ items: [] }, { items: ["one"] }],
          expected: "split",
        },
      ],
    };
    jobClass.adjudication = {
      requiredRatePerWeek: 0,
      restoreAbovePerWeek: 1,
      starvationDwell: 60,
      capacityMaxAge: 60,
      maxRejectedDisputeRequeues: 0,
    };
    const result = await service.register(jobClass);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "agreement_fixture_mismatch",
      "effect_fixture_invalid",
    ]));
  });

  it("refuses a durable schema conflict without loading runtime functions", async () => {
    const { registry, service, store } = serviceFor();
    await store.registerClassVersion({
      classId: "minimal-class",
      contractVersion: "1.0.0",
      payloadSchemaHash: "different-payload",
      outputSchemaHash: "different-output",
      registeredAt: now,
    });
    const result = await service.register(minimalClass());
    expect(result).toMatchObject({
      ok: false,
      kind: "conflict",
      issues: [{ code: "durable_schema_conflict" }],
    });
    expect(registry.get("minimal-class", "1.0.0")).toBeNull();
  });
});
