import {
  MUSTER_MCP_ABANDON_REFUSAL_ERROR,
  MUSTER_MCP_TOOL_NAMES,
  TOOL_SCHEMAS,
  canonicalize,
  deepFreeze,
  mcpRateWindow,
  mcpTtlBucketSeconds,
  type McpRateLimitPolicy,
  type McpStateStore,
  type MusterMcpToolName,
  type SubmissionReceipt,
} from "@kuindji/muster-contract";
import type {
  LeaseService,
  SubmissionService,
} from "@kuindji/muster-core";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { MusterMcpAuthenticatedRequest } from "./auth.js";
import { pendingToolResult } from "./results.js";

export const MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE =
  "Muster tool request could not be completed.";

const JOB_TOOL_NAMES = new Set<MusterMcpToolName>([
  "lease_job",
  "submit_result",
  "abandon_job",
  "extend_lease",
]);

type LeaseServiceBoundary = Pick<
  LeaseService,
  "leaseJob" | "extendLease" | "abandonLease"
>;

type SubmissionServiceBoundary = Pick<SubmissionService, "submitResult">;

export interface MusterMcpJobToolDependencies {
  readonly stateStore: Pick<McpStateStore, "authorizeCall">;
  readonly rateLimitPolicy: McpRateLimitPolicy;
  readonly leaseService: LeaseServiceBoundary;
  readonly submissionService: SubmissionServiceBoundary;
}

type JobToolName =
  | "lease_job"
  | "submit_result"
  | "abandon_job"
  | "extend_lease";

interface LeaseJobInput {
  readonly availability: { readonly budget_bucket: 0 | 1 | 2 | 3 };
}

interface SubmitResultInput {
  readonly lease_id: string;
  readonly input_hash: string;
  readonly result: unknown;
}

interface AbandonJobInput {
  readonly lease_id: string;
  readonly reason: "before_payload" | "after_payload" | "platform_failure";
}

interface ExtendLeaseInput {
  readonly lease_id: string;
}

const abandonClassifications = Object.freeze({
  before_payload: "abandoned_before_payload",
  after_payload: "abandoned_after_payload",
  platform_failure: "provider_or_platform_failure",
} as const);

function genericToolError(): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE }],
  };
}

