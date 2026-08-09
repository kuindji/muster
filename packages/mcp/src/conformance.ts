import {
  MUSTER_MCP_TOOL_NAMES,
  TOOL_SCHEMAS,
  canonicalize,
  type MusterMcpToolName,
} from "@kuindji/muster-contract";
import {
  runMcpStateStoreConformance,
  type McpStateStoreFactory,
} from "./state-conformance.js";

export const MUSTER_MCP_SIDE_CHANNEL_FIXTURE_IDS = Object.freeze([
  "mcp-side-channel-availability-monotonic",
  "mcp-side-channel-no-work-coarse",
  "mcp-side-channel-lease-attempt-rate-slot-bound",
  "mcp-side-channel-selection-timing-invariant",
  "mcp-side-channel-ttl-batch-quantized",
  "mcp-side-channel-payload-response-padding",
  "mcp-side-channel-schema-policy-routing-invariant",
  "mcp-side-channel-source-language-minimized",
  "mcp-side-channel-canary-real-resolved",
  "mcp-side-channel-extend-refusal-uniform",
  "mcp-side-channel-submit-error-uniform",
  "mcp-side-channel-status-buckets-coarse",
  "mcp-side-channel-degraded-no-work-coarse",
] as const);

export const MUSTER_MCP_CONFORMANCE_FIXTURE_IDS = Object.freeze([
  "mcp-lease-output-schema-disclosed",
  "mcp-submit-result-json-parse-refusal",
  "mcp-submit-result-json-duplicate-name-refusal",
  "mcp-submit-result-json-string-root",
  "mcp-submit-result-json-canonical-replay",
  ...MUSTER_MCP_SIDE_CHANNEL_FIXTURE_IDS,
  "mcp-direct-call-same-boundary",
  "mcp-exact-retry-byte-identical",
  "mcp-mapping-severance-fails-closed",
  "mcp-scope-refusal-step-up",
  "mcp-rate-limit-race-single-winner",
  "mcp-availability-race-monotonic",
  "mcp-token-revocation-request-boundary",
  "mcp-worker-revocation-request-boundary",
  "mcp-skill-release-complete-class-set",
  "mcp-extension-bucket-overflow-projection",
  "mcp-abandon-refusal-wire-code",
] as const);

export interface MusterMcpPromptInjectionFixture {
  readonly id: string;
  readonly category: string;
  readonly payloadText: string;
}

export interface MusterMcpConformanceFixturePack {
  readonly lifecycleFixtureIds: readonly string[];
  readonly promptInjections: readonly MusterMcpPromptInjectionFixture[];
}

export interface MusterMcpConformanceToolResult {
  readonly structuredContent?: unknown | undefined;
  readonly content: readonly {
    readonly type: string;
    readonly text?: string | undefined;
  }[];
  readonly isError?: boolean | undefined;
}

export interface MusterMcpConformanceHarness {
  listTools(): Promise<{
    readonly tools: readonly {
      readonly name: string;
      readonly inputSchema: unknown;
      readonly outputSchema?: unknown;
    }[];
  }>;
  callTool(input: {
    readonly name: MusterMcpToolName;
    readonly arguments: Record<string, unknown>;
  }): Promise<MusterMcpConformanceToolResult>;
  enqueue(jobId: string, payloadText: string): Promise<void>;
  enterDegradedMode(): Promise<void>;
  restart(): Promise<void>;
  auditArtifacts(): Promise<readonly unknown[]>;
  readonly sensitiveValues: readonly string[];
  close(): Promise<void>;
}

export interface MusterMcpConformanceFactory {
  createHarness(): Promise<MusterMcpConformanceHarness>;
  readonly stateStoreFactory: McpStateStoreFactory;
}

export interface MusterMcpConformanceReport {
  readonly fixtureIds: readonly string[];
  readonly stateStoreCaseIds: readonly string[];
  readonly successfulResultBytes: readonly string[];
  readonly promptInjectionIds: readonly string[];
}

const fail = (message: string): never => {
  throw new Error(`Muster MCP conformance failure: ${message}`);
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) fail(message);
};

const record = (value: unknown): Record<string, unknown> => {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "tool result must be an object",
  );
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `unexpected result keys ${actual.join(",")}`,
  );
};

const successfulBytes = (
  result: MusterMcpConformanceToolResult,
  label: string,
): string => {
  assert(result.isError !== true, `${label} returned an error`);
  const value = record(result.structuredContent);
  const bytes = canonicalize(value);
  assert(
    result.content.length === 1 &&
      result.content[0]?.type === "text" &&
      result.content[0].text === bytes,
    `${label} canonical text mirror differs from structured content`,
  );
  return bytes;
};

const closeQuietly = async (
  harness: MusterMcpConformanceHarness,
): Promise<void> => {
  await harness.close().catch(() => undefined);
};

