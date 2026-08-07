import {
  canonicalize,
  computeDecisionResultHash,
  deepFreeze,
  REQUIRED_INJECTION_CATEGORIES,
  REQUIRED_LIFECYCLE_FIXTURE_IDS,
  type ActionAdjudicationVerdict,
  type CanonicalJsonValue,
  type EffectIntent,
  type JobClass,
  type JSONSchema,
  type ResultAdjudicationVerdict,
} from "@kuindji/muster-contract";

import { ActionAuthorizationService } from "./action-authorization-service.js";
import {
  AdjudicationService,
  InvalidationService,
} from "./adjudication-service.js";
import { ControlPlaneService } from "./control-plane.js";
import { LeaseService } from "./lease-service.js";
import type {
  AdjudicationSource,
  IdSource,
  ReputationPolicy,
  Store,
  WorkerControlPolicy,
} from "./ports.js";
import {
  ClassRegistrationService,
  RuntimeClassRegistry,
} from "./registration.js";
import type { StoreFactory } from "./store-conformance.js";
import { SubmissionService } from "./submission-service.js";
import {
  ManualClock,
  RecordingEventSink,
  SequenceIdSource,
} from "./testing.js";

const NOW = "2026-08-07T16:00:00.000Z";
const LATER = "2026-08-07T16:01:00.000Z";
const CLASS_VERSION = "1.0.0";
const WORKER_CONTRACT_VERSION = "1.1.0";

type Payload = { instruction: string };
type Result = { answer: string };

export interface ProtocolSchemaFixture {
  readonly id: string;
  readonly valid: boolean;
  readonly schema: JSONSchema;
}

export interface ProtocolPromptInjectionFixture {
  readonly id: string;
  readonly category: string;
  readonly payloadText: string;
}

export interface ProtocolConformanceFixturePack {
  readonly schemas: readonly ProtocolSchemaFixture[];
  readonly promptInjections: readonly ProtocolPromptInjectionFixture[];
}

export interface ProtocolConformanceCase {
  readonly id: string;
  readonly fixtureIds: readonly string[];
  readonly run: (
    storeFactory: StoreFactory,
    fixtures: ProtocolConformanceFixturePack,
  ) => Promise<void>;
}

