import {
  mcpRateWindow,
  type AuthenticatedWorkerSubject,
  type AuthorizeMcpCallInput,
  type McpRateLimitPolicy,
  type McpStateStore,
  type McpSubjectBinding,
  type MusterMcpToolName,
} from "@kuindji/muster-contract";

export type McpStateStoreFactory = () => McpStateStore | Promise<McpStateStore>;

export interface McpStateStoreConformanceCase {
  readonly id: string;
  readonly run: (factory: McpStateStoreFactory) => Promise<void>;
}

const NOW = "2026-08-08T10:00:30.000Z";
const LATER = "2026-08-08T10:00:31.000Z";
const NEXT_WINDOW = "2026-08-08T10:01:00.000Z";

const POLICY: McpRateLimitPolicy = {
  version: "rate-1",
  windowSeconds: 60,
  maxCallsPerWindow: {
    lease_job: 2,
    submit_result: 2,
    abandon_job: 2,
    extend_lease: 2,
    get_worker_status: 2,
    set_availability: 2,
  },
  maxLeaseAttemptsPerSlot: 2,
};

const subject = (name: string): AuthenticatedWorkerSubject => ({
  issuer: "https://issuer.example/",
  subject: `subject-${name}`,
});

const fail = (message: string): never => {
  throw new Error(`MCP state conformance failure: ${message}`);
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) fail(message);
};

async function bind(
  store: McpStateStore,
  name = "one",
  workerId = "worker-one",
): Promise<McpSubjectBinding> {
  const outcome = await store.bindSubject({
    bindingId: `binding-${name}`,
    subject: subject(name),
    workerId,
    at: NOW,
  });
  assert(outcome.kind === "bound", `${name} binding must succeed`);
  return outcome.binding;
}

const authorizeInput = (
  binding: McpSubjectBinding,
  input: {
    readonly tool?: MusterMcpToolName;
    readonly at?: string;
    readonly slot?: string;
    readonly availability?: 0 | 1 | 2 | 3;
    readonly policy?: McpRateLimitPolicy;
  } = {},
): AuthorizeMcpCallInput => {
  const policy = input.policy ?? POLICY;
  const at = input.at ?? NOW;
  const tool = input.tool ?? "get_worker_status";
  return {
    expectedBinding: binding,
    tool,
    policy,
    window: mcpRateWindow(policy, at),
    assignedSlotOccurrence: input.slot ?? "slot-one",
    ...(tool === "lease_job"
      ? { availabilityBudgetBucket: input.availability ?? 3 }
      : {}),
    at,
  };
};

const bindReplayAndConflict: McpStateStoreConformanceCase = {
  id: "mcp-state-bind-replay-and-conflict",
  run: async (factory) => {
    const store = await factory();
    const first = await bind(store);
    const replay = await store.bindSubject({
      bindingId: first.bindingId,
      subject: first.subject,
      workerId: first.workerId,
      at: first.boundAt,
    });
    assert(replay.kind === "replayed", "exact bind must replay");
    assert(replay.binding.revision === first.revision, "replay must preserve revision");

    const idConflict = await store.bindSubject({
      bindingId: first.bindingId,
      subject: subject("other"),
      workerId: "worker-other",
      at: NOW,
    });
    assert(
      idConflict.kind === "conflict" && idConflict.reason === "binding_id",
      "binding ID reuse must conflict",
    );
    const subjectConflict = await store.bindSubject({
      bindingId: "binding-other",
      subject: first.subject,
      workerId: "worker-other",
      at: NOW,
    });
    assert(
      subjectConflict.kind === "conflict" && subjectConflict.reason === "subject",
      "subject reuse must conflict",
    );
    const workerConflict = await store.bindSubject({
      bindingId: "binding-other",
      subject: subject("other"),
      workerId: first.workerId,
      at: NOW,
    });
    assert(
      workerConflict.kind === "conflict" && workerConflict.reason === "worker",
      "worker reuse must conflict",
    );
  },
};