const audit = async (harness: MusterMcpConformanceHarness): Promise<void> => {
  const serialized = canonicalize(await harness.auditArtifacts());
  for (const sensitive of harness.sensitiveValues) {
    assert(
      sensitive.length === 0 || !serialized.includes(sensitive),
      "raw OAuth identity or bearer material crossed the MCP audit boundary",
    );
  }
};

const validateFixtures = (fixtures: MusterMcpConformanceFixturePack): void => {
  const lifecycleIds = new Set(fixtures.lifecycleFixtureIds);
  for (const id of MUSTER_MCP_CONFORMANCE_FIXTURE_IDS) {
    assert(lifecycleIds.has(id), `missing frozen lifecycle fixture ${id}`);
  }
  const promptIds = new Set<string>();
  for (const fixture of fixtures.promptInjections) {
    assert(fixture.id.length > 0, "prompt-injection fixture ID is empty");
    assert(
      !promptIds.has(fixture.id),
      `duplicate prompt-injection fixture ${fixture.id}`,
    );
    assert(fixture.category.length > 0, `${fixture.id}: category is empty`);
    assert(fixture.payloadText.length > 0, `${fixture.id}: payload text is empty`);
    promptIds.add(fixture.id);
  }
  assert(promptIds.size > 0, "prompt-injection fixture pack is empty");
};

async function schemaCase(
  factory: MusterMcpConformanceFactory,
): Promise<void> {
  const harness = await factory.createHarness();
  try {
    const listed = await harness.listTools();
    assert(
      canonicalize(listed.tools.map(({ name }) => name)) ===
        canonicalize(MUSTER_MCP_TOOL_NAMES),
      "tools/list names or ordering differ from the frozen catalog",
    );
    for (const tool of listed.tools) {
      const name = tool.name as MusterMcpToolName;
      assert(
        Object.hasOwn(TOOL_SCHEMAS, name),
        `tools/list exposed unknown tool ${name}`,
      );
      assert(
        canonicalize(tool.inputSchema) ===
          canonicalize(TOOL_SCHEMAS[name].inputSchema),
        `${name} input schema differs from TOOL_SCHEMAS`,
      );
      assert(
        canonicalize(tool.outputSchema) ===
          canonicalize(TOOL_SCHEMAS[name].outputSchema),
        `${name} output schema differs from TOOL_SCHEMAS`,
      );
    }
    await audit(harness);
  } finally {
    await closeQuietly(harness);
  }
}

async function noWorkCase(
  factory: MusterMcpConformanceFactory,
): Promise<string> {
  const harness = await factory.createHarness();
  try {
    const noWork = await harness.callTool({
      name: "lease_job",
      arguments: { availability: { budget_bucket: 2 } },
    });
    const bytes = successfulBytes(noWork, "empty lease_job");
    exactKeys(record(noWork.structuredContent), ["outcome"]);
    assert(
      bytes === '{"outcome":"no_work"}',
      "empty lease result leaked a reason",
    );
    await harness.enterDegradedMode();
    const degraded = await harness.callTool({
      name: "lease_job",
      arguments: { availability: { budget_bucket: 2 } },
    });
    assert(
      successfulBytes(degraded, "degraded lease_job") === bytes,
      "degraded and empty queue states produced distinguishable no-work bodies",
    );
    await audit(harness);
    return bytes;
  } finally {
    await closeQuietly(harness);
  }
}

async function availabilityInvariantCase(
  factory: MusterMcpConformanceFactory,
): Promise<readonly string[]> {
  const results: string[] = [];
  let selected: string | undefined;
  for (const budgetBucket of [1, 3] as const) {
    const harness = await factory.createHarness();
    try {
      await harness.enqueue(
        "job-availability-invariant",
        "availability invariant",
      );
      const leased = await harness.callTool({
        name: "lease_job",
        arguments: { availability: { budget_bucket: budgetBucket } },
      });
      const bytes = successfulBytes(leased, `lease_job bucket ${budgetBucket}`);
      const value = record(leased.structuredContent);
      exactKeys(value, [
        "lease_id",
        "input_hash",
        "job_class_id",
        "contract_version",
        "ttl_bucket_seconds",
        "payload",
        "output_schema",
      ]);
      const invariant = canonicalize({
        input_hash: value.input_hash,
        job_class_id: value.job_class_id,
        contract_version: value.contract_version,
        payload: value.payload,
        output_schema: value.output_schema,
      });
      selected ??= invariant;
      assert(
        selected === invariant,
        "availability changed selected job or payload",
      );
      results.push(bytes);
      await audit(harness);
    } finally {
      await closeQuietly(harness);
    }
  }
  return Object.freeze(results);
}