function secondsBetween(later: string, earlier: string): number | null {
  const seconds = (Date.parse(later) - Date.parse(earlier)) / 1_000;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function ttlBucket(later: string, earlier: string): number | null {
  const seconds = secondsBetween(later, earlier);
  return seconds === null ? null : mcpTtlBucketSeconds(seconds);
}

function submissionValue(receipt: SubmissionReceipt): Record<string, unknown> {
  return {
    lease_id: receipt.leaseId,
    job_id: receipt.jobId,
    collection_cycle: receipt.collectionCycle,
    input_hash: receipt.inputHash,
    result_hash: receipt.resultHash,
    contract_version: receipt.contractVersion,
    permit_epoch: receipt.permitEpoch,
    outcome: receipt.outcome,
    accepted_at: receipt.acceptedAt,
  };
}

/**
 * Request-local job-tool dispatch over the reviewed MCP-state and public core
 * boundaries. The immutable rate policy is captured before any request work.
 */
export class MusterMcpJobToolDispatcher {
  private readonly dependencies: MusterMcpJobToolDependencies;
  private readonly inputValidators: Readonly<Record<JobToolName, ReturnType<AjvJsonSchemaValidator["getValidator"]>>>;
  private readonly outputValidators: Readonly<Record<JobToolName, ReturnType<AjvJsonSchemaValidator["getValidator"]>>>;

  constructor(dependencies: MusterMcpJobToolDependencies) {
    const rateLimitPolicy = structuredClone(dependencies.rateLimitPolicy);
    // Exercise every closed field and bound once at construction.
    mcpRateWindow(rateLimitPolicy, "2026-01-01T00:00:00.000Z");
    this.dependencies = {
      ...dependencies,
      rateLimitPolicy: deepFreeze(rateLimitPolicy),
    };
    const validator = new AjvJsonSchemaValidator();
    this.inputValidators = Object.freeze({
      lease_job: validator.getValidator(TOOL_SCHEMAS.lease_job.inputSchema),
      submit_result: validator.getValidator(TOOL_SCHEMAS.submit_result.inputSchema),
      abandon_job: validator.getValidator(TOOL_SCHEMAS.abandon_job.inputSchema),
      extend_lease: validator.getValidator(TOOL_SCHEMAS.extend_lease.inputSchema),
    });
    this.outputValidators = Object.freeze({
      lease_job: validator.getValidator(TOOL_SCHEMAS.lease_job.outputSchema),
      submit_result: validator.getValidator(TOOL_SCHEMAS.submit_result.outputSchema),
      abandon_job: validator.getValidator(TOOL_SCHEMAS.abandon_job.outputSchema),
      extend_lease: validator.getValidator(TOOL_SCHEMAS.extend_lease.outputSchema),
    });
  }

  async call(
    tool: string,
    input: unknown,
    authenticated: MusterMcpAuthenticatedRequest | undefined,
  ): Promise<CallToolResult> {
    if (!MUSTER_MCP_TOOL_NAMES.includes(tool as MusterMcpToolName)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool.");
    }
    if (!JOB_TOOL_NAMES.has(tool as MusterMcpToolName)) return pendingToolResult();
    if (authenticated === undefined) return genericToolError();

    const jobTool = tool as JobToolName;
    const validated = this.inputValidators[jobTool](input);
    if (!validated.valid) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Invalid tool input.",
      );
    }
    const captured = structuredClone(validated.data);

    const availabilityBudgetBucket = jobTool === "lease_job"
      ? (captured as LeaseJobInput).availability.budget_bucket
      : undefined;
    let authorization;
    try {
      authorization = await this.dependencies.stateStore.authorizeCall({
        expectedBinding: authenticated.binding,
        tool: jobTool,
        policy: this.dependencies.rateLimitPolicy,
        window: mcpRateWindow(this.dependencies.rateLimitPolicy, authenticated.at),
        assignedSlotOccurrence: authenticated.workerStatus.assignedSlotOccurrence,
        ...(availabilityBudgetBucket === undefined
          ? {}
          : { availabilityBudgetBucket }),
        at: authenticated.at,
      });
    } catch {
      return genericToolError();
    }
    if (authorization.kind !== "authorized") return genericToolError();

    let value: Record<string, unknown>;
    try {
      value = await this.invoke(jobTool, captured, authenticated);
    } catch {
      return genericToolError();
    }
    const output = this.outputValidators[jobTool](value);
    if (!output.valid) return genericToolError();
    const detached = structuredClone(output.data) as Record<string, unknown>;
    return {
      structuredContent: detached,
      content: [{ type: "text", text: canonicalize(detached) }],
    };
  }

  private async invoke(
    tool: JobToolName,
    input: unknown,
    authenticated: MusterMcpAuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    switch (tool) {
      case "lease_job": {
        if ((input as LeaseJobInput).availability.budget_bucket === 0) {
          return { outcome: "no_work" };
        }
        const result = await this.dependencies.leaseService.leaseJob(
          authenticated.workerId,
        );
        if (result.outcome === "no_work") return { outcome: "no_work" };
        const bucket = ttlBucket(result.lease.expiresAt, result.lease.issuedAt);
        if (bucket === null) throw new Error("invalid durable lease TTL");
        return {
          lease_id: result.lease.leaseId,
          input_hash: result.lease.inputHash,
          job_class_id: result.lease.classId,
          contract_version: result.lease.contractVersion,
          ttl_bucket_seconds: bucket,
          payload: structuredClone(result.payload),
        };
      }
      case "submit_result": {
        const captured = input as SubmitResultInput;
        const result = await this.dependencies.submissionService.submitResult(
          authenticated.workerId,
          captured.lease_id,
          captured.input_hash,
          captured.result,
        );
        return result.ok ? submissionValue(result.receipt) : { error: result.error };
      }
      case "abandon_job": {
        const captured = input as AbandonJobInput;
        const result = await this.dependencies.leaseService.abandonLease(
          authenticated.workerId,
          captured.lease_id,
          abandonClassifications[captured.reason],
        );
        return result.outcome === "recorded"
          ? { outcome: "recorded" }
          : { error: MUSTER_MCP_ABANDON_REFUSAL_ERROR };
      }
      case "extend_lease": {
        const captured = input as ExtendLeaseInput;
        const result = await this.dependencies.leaseService.extendLease(
          authenticated.workerId,
          captured.lease_id,
        );
        if (result.outcome === "refused") return { outcome: "refused" };
        const bucket = ttlBucket(result.newExpiry, authenticated.at);
        if (bucket === null) throw new Error("invalid durable extension expiry");
        return { new_expiry_bucket_seconds: bucket };
      }
    }
  }
}