const bindRaces: McpStateStoreConformanceCase = {
  id: "mcp-state-bind-same-and-cross-key-races",
  run: async (factory) => {
    const sameSubject = await factory();
    const subjectRace = await Promise.all([
      sameSubject.bindSubject({
        bindingId: "binding-a",
        subject: subject("shared"),
        workerId: "worker-a",
        at: NOW,
      }),
      sameSubject.bindSubject({
        bindingId: "binding-b",
        subject: subject("shared"),
        workerId: "worker-b",
        at: NOW,
      }),
    ]);
    assert(
      subjectRace.filter(({ kind }) => kind === "bound").length === 1 &&
        subjectRace.filter(({ kind }) => kind === "conflict").length === 1,
      "same-subject bind race must have one winner",
    );

    const sameWorker = await factory();
    const workerRace = await Promise.all([
      sameWorker.bindSubject({
        bindingId: "binding-a",
        subject: subject("a"),
        workerId: "worker-shared",
        at: NOW,
      }),
      sameWorker.bindSubject({
        bindingId: "binding-b",
        subject: subject("b"),
        workerId: "worker-shared",
        at: NOW,
      }),
    ]);
    assert(
      workerRace.filter(({ kind }) => kind === "bound").length === 1 &&
        workerRace.filter(({ kind }) => kind === "conflict").length === 1,
      "same-worker bind race must have one winner",
    );

    const crossKey = await factory();
    const independent = await Promise.all([
      crossKey.bindSubject({
        bindingId: "binding-a",
        subject: subject("a"),
        workerId: "worker-a",
        at: NOW,
      }),
      crossKey.bindSubject({
        bindingId: "binding-b",
        subject: subject("b"),
        workerId: "worker-b",
        at: NOW,
      }),
    ]);
    assert(
      independent.every(({ kind }) => kind === "bound"),
      "cross-key binds must both succeed",
    );
  },
};

const severanceLifecycle: McpStateStoreConformanceCase = {
  id: "mcp-mapping-severance-fails-closed",
  run: async (factory) => {
    const store = await factory();
    const binding = await bind(store);
    const first = await store.severSubject({
      severanceId: "severance-one",
      expectedBinding: binding,
      at: LATER,
    });
    assert(first.kind === "severed", "severance must succeed");
    assert(
      !("subject" in first.receipt),
      "severance receipt must retain no raw subject",
    );
    const replay = await store.severSubject({
      severanceId: "severance-one",
      expectedBinding: binding,
      at: LATER,
    });
    assert(replay.kind === "replayed", "exact severance must replay");
    assert(await store.resolveSubject(binding.subject) === null, "severed subject must not resolve");

    const staleCall = await store.authorizeCall(authorizeInput(binding));
    assert(
      staleCall.kind === "refused" && staleCall.reason === "mapping_stale",
      "severed binding must not authorize",
    );
    const rebound = await store.bindSubject({
      bindingId: "binding-rebound",
      subject: binding.subject,
      workerId: binding.workerId,
      at: LATER,
    });
    assert(rebound.kind === "bound", "severed subject and worker may be rebound");
    assert(
      rebound.binding.revision > binding.revision,
      "rebound worker revision must increase",
    );
    const afterRebind = await store.authorizeCall(authorizeInput(rebound.binding));
    assert(
      afterRebind.kind === "authorized" && afterRebind.current.callsUsed === 1,
      "stale mapping refusal must not consume pseudonymous rate state",
    );
  },
};

const severanceRaces: McpStateStoreConformanceCase = {
  id: "mcp-state-sever-same-and-cross-key-races",
  run: async (factory) => {
    const store = await factory();
    const [one, two] = await Promise.all([
      bind(store, "one", "worker-one"),
      bind(store, "two", "worker-two"),
    ]);
    const same = await Promise.all([
      store.severSubject({
        severanceId: "severance-a",
        expectedBinding: one,
        at: LATER,
      }),
      store.severSubject({
        severanceId: "severance-b",
        expectedBinding: one,
        at: LATER,
      }),
    ]);
    assert(
      same.filter(({ kind }) => kind === "severed").length === 1 &&
        same.filter(({ kind }) => kind === "not_found").length === 1,
      "same-binding severance race must have one winner",
    );
    const crossKey = await factory();
    const [crossOne, crossTwo] = await Promise.all([
      bind(crossKey, "cross-one", "worker-cross-one"),
      bind(crossKey, "cross-two", "worker-cross-two"),
    ]);
    const independent = await Promise.all([
      crossKey.severSubject({
        severanceId: "severance-cross-one",
        expectedBinding: crossOne,
        at: LATER,
      }),
      crossKey.severSubject({
        severanceId: "severance-cross-two",
        expectedBinding: crossTwo,
        at: LATER,
      }),
    ]);
    assert(
      independent.every(({ kind }) => kind === "severed"),
      "cross-key severance race must let both commands succeed",
    );
    assert(
      await store.resolveSubject(two.subject) !== null,
      "same-key race must not disturb another binding",
    );
  },
};