async function sixToolRestartCase(
  factory: MusterMcpConformanceFactory,
): Promise<readonly string[]> {
  const harness = await factory.createHarness();
  const bytes: string[] = [];
  try {
    await harness.enqueue("job-conformance-one", "answer job-conformance-one");
    const leased = await harness.callTool({
      name: "lease_job",
      arguments: { availability: { budget_bucket: 3 } },
    });
    bytes.push(successfulBytes(leased, "lease_job"));
    const lease = record(leased.structuredContent);

    const extended = await harness.callTool({
      name: "extend_lease",
      arguments: { lease_id: lease.lease_id },
    });
    bytes.push(successfulBytes(extended, "extend_lease"));
    exactKeys(record(extended.structuredContent), ["new_expiry_bucket_seconds"]);

    const submissionArguments = {
      lease_id: lease.lease_id,
      input_hash: lease.input_hash,
      result_json: JSON.stringify({ answer: "accepted conformance result" }),
    };
    const accepted = await harness.callTool({
      name: "submit_result",
      arguments: submissionArguments,
    });
    const acceptedBytes = successfulBytes(accepted, "submit_result");
    bytes.push(acceptedBytes);
    await harness.restart();
    const replayed = await harness.callTool({
      name: "submit_result",
      arguments: {
        ...submissionArguments,
        result_json: ' { "answer" : "accepted conformance result" } ',
      },
    });
    const replayedBytes = successfulBytes(replayed, "submit_result replay");
    assert(acceptedBytes === replayedBytes, "accepted replay changed across restart");

    await harness.enqueue("job-conformance-two", "answer job-conformance-two");
    const second = await harness.callTool({
      name: "lease_job",
      arguments: { availability: { budget_bucket: 3 } },
    });
    const secondLease = record(second.structuredContent);
    const abandoned = await harness.callTool({
      name: "abandon_job",
      arguments: {
        lease_id: secondLease.lease_id,
        reason: "platform_failure",
      },
    });
    bytes.push(successfulBytes(abandoned, "abandon_job"));
    exactKeys(record(abandoned.structuredContent), ["outcome"]);

    const status = await harness.callTool({
      name: "get_worker_status",
      arguments: {},
    });
    bytes.push(successfulBytes(status, "get_worker_status"));
    exactKeys(record(status.structuredContent), [
      "status",
      "contract_version",
      "skill_sha256",
      "cap_usage_bucket",
      "next_slot_bucket",
    ]);

    const availability = await harness.callTool({
      name: "set_availability",
      arguments: { state: "maintenance" },
    });
    bytes.push(successfulBytes(availability, "set_availability"));
    exactKeys(record(availability.structuredContent), ["outcome"]);
    await audit(harness);
    return Object.freeze(bytes);
  } finally {
    await closeQuietly(harness);
  }
}

async function promptInjectionCase(
  factory: MusterMcpConformanceFactory,
  fixtures: readonly MusterMcpPromptInjectionFixture[],
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const harness = await factory.createHarness();
    try {
      await harness.enqueue(`job-prompt-${index + 1}`, fixture.payloadText);
      const leased = await harness.callTool({
        name: "lease_job",
        arguments: { availability: { budget_bucket: 2 } },
      });
      const lease = record(leased.structuredContent);
      assert(
        canonicalize(lease.payload) ===
          canonicalize({ instruction: fixture.payloadText }),
        `${fixture.id}: leased prompt text was interpreted or changed`,
      );
      const submitted = await harness.callTool({
        name: "submit_result",
        arguments: {
          lease_id: lease.lease_id,
          input_hash: lease.input_hash,
          result_json: JSON.stringify({ answer: fixture.payloadText }),
        },
      });
      assert(
        record(submitted.structuredContent).outcome === "accepted",
        `${fixture.id}: data-bearing result was not accepted`,
      );
      const listed = await harness.listTools();
      assert(
        canonicalize(listed.tools.map(({ name }) => name)) ===
          canonicalize(MUSTER_MCP_TOOL_NAMES),
        `${fixture.id}: payload text redirected tool registration or dispatch`,
      );
      await audit(harness);
      passed.push(fixture.id);
    } finally {
      await closeQuietly(harness);
    }
  }
  return Object.freeze(passed);
}

/**
 * Drives the stable authenticated MCP boundary through an adapter-neutral
 * harness. Each harness must be isolated; restart must rebuild the request
 * boundary while retaining its durable Store and MCP-state instances.
 */
export async function runMusterMcpConformance(
  factory: MusterMcpConformanceFactory,
  fixtures: MusterMcpConformanceFixturePack,
): Promise<MusterMcpConformanceReport> {
  validateFixtures(fixtures);
  await schemaCase(factory);
  const successfulResultBytes = [
    await noWorkCase(factory),
    ...await availabilityInvariantCase(factory),
    ...await sixToolRestartCase(factory),
  ];
  const promptInjectionIds = await promptInjectionCase(
    factory,
    fixtures.promptInjections,
  );
  const stateStoreCaseIds = await runMcpStateStoreConformance(
    factory.stateStoreFactory,
  );
  return Object.freeze({
    fixtureIds: MUSTER_MCP_CONFORMANCE_FIXTURE_IDS,
    stateStoreCaseIds,
    successfulResultBytes: Object.freeze(successfulResultBytes),
    promptInjectionIds,
  });
}