const assert: (
  condition: unknown,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Protocol conformance failure: ${message}`);
};

const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalize(left as CanonicalJsonValue) ===
      canonicalize(right as CanonicalJsonValue);
  } catch {
    return false;
  }
};

const objectSchema = (property: string): JSONSchema => ({
  $schema: "urn:kuindji:muster:schema:1",
  type: "object",
  additionalProperties: false,
  properties: { [property]: { type: "string" } },
  required: [property],
});

const effectSchema = objectSchema("reason");

const baseClass = (
  id: string,
  options: { readonly replication?: number; readonly humanAction?: boolean } = {},
): JobClass<Payload, Result> => {
  const replication = options.replication ?? 1;
  return {
    id,
    contractVersion: CLASS_VERSION,
    kind: "oneshot",
    payloadSchema: objectSchema("instruction"),
    outputSchema: objectSchema("answer"),
    maxPayloadBytes: 16_384,
    maxResultBytes: 16_384,
    sanitize: (raw) => ({
      instruction: String(
        (raw as { instruction?: unknown }).instruction ?? "",
      ),
    }),
    verification: "structural_only",
    validators: [],
    oracles: [],
    replication: {
      target: replication,
      maxSplitEvidenceReroutes: 0,
    },
    ...(replication > 1
      ? {
          agreement: {
            equivalenceKey: (result: Result) => result.answer.toLowerCase(),
            resolveEquivalent: (results: Result[]) => ({
              answer: results[0]!.answer.toLowerCase(),
            }),
            agreementFixtures: [
              {
                kind: "equivalent" as const,
                payload: { instruction: "yes" },
                results: [{ answer: "YES" }, { answer: "yes" }],
                expected: "equivalent" as const,
              },
              {
                kind: "split" as const,
                payload: { instruction: "answer" },
                results: [{ answer: "left" }, { answer: "right" }],
                expected: "split" as const,
              },
            ],
          },
        }
      : {}),
    permits: options.humanAction
      ? [{
          action: "suppress",
          mode: "human_only",
          effectSchema,
          reviewRequirement: {
            predicate: "human-reviewed",
            requiredPayloadPaths: [],
            requiredResultPaths: [],
            requiredEffectPaths: ["$.reason"],
            requiredAbsenceDomain: {
              id: "all-input",
              payloadPaths: ["$"],
            },
          },
        }]
      : [],
    consequence: "low",
    surface: "unbounded",
    evidenceRequirements: [],
    absenceRequirements: [],
    requires: {},
    privacy: "internal",
    cost: {
      expectedTurns: 1,
      maxLeaseTtl: 300,
      leaseTtl: () => 240,
      maxInFlightLifetime: 1_801,
    },
    escalation: {
      lowCostPerWeek: 0,
      urgentPerWeek: 0,
      splitAndAdjudicationPerWeek:
        replication > 1 || options.humanAction ? 2 : 0,
      retrospectiveAuditProjectionPerWeek: 0,
      auditPerWeek: 0,
      perWorkerLowCostQuotaPerWeek: 0,
      perWorkerUrgentQuotaPerWeek: 0,
    },
    ...(replication > 1 || options.humanAction
      ? {
          adjudication: {
            requiredRatePerWeek: 2,
            restoreAbovePerWeek: 3,
            starvationDwell: 300,
            capacityMaxAge: 300,
            maxRejectedDisputeRequeues: 1,
          },
        }
      : {}),
  };
};

const fixtureClass = (id: string): JobClass<Payload, Result> => {
  const definition = baseClass(id, { replication: 2 });
  definition.verification = "deterministic_oracle";
  definition.resultEvidenceRequirement = {
    predicate: "answer-supported",
    requiredPayloadPaths: ["$.instruction"],
    requiredResultPaths: ["$.answer"],
  };
  definition.oracles = [
    {
      id: "support",
      kind: "support",
      predicates: ["answer-supported"],
      run: (payload, result) =>
        result.answer === payload.instruction
          ? { kind: "pass" }
          : { kind: "fail", code: "unsupported" },
      coversPayloadPaths: ["$.instruction"],
      coversResultPaths: ["$.answer"],
      negativeFixtures: [
        {
          name: "support-out-of-domain",
          predicate: "answer-supported",
          category: "out_of_domain",
          payload: { instruction: "known" },
          result: { answer: "outside" },
        },
        {
          name: "support-unsupported",
          predicate: "answer-supported",
          category: "unsupported_material",
          payload: { instruction: "known" },
          result: { answer: "invented" },
        },
      ],
    },
    {
      id: "complete",
      kind: "completeness",
      predicates: ["answer-complete"],
      run: (payload, result) =>
        result.answer === payload.instruction
          ? { kind: "pass" }
          : { kind: "fail", code: "omitted" },
      coversPayloadPaths: ["$.instruction"],
      coversResultPaths: ["$.answer"],
      absenceDomain: { id: "complete-answer", payloadPaths: ["$.instruction"] },
      negativeFixtures: [
        {
          name: "complete-out-of-domain",
          predicate: "answer-complete",
          category: "out_of_domain",
          payload: { instruction: "known" },
          result: { answer: "outside" },
        },
        {
          name: "complete-omission",
          predicate: "answer-complete",
          category: "omitted_material",
          payload: { instruction: "known" },
          result: { answer: "" },
        },
      ],
    },
  ];
  definition.permits = [{
    action: "updateRetrievalIndex",
    mode: "automatic",
    effectSchema,
    effectInput: {
      payloadPaths: ["$.instruction"],
      resultPaths: ["$.answer"],
    },
    deriveEffect: ({ result }) => ({
      reason: (result as Result).answer,
    }),
    effectFixtures: [{
      input: {
        payload: { instruction: "known" },
        result: { answer: "known" },
      },
      expectedDescriptor: { reason: "known" },
    }],
  }];
  definition.evidenceRequirements = [{
    action: "updateRetrievalIndex",
    predicate: "answer-supported",
    requiredPayloadPaths: ["$.instruction"],
    requiredResultPaths: ["$.answer"],
  }];
  definition.absenceRequirements = [{
    action: "updateRetrievalIndex",
    predicate: "answer-complete",
    requiredPayloadPaths: ["$.instruction"],
    requiredResultPaths: ["$.answer"],
    requiredDomain: {
      id: "required-answer",
      payloadPaths: ["$.instruction"],
    },
  }];
  return definition;
};

const workerPolicy: WorkerControlPolicy = {
  probationCheckedSuccesses: 1,
  probationMinimumEnrollmentAge: 1,
  assignSlot: ({ workerId }) => {
    const suffix = Number(workerId.split("-").at(-1));
    return Number.isSafeInteger(suffix) ? suffix : 0;
  },
  routingAt: ({ slot, at }) => ({
    contributionWindowId: at.slice(0, 10),
    assignedSlotOccurrence: `${at.slice(0, 10)}-slot-${slot}`,
    slotOpen: true,
  }),
};

const reputationPolicy: ReputationPolicy = {
  assess: () => ({ eligible: true }),
};

const adjudicationSource: AdjudicationSource = {
  capacity: (classId) => ({
    classId,
    availableReviewsPerWeek: 10,
    observedAt: NOW,
  }),
  authenticate: () => true,
};

interface ProtocolState {
  readonly store: Store;
  readonly clock: ManualClock;
  readonly events: RecordingEventSink;
  readonly ids: IdSource;
  readonly registry: RuntimeClassRegistry;
  readonly control: ControlPlaneService;
  readonly leases: LeaseService;
  readonly submissions: SubmissionService;
  readonly adjudication: AdjudicationService;
  readonly invalidation: InvalidationService;
  readonly authorization: ActionAuthorizationService;
  readonly definition: JobClass<Payload, Result>;
}

const setup = async (
  storeFactory: StoreFactory,
  prefix: string,
  options: {
    readonly replication?: number;
    readonly humanAction?: boolean;
    readonly workerCount?: number;
    readonly ids?: IdSource;
  } = {},
): Promise<ProtocolState> => {
  const store = await storeFactory();
  const clock = new ManualClock(NOW);
  const events = new RecordingEventSink();
  const ids = options.ids ?? new SequenceIdSource(prefix);
  const registry = new RuntimeClassRegistry();
  const definition = baseClass(`${prefix}-class`, options);
  const registration = new ClassRegistrationService({
    store,
    clock,
    registry,
    deploymentPolicy: {
      version: "protocol-deployment-1",
      extensionTtl: 300,
      maxExtensionsPerLease: 2,
    },
  });
  const registered = await registration.register(definition);
  assert(
    registered.ok,
    `${prefix}: class registration failed ${JSON.stringify(registered)}`,
  );

  const control = new ControlPlaneService({
    store,
    clock,
    events,
    admission: { admit: async () => ({ admit: true }) },
    workerPolicy,
    registry,
  });
  const activated = await control.transitionClassLifecycle({
    classId: definition.id,
    contractVersion: definition.contractVersion,
    from: "draft",
    to: "active",
  });
  assert(activated.ok && activated.kind === "applied", `${prefix}: activation failed`);
  const epoch = await control.transitionPermitEpoch({
    classId: definition.id,
    fromEpoch: null,
    toEpoch: "epoch-1",
  });
  assert(epoch.ok && epoch.kind === "applied", `${prefix}: epoch bootstrap failed`);

  const workerCount = options.workerCount ?? 3;
  for (let index = 1; index <= workerCount; index += 1) {
    const workerId = `${prefix}-worker-${index}`;
    const enrolled = await control.enrollWorker({
      workerId,
      declaredCapPerWeek: 100,
      capabilities: {
        providerSurface: `provider-${index}`,
        unattendedScheduling: true,
        languages: ["en"],
        jobClassIds: [definition.id],
      },
      accountCluster: `cluster-${index}`,
      contractVersion: WORKER_CONTRACT_VERSION,
    });
    assert(
      enrolled.ok,
      `${prefix}: worker enrollment failed ${JSON.stringify(enrolled)}`,
    );
    await store.recordReputationEvidence({
      evidenceId: `${prefix}-probation-${index}`,
      workerId,
      at: clock.now(),
      source: "checked_success",
      impact: "positive",
    });
    clock.advance(1);
    const promoted = await control.promoteWorker(workerId);
    assert(promoted.ok, `${prefix}: worker promotion failed`);
  }

  const common = { store, registry, clock, ids, events };
  const leases = new LeaseService({
    ...common,
    workerPolicy,
    reputationPolicy,
    deploymentPolicy: {
      version: "protocol-deployment-1",
      extensionTtl: 300,
      maxExtensionsPerLease: 2,
    },
  });
  return {
    ...common,
    definition,
    control,
    leases,
    submissions: new SubmissionService(common),
    adjudication: new AdjudicationService({
      ...common,
      source: adjudicationSource,
    }),
    invalidation: new InvalidationService({ store, registry, clock, events }),
    authorization: new ActionAuthorizationService(common),
  };
};

const enqueue = (
  state: ProtocolState,
  jobId: string,
  instruction = "answer",
) => state.leases.enqueue({
  jobId,
  classId: state.definition.id,
  contractVersion: state.definition.contractVersion,
  rawPayload: { instruction },
  policyVersion: "policy-1",
  priority: { lane: "normal", value: 1, sequence: `${jobId}-sequence` },
});

const claim = async (state: ProtocolState, workerIndex: number) => {
  const workerId = `${state.definition.id.replace(/-class$/, "")}-worker-${workerIndex}`;
  const result = await state.leases.leaseJob(workerId);
  assert(result.outcome === "lease", `${state.definition.id}: expected lease`);
  return { workerId, lease: result.lease, payload: result.payload };
};

const initializeSplitReserve = async (state: ProtocolState): Promise<void> => {
  const outcome = await state.store.initializeReservePolicy({
    policy: {
      classId: state.definition.id,
      contractVersion: state.definition.contractVersion,
      policyVersion: "protocol-reserves-1",
      windowId: "2026-W32",
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-10T00:00:00.000Z",
      lane: "splitAndAdjudication",
      laneLimit: 2,
    },
    at: NOW,
  });
  assert(outcome.kind === "initialized", "reserve policy initialization failed");
};

const lifecycleAndRetryCase: ProtocolConformanceCase = {
  id: "protocol-lifecycle-and-exact-retry",
  fixtureIds: [
    "class-version-identical-schema-replays",
    "enqueue-hashes-exact-sanitized-payload",
    "sub-retry-after-submission-closed",
    "sub-conflict-different-result",
  ],
  run: async (storeFactory) => {
    const state = await setup(storeFactory, "lifecycle");
    const lifecycleReplay = await state.control.transitionClassLifecycle({
      classId: state.definition.id,
      contractVersion: state.definition.contractVersion,
      from: "draft",
      to: "active",
    });
    assert(
      lifecycleReplay.ok && lifecycleReplay.kind === "replayed",
      "active lifecycle retry did not replay",
    );
    const firstEnqueue = await enqueue(state, "lifecycle-job");
    const enqueueReplay = await enqueue(state, "lifecycle-job");
    const enqueueConflict = await enqueue(
      state,
      "lifecycle-job",
      "different",
    );
    assert(
      firstEnqueue.ok && firstEnqueue.kind === "enqueued",
      "first enqueue failed",
    );
    assert(
      enqueueReplay.ok && enqueueReplay.kind === "replayed",
      "exact enqueue retry did not replay",
    );
    assert(
      !enqueueConflict.ok && enqueueConflict.kind === "conflict",
      "conflicting enqueue retry was accepted",
    );
    const claimed = await claim(state, 1);
    const result = { answer: "accepted" };
    const accepted = await state.submissions.submitResult(
      claimed.workerId,
      claimed.lease.leaseId,
      claimed.lease.inputHash,
      result,
    );
    const replayed = await state.submissions.submitResult(
      claimed.workerId,
      claimed.lease.leaseId,
      claimed.lease.inputHash,
      result,
    );
    const conflict = await state.submissions.submitResult(
      claimed.workerId,
      claimed.lease.leaseId,
      claimed.lease.inputHash,
      { answer: "different" },
    );
    assert(accepted.ok && replayed.ok, "accepted submission did not replay");
    assert(
      same(accepted.receipt, replayed.receipt),
      "submission replay changed its receipt",
    );
    assert(
      !conflict.ok && conflict.error === "submission_conflict",
      "conflicting result retry was not refused",
    );
    assert(
      state.events.all().some((event) => event.type === "contract_transition") &&
        state.events.all().some((event) => event.type === "submit"),
      "deterministic lifecycle events were not emitted",
    );
  },
};

const identityAndAdmissionRaceCase: ProtocolConformanceCase = {
  id: "protocol-identity-and-admission-races",
  fixtureIds: [
    "idsource-collision-preserves-existing",
    "enqueue-refuses-stale-operational-revision",
  ],
  run: async (storeFactory) => {
    let leaseIdentityCalls = 0;
    const identityCounts = new Map<string, number>();
    const collidingIds: IdSource = {
      next: (kind) => {
        const next = (identityCounts.get(kind) ?? 0) + 1;
        identityCounts.set(kind, next);
        if (kind === "lease") {
          leaseIdentityCalls += 1;
          return leaseIdentityCalls <= 2
            ? "race-colliding-lease"
            : `race-lease-${leaseIdentityCalls}`;
        }
        return `race-${kind}-${next}`;
      },
    };
    const state = await setup(storeFactory, "race", { ids: collidingIds });
    const competing = await Promise.all([
      enqueue(state, "race-job", "left"),
      enqueue(state, "race-job", "right"),
    ]);
    assert(
      competing.filter((result) => result.ok && result.kind === "enqueued").length === 1,
      "job identity race did not have one winner",
    );
    assert(
      competing.filter((result) => !result.ok && result.kind === "conflict").length === 1,
      "job identity race did not preserve the winner",
    );
    const firstLease = await claim(state, 1);
    await enqueue(state, "race-second-job");
    const secondLease = await claim(state, 2);
    assert(
      firstLease.lease.leaseId === "race-colliding-lease" &&
        secondLease.lease.leaseId === "race-lease-3",
      "core identity collision did not skip the occupied lease id",
    );
    assert(
      (await state.store.getLease(firstLease.lease.leaseId))?.holder ===
        firstLease.workerId,
      "lease identity collision changed the existing lease",
    );

    const queue = await state.store.getQueueMode();
    const [halt, admission] = await Promise.all([
      state.store.transitionQueueMode({
        expected: queue,
        next: {
          mode: "admission_halted",
          cause: "operator",
          updatedAt: LATER,
        },
      }),
      enqueue(state, "race-admission-job"),
    ]);
    assert(halt.kind === "applied", "admission halt lost its expected snapshot");
    if (admission.ok) {
      assert(
        admission.kind === "enqueued" &&
          await state.store.getJob("race-admission-job") !== null,
        "admission race reported a non-durable enqueue",
      );
    } else {
      assert(
        admission.kind === "refused" && admission.reason === "operational_state",
        "admission race did not fail closed",
      );
    }
  },
};

const registrationFixtureCase: ProtocolConformanceCase = {
  id: "protocol-registration-fixtures",
  fixtureIds: [
    "agreement-fixture-families-required",
    "oracle-negative-fixture-families-bound",
  ],
  run: async (storeFactory, fixtures) => {
    assert(fixtures.schemas.length > 0, "schema corpus is empty");
    const store = await storeFactory();
    const service = new ClassRegistrationService({
      store,
      clock: new ManualClock(NOW),
      deploymentPolicy: {
        version: "protocol-deployment-1",
        extensionTtl: 300,
        maxExtensionsPerLease: 2,
      },
    });

    for (const [index, fixture] of fixtures.schemas.entries()) {
      const schemaClass = baseClass(`fixture-schema-${index + 1}`);
      schemaClass.payloadSchema = structuredClone(fixture.schema);
      const schemaResult = await service.register(schemaClass);
      if (fixture.valid) {
        assert(schemaResult.ok, `valid schema fixture ${fixture.id} was rejected`);
      } else {
        assert(
          !schemaResult.ok && schemaResult.issues.some((issue) =>
            issue.code === "schema_invalid"
          ),
          `invalid schema fixture ${fixture.id} was accepted`,
        );
      }
    }

    const accepted = await service.register(fixtureClass("fixture-accepted"));
    assert(
      accepted.ok,
      `valid oracle/agreement/effect/absence fixture class failed ${JSON.stringify(accepted)}`,
    );

    const oracleClass = fixtureClass("fixture-oracle-invalid");
    oracleClass.oracles[0]!.negativeFixtures = [
      oracleClass.oracles[0]!.negativeFixtures[0]!,
    ];
    const oracleResult = await service.register(oracleClass);
    assert(
      !oracleResult.ok && oracleResult.issues.some((issue) =>
        issue.code === "oracle_fixture_invalid"
      ),
      "oracle negative-fixture family gap was accepted",
    );

    const agreementClass = fixtureClass("fixture-agreement-invalid");
    agreementClass.agreement!.agreementFixtures[0]!.results = [
      { answer: "left" },
      { answer: "right" },
    ];
    const agreementResult = await service.register(agreementClass);
    assert(
      !agreementResult.ok && agreementResult.issues.some((issue) =>
        issue.code === "agreement_fixture_mismatch"
      ),
      "agreement fixture mismatch was accepted",
    );

    const effectClass = fixtureClass("fixture-effect-invalid");
    const permit = effectClass.permits[0]!;
    assert(permit.mode === "automatic", "automatic fixture permit missing");
    permit.effectFixtures[0]!.expectedDescriptor = { reason: "different" };
    const effectResult = await service.register(effectClass);
    assert(
      !effectResult.ok && effectResult.issues.some((issue) =>
        issue.code === "effect_fixture_invalid"
      ),
      "effect fixture mismatch was accepted",
    );

    const absenceClass = fixtureClass("fixture-absence-invalid");
    absenceClass.absenceRequirements[0]!.requiredDomain = {
      id: "missing",
      payloadPaths: ["$.missing"],
    };
    const absenceResult = await service.register(absenceClass);
    assert(
      !absenceResult.ok && absenceResult.issues.some((issue) =>
        issue.code === "path_not_declared" ||
        issue.code === "oracle_coverage_missing"
      ),
      "absence-domain mismatch was accepted",
    );
  },
};

const leaseTerminalCase: ProtocolConformanceCase = {
  id: "protocol-lease-terminal-refusals",
  fixtureIds: [
    "extend-wrong-worker-refused",
    "abandon-wrong-worker-refused",
    "sub-retry-after-lease-expiry",
  ],
  run: async (storeFactory) => {
    const state = await setup(storeFactory, "terminal");
    await enqueue(state, "terminal-job");
    const claimed = await claim(state, 1);
    const otherWorker = "terminal-worker-2";
    assert(
      (await state.leases.extendLease(otherWorker, claimed.lease.leaseId)).outcome ===
        "refused",
      "wrong holder extended a lease",
    );
    assert(
      (await state.leases.abandonLease(
        otherWorker,
        claimed.lease.leaseId,
        "abandoned_after_payload",
      )).outcome ===
        "refused",
      "wrong holder abandoned a lease",
    );
    const unknown = await state.submissions.submitResult(
      otherWorker,
      "unknown-lease",
      claimed.lease.inputHash,
      { answer: "answer" },
    );
    const wrongHolder = await state.submissions.submitResult(
      otherWorker,
      claimed.lease.leaseId,
      claimed.lease.inputHash,
      { answer: "answer" },
    );
    assert(
      !unknown.ok && !wrongHolder.ok && unknown.error === "lease_not_held" &&
        wrongHolder.error === "lease_not_held",
      "unknown and wrong-holder refusals disclosed different wire errors",
    );
    state.clock.set(claimed.lease.expiresAt);
    const expired = await state.submissions.submitResult(
      claimed.workerId,
      claimed.lease.leaseId,
      claimed.lease.inputHash,
      { answer: "answer" },
    );
    assert(
      !expired.ok && expired.error === "lease_not_held",
      "expired lease did not collapse to the disclosure-safe refusal",
    );
  },
};

const resultAdjudicationCase: ProtocolConformanceCase = {
  id: "protocol-result-adjudication-and-cross-cycle-isolation",
  fixtureIds: [
    "result-verdict-exact-retry",
    "requeue-after-rejected-dispute",
    "old-cycle-replicas-excluded-from-new-cycle",
    "invalidate-operator-cancelled",
  ],
  run: async (storeFactory) => {
    const state = await setup(storeFactory, "result", {
      replication: 2,
      workerCount: 3,
    });
    await enqueue(state, "result-job");
    const first = await claim(state, 1);
    const firstReceipt = await state.submissions.submitResult(
      first.workerId,
      first.lease.leaseId,
      first.lease.inputHash,
      { answer: "left" },
    );
    const second = await claim(state, 2);
    await state.submissions.submitResult(
      second.workerId,
      second.lease.leaseId,
      second.lease.inputHash,
      { answer: "right" },
    );
    await initializeSplitReserve(state);
    const opened = await state.adjudication.openResult({
      jobId: "result-job",
      collectionCycle: 1,
      reason: "split_exhausted",
    });
    assert(
      opened.kind === "opened_charged",
      `result adjudication did not open ${JSON.stringify(opened)}`,
    );
    const pending = await state.store.listPendingResultAdjudications(
      state.definition.id,
    );
    assert(pending.length === 1, "result adjudication request was not durable");
    const request = pending[0]!.request;
    state.clock.set(LATER);
    const verdict: ResultAdjudicationVerdict = {
      kind: "human",
      resultAdjudicationRequestId: request.id,
      reason: request.reason,
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      inputHash: request.inputHash,
      candidateResultHashes: request.candidateResultHashes,
      evidence: request.evidence,
      contractVersion: request.contractVersion,
      permitEpoch: request.permitEpoch,
      adjudicatorId: "protocol-human",
      decision: { kind: "reject" },
      decidedAt: NOW,
    };
    const applied = await state.adjudication.applyResultVerdict(verdict);
    const replayed = await state.adjudication.applyResultVerdict(verdict);
    assert(
      applied.kind === "applied" && replayed.kind === "replayed",
      "result verdict did not apply and exactly replay",
    );
    assert(
      (await state.store.getJob("result-job"))?.collectionCycle === 2,
      "rejected dispute did not advance the collection cycle",
    );
    assert(
      (await state.store.listAcceptedReplicas("result-job", 2)).length === 0,
      "old-cycle replicas leaked into the new cycle",
    );
    const oldReplay = await state.submissions.submitResult(
      first.workerId,
      first.lease.leaseId,
      first.lease.inputHash,
      { answer: "left" },
    );
    assert(
      firstReceipt.ok && oldReplay.ok && same(firstReceipt.receipt, oldReplay.receipt),
      "old-cycle exact receipt did not remain replayable",
    );
    const newLease = await claim(state, 3);
    assert(
      newLease.lease.collectionCycle === 2,
      "new lease did not bind the new collection cycle",
    );
    const invalidated = await state.invalidation.invalidate({
      scope: {
        kind: "job_cycles",
        classId: state.definition.id,
        jobCycles: [{ jobId: "result-job", collectionCycle: 2 }],
      },
      reason: "operator_cancelled",
    });
    assert(invalidated.kind === "applied", "current-cycle invalidation failed");
    assert(
      state.events.all().some((event) =>
        event.type === "verdict" && event.at === LATER
      ),
      "fake-clock verdict event was not deterministic",
    );
  },
};

const actionAdjudicationCase: ProtocolConformanceCase = {
  id: "protocol-action-adjudication-and-live-invalidation",
  fixtureIds: [
    "auth-exact-retry-replays-initial-receipt",
    "action-verdict-exact-retry",
    "withdrawal-supersedes-partially-authorized-result",
  ],
  run: async (storeFactory) => {
    const state = await setup(storeFactory, "action", { humanAction: true });
    await enqueue(state, "action-job");
    const claimed = await claim(state, 1);
    await state.submissions.submitResult(
      claimed.workerId,
      claimed.lease.leaseId,
      claimed.lease.inputHash,
      { answer: "approved" },
    );
    const replicas = await state.store.listAcceptedReplicas("action-job", 1);
    const decisionResultHash = await computeDecisionResultHash({
      result: { answer: "approved" },
      evidence: replicas.map((replica) => replica.evidence),
    });
    await initializeSplitReserve(state);
    const intent: EffectIntent = {
      id: "action-intent",
      effects: [{
        action: "suppress" as const,
        descriptor: { reason: "human decision" },
      }],
    };
    const initial = await state.authorization.authorizeActions(
      decisionResultHash,
      intent,
    );
    const initialReplay = await state.authorization.authorizeActions(
      decisionResultHash,
      intent,
    );
    assert(
      initial.ok && initial.receipt.outcome === "pending_adjudication" &&
        initialReplay.ok && same(initial.receipt, initialReplay.receipt),
      "pending action authorization did not exactly replay",
    );
    const request = await state.store.getActionAdjudicationRequest(
      initial.receipt.authorizationRequestId,
    );
    assert(request !== null, "action adjudication request was not durable");
    state.clock.set(LATER);
    const verdict: ActionAdjudicationVerdict = {
      kind: "human",
      jobId: request.jobId,
      collectionCycle: request.collectionCycle,
      authorizationRequestId: request.authorizationRequestId,
      effectIntentId: request.effectIntent.id,
      effectIntentHash: request.effectIntentHash,
      actions: request.effectIntent.effects.map((effect) => effect.action),
      inputHash: request.inputHash,
      decisionResultHash: request.decisionResultHash,
      evidence: request.evidence,
      ...(request.resultAdjudicationVerdictHash === undefined
        ? {}
        : { resultAdjudicationVerdictHash: request.resultAdjudicationVerdictHash }),
      contractVersion: request.contractVersion,
      permitEpoch: request.permitEpoch,
      adjudicatorId: "protocol-human",
      decision: "approve",
      decidedAt: LATER,
    };
    const applied = await state.adjudication.applyActionVerdict(verdict);
    const replayed = await state.adjudication.applyActionVerdict(verdict);
    assert(
      applied.kind === "applied" && replayed.kind === "replayed",
      "action verdict did not apply and exactly replay",
    );
    const invalidated = await state.invalidation.invalidate({
      scope: {
        kind: "job_cycles",
        classId: state.definition.id,
        jobCycles: [{ jobId: "action-job", collectionCycle: 1 }],
      },
      reason: "operator_cancelled",
    });
    assert(invalidated.kind === "applied", "authorized result invalidation failed");
    const status = await state.store.getAuthorizationStatus(
      request.authorizationRequestId,
    );
    assert(
      status?.state === "authorized" && status.validity.kind === "invalid",
      "live authorization status stayed valid after invalidation",
    );
  },
};

export const TASK9_PROMPT_INJECTION_FIXTURE_IDS: readonly string[] = deepFreeze([
  "injection-direct-1",
  "injection-tool-redirect-1",
  "injection-exfiltration-1",
  "injection-role-1",
  "injection-markdown-1",
  "injection-schema-1",
]);

const promptInjectionCase: ProtocolConformanceCase = {
  id: "protocol-prompt-injection-is-untrusted-data",
  fixtureIds: TASK9_PROMPT_INJECTION_FIXTURE_IDS,
  run: async (storeFactory, fixtures) => {
    const state = await setup(storeFactory, "injection", { workerCount: 1 });
    for (const [index, fixture] of fixtures.promptInjections.entries()) {
      const jobId = `injection-job-${index + 1}`;
      const enqueued = await enqueue(state, jobId, fixture.payloadText);
      assert(enqueued.ok, `${fixture.id}: injection payload was not accepted as data`);
      const leased = await claim(state, 1);
      assert(
        same(leased.payload, { instruction: fixture.payloadText }),
        `${fixture.id}: payload text was interpreted or changed`,
      );
      const submitted = await state.submissions.submitResult(
        leased.workerId,
        leased.lease.leaseId,
        leased.lease.inputHash,
        { answer: fixture.payloadText },
      );
      assert(submitted.ok, `${fixture.id}: data-bearing result was not accepted`);
    }
  },
};

export const TASK9_PROTOCOL_CONFORMANCE_CASES: readonly ProtocolConformanceCase[] =
  deepFreeze([
    lifecycleAndRetryCase,
    identityAndAdmissionRaceCase,
    registrationFixtureCase,
    leaseTerminalCase,
    resultAdjudicationCase,
    actionAdjudicationCase,
    promptInjectionCase,
  ]);

const validateFixturePack = (fixtures: ProtocolConformanceFixturePack): void => {
  const schemaIds = new Set<string>();
  for (const fixture of fixtures.schemas) {
    assert(fixture.id.length > 0, "schema fixture id is empty");
    assert(!schemaIds.has(fixture.id), `duplicate schema fixture ${fixture.id}`);
    schemaIds.add(fixture.id);
  }
  const promptIds = new Set<string>();
  const categories = new Set<string>();
  for (const fixture of fixtures.promptInjections) {
    assert(fixture.id.length > 0, "prompt fixture id is empty");
    assert(!promptIds.has(fixture.id), `duplicate prompt fixture ${fixture.id}`);
    assert(fixture.payloadText.length > 0, `${fixture.id}: prompt text is empty`);
    promptIds.add(fixture.id);
    categories.add(fixture.category);
  }
  for (const id of TASK9_PROMPT_INJECTION_FIXTURE_IDS) {
    assert(promptIds.has(id), `missing prompt-injection fixture ${id}`);
  }
  for (const category of REQUIRED_INJECTION_CATEGORIES) {
    assert(categories.has(category), `missing prompt-injection category ${category}`);
  }
};

/**
 * Runs the M2 Task-9 public-operation expectations against any Store adapter.
 * Fixture JSON stays an explicit caller input so core remains platform-neutral.
 * Each factory call must return an isolated empty Store in normal queue mode.
 */
export const runTask9ProtocolConformance = async (
  storeFactory: StoreFactory,
  fixtures: ProtocolConformanceFixturePack,
): Promise<string[]> => {
  validateFixturePack(fixtures);
  const frozenLifecycleIds = new Set(REQUIRED_LIFECYCLE_FIXTURE_IDS);
  const promptIds = new Set(TASK9_PROMPT_INJECTION_FIXTURE_IDS);
  const passed: string[] = [];
  for (const testCase of TASK9_PROTOCOL_CONFORMANCE_CASES) {
    for (const fixtureId of testCase.fixtureIds) {
      assert(
        frozenLifecycleIds.has(fixtureId) || promptIds.has(fixtureId),
        `${testCase.id}: unknown frozen fixture ${fixtureId}`,
      );
    }
    await testCase.run(storeFactory, fixtures);
    passed.push(testCase.id);
  }
  return passed;
};