const rateRace: McpStateStoreConformanceCase = {
  id: "mcp-rate-limit-race-single-winner",
  run: async (factory) => {
    const store = await factory();
    const binding = await bind(store);
    const first = await store.authorizeCall(authorizeInput(binding));
    assert(first.kind === "authorized", "first rate unit must authorize");
    const race = await Promise.all([
      store.authorizeCall(authorizeInput(binding)),
      store.authorizeCall(authorizeInput(binding)),
    ]);
    assert(
      race.filter(({ kind }) => kind === "authorized").length === 1 &&
        race.some((outcome) => outcome.kind === "refused" && outcome.reason === "rate_limited"),
      "last rate unit race must have one winner",
    );

    const other = await bind(store, "two", "worker-two");
    const crossKey = await Promise.all([
      store.authorizeCall(authorizeInput(binding)),
      store.authorizeCall(authorizeInput(other)),
    ]);
    assert(
      crossKey[0]?.kind === "refused" &&
        crossKey[0].reason === "rate_limited" &&
        crossKey[1]?.kind === "authorized",
      "cross-key rate race must keep the other worker independent",
    );
  },
};

const leaseAttemptAndSlotRollover: McpStateStoreConformanceCase = {
  id: "mcp-side-channel-lease-attempt-rate-slot-bound",
  run: async (factory) => {
    const store = await factory();
    const binding = await bind(store);
    const slotPolicy = {
      ...POLICY,
      maxCallsPerWindow: { ...POLICY.maxCallsPerWindow, lease_job: 4 },
    };
    const first = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 1,
      policy: slotPolicy,
    }));
    const second = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 1,
      policy: slotPolicy,
    }));
    assert(
      first.kind === "authorized" && second.kind === "authorized" &&
        second.current.leaseAttemptsUsed === 2,
      "lease attempts must count within the slot occurrence",
    );
    const capped = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 1,
      policy: slotPolicy,
    }));
    assert(
      capped.kind === "refused" && capped.reason === "slot_attempt_limit",
      "slot attempt cap must refuse without changing state",
    );
    const changedPolicy = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      slot: "slot-two",
      availability: 1,
      policy: { ...slotPolicy, maxLeaseAttemptsPerSlot: 3 },
    }));
    assert(
      changedPolicy.kind === "refused" &&
        changedPolicy.reason === "policy_or_window_invalid",
      "policy version reuse must fail before changing a new slot",
    );

    const nextPolicy = {
      ...POLICY,
      version: "rate-2",
      maxCallsPerWindow: { ...POLICY.maxCallsPerWindow, lease_job: 3 },
    };
    const [oldSlot, nextSlot] = await Promise.all([
      store.authorizeCall(authorizeInput(binding, {
        tool: "lease_job",
        availability: 1,
        policy: slotPolicy,
      })),
      store.authorizeCall(authorizeInput(binding, {
        tool: "lease_job",
        slot: "slot-two",
        availability: 3,
        policy: nextPolicy,
      })),
    ]);
    assert(
      oldSlot.kind === "refused" && oldSlot.reason === "slot_attempt_limit" &&
      nextSlot.kind === "authorized" &&
        nextSlot.current.leaseAttemptsUsed === 1 &&
        nextSlot.current.availabilityBudgetBucket === 3,
      "slot-rollover race must keep occurrences independent",
    );
  },
};

const availabilityRace: McpStateStoreConformanceCase = {
  id: "mcp-availability-race-monotonic",
  run: async (factory) => {
    const store = await factory();
    const binding = await bind(store);
    const policy = {
      ...POLICY,
      maxCallsPerWindow: { ...POLICY.maxCallsPerWindow, lease_job: 4 },
      maxLeaseAttemptsPerSlot: 4,
    };
    const race = await Promise.all([
      store.authorizeCall(authorizeInput(binding, {
        tool: "lease_job",
        availability: 2,
        policy,
      })),
      store.authorizeCall(authorizeInput(binding, {
        tool: "lease_job",
        availability: 1,
        policy,
      })),
    ]);
    assert(
      race.some((outcome) => outcome.kind === "authorized" &&
        outcome.current.availabilityBudgetBucket === 1),
      "lower availability must authorize",
    );
    assert(
      race.every((outcome) => outcome.kind === "authorized" ||
        outcome.reason === "availability_increase"),
      "competing higher availability may only lose monotonically",
    );
    const increase = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 2,
      policy,
    }));
    assert(
      increase.kind === "refused" && increase.reason === "availability_increase",
      "lower availability must be absorbing within the occurrence",
    );
    const lower = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 0,
      policy,
    }));
    assert(
      lower.kind === "authorized" && lower.current.availabilityBudgetBucket === 0,
      "availability may continue decreasing",
    );
    const other = await bind(store, "availability-two", "worker-availability-two");
    const crossKey = await Promise.all([
      store.authorizeCall(authorizeInput(binding, {
        tool: "lease_job",
        availability: 0,
        policy,
      })),
      store.authorizeCall(authorizeInput(other, {
        tool: "lease_job",
        availability: 3,
        policy,
      })),
    ]);
    assert(
      crossKey.every(({ kind }) => kind === "authorized"),
      "cross-key availability race must keep workers independent",
    );
  },
};

const availabilityMonotonic: McpStateStoreConformanceCase = {
  id: "mcp-side-channel-availability-monotonic",
  run: async (factory) => {
    const store = await factory();
    const binding = await bind(store);
    const policy = {
      ...POLICY,
      version: "rate-monotonic-1",
      maxCallsPerWindow: { ...POLICY.maxCallsPerWindow, lease_job: 4 },
      maxLeaseAttemptsPerSlot: 4,
    };
    for (const availability of [2, 2, 1] as const) {
      const outcome = await store.authorizeCall(authorizeInput(binding, {
        tool: "lease_job",
        availability,
        policy,
      }));
      assert(
        outcome.kind === "authorized" &&
          outcome.current.availabilityBudgetBucket === availability,
        "equal or lower availability must authorize",
      );
    }
    const increase = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 2,
      policy,
    }));
    assert(
      increase.kind === "refused" && increase.reason === "availability_increase",
      "availability must not increase within one occurrence",
    );
    const afterRefusal = await store.authorizeCall(authorizeInput(binding, {
      tool: "lease_job",
      availability: 0,
      policy,
    }));
    assert(
      afterRefusal.kind === "authorized" &&
        afterRefusal.current.callsUsed === 4 &&
        afterRefusal.current.leaseAttemptsUsed === 4,
      "availability refusal must change no rate or attempt counter",
    );
  },
};

const windowRolloverAndAtomicRefusal: McpStateStoreConformanceCase = {
  id: "mcp-state-window-rollover-and-atomic-refusal",
  run: async (factory) => {
    const store = await factory();
    const binding = await bind(store);
    const first = await store.authorizeCall(authorizeInput(binding));
    assert(first.kind === "authorized", "first window must authorize");
    const invalid = await store.authorizeCall({
      ...authorizeInput(binding),
      window: mcpRateWindow(POLICY, NEXT_WINDOW),
    });
    assert(
      invalid.kind === "refused" && invalid.reason === "policy_or_window_invalid",
      "mismatched window must fail closed",
    );
    const second = await store.authorizeCall(authorizeInput(binding));
    assert(
      second.kind === "authorized" && second.current.callsUsed === 2,
      "invalid window must not consume a rate unit",
    );
    const next = await store.authorizeCall(authorizeInput(binding, {
      at: NEXT_WINDOW,
    }));
    assert(
      next.kind === "authorized" && next.current.callsUsed === 1,
      "new fixed UTC window must start a new counter",
    );
  },
};

const detachedBoundaries: McpStateStoreConformanceCase = {
  id: "mcp-state-detached-inputs-and-records",
  run: async (factory) => {
    const store = await factory();
    const input = {
      bindingId: "binding-one",
      subject: subject("one"),
      workerId: "worker-one",
      at: NOW,
    };
    const pending = store.bindSubject(input);
    input.subject.subject = "subject-mutated";
    const bound = await pending;
    assert(bound.kind === "bound", "captured bind must succeed");
    assert(
      bound.binding.subject.subject === "subject-one",
      "bind input must be captured before asynchronous mutation",
    );
    bound.binding.subject.subject = "subject-output-mutated";
    const resolved = await store.resolveSubject(subject("one"));
    assert(
      resolved?.subject.subject === "subject-one",
      "returned binding must not alias durable state",
    );
  },
};

export const MCP_STATE_STORE_CONFORMANCE_CASES: readonly McpStateStoreConformanceCase[] =
  Object.freeze([
    bindReplayAndConflict,
    bindRaces,
    severanceLifecycle,
    severanceRaces,
    rateRace,
    leaseAttemptAndSlotRollover,
    availabilityMonotonic,
    availabilityRace,
    windowRolloverAndAtomicRefusal,
    detachedBoundaries,
  ]);

export async function runMcpStateStoreConformance(
  factory: McpStateStoreFactory,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const testCase of MCP_STATE_STORE_CONFORMANCE_CASES) {
    try {
      await testCase.run(factory);
      passed.push(testCase.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${testCase.id}: ${detail}`, { cause: error });
    }
  }
  return Object.freeze(passed);
}
