import {
  MUSTER_MCP_TOOL_NAMES,
  TOOL_SCHEMAS,
  canonicalize,
  deepFreeze,
  mcpRateWindow,
  type McpRateLimitPolicy,
  type McpStateStore,
  type MusterMcpToolName,
} from "@kuindji/muster-contract";
import type { ControlPlaneService } from "@kuindji/muster-core";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { MusterMcpAuthenticatedRequest } from "./auth.js";
import { genericToolError, pendingToolResult } from "./results.js";
import type { SkillReleaseRegistry } from "./skill-releases.js";

type ControlPlaneBoundary = Pick<ControlPlaneService, "setWorkerAvailability">;

export interface MusterMcpWorkerToolDependencies {
  readonly stateStore: Pick<McpStateStore, "authorizeCall">;
  readonly rateLimitPolicy: McpRateLimitPolicy;
  readonly controlPlaneService: ControlPlaneBoundary;
  readonly skillReleaseRegistry: SkillReleaseRegistry;
}

type WorkerToolName = "get_worker_status" | "set_availability";

interface SetAvailabilityInput {
  readonly state: "active" | "maintenance";
}

const WORKER_TOOL_NAMES = new Set<MusterMcpToolName>([
  "get_worker_status",
  "set_availability",
]);

/** Worker-tool projection over the frozen status and control-plane boundaries. */
export class MusterMcpWorkerToolDispatcher {
  private readonly dependencies: MusterMcpWorkerToolDependencies;
  private readonly inputValidators: Readonly<
    Record<WorkerToolName, ReturnType<AjvJsonSchemaValidator["getValidator"]>>
  >;
  private readonly outputValidators: Readonly<
    Record<WorkerToolName, ReturnType<AjvJsonSchemaValidator["getValidator"]>>
  >;

  constructor(dependencies: MusterMcpWorkerToolDependencies) {
    const rateLimitPolicy = structuredClone(dependencies.rateLimitPolicy);
    mcpRateWindow(rateLimitPolicy, "2026-01-01T00:00:00.000Z");
    this.dependencies = {
      ...dependencies,
      rateLimitPolicy: deepFreeze(rateLimitPolicy),
    };
    const validator = new AjvJsonSchemaValidator();
    this.inputValidators = Object.freeze({
      get_worker_status: validator.getValidator(
        TOOL_SCHEMAS.get_worker_status.inputSchema,
      ),
      set_availability: validator.getValidator(
        TOOL_SCHEMAS.set_availability.inputSchema,
      ),
    });
    this.outputValidators = Object.freeze({
      get_worker_status: validator.getValidator(
        TOOL_SCHEMAS.get_worker_status.outputSchema,
      ),
      set_availability: validator.getValidator(
        TOOL_SCHEMAS.set_availability.outputSchema,
      ),
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
    if (!WORKER_TOOL_NAMES.has(tool as MusterMcpToolName)) {
      return pendingToolResult();
    }
    if (authenticated === undefined) return genericToolError();

    const workerTool = tool as WorkerToolName;
    const validated = this.inputValidators[workerTool](input);
    if (!validated.valid) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid tool input.");
    }
    const captured = structuredClone(validated.data);

    let authorization;
    try {
      authorization = await this.dependencies.stateStore.authorizeCall({
        expectedBinding: authenticated.binding,
        tool: workerTool,
        policy: this.dependencies.rateLimitPolicy,
        window: mcpRateWindow(this.dependencies.rateLimitPolicy, authenticated.at),
        assignedSlotOccurrence: authenticated.workerStatus.assignedSlotOccurrence,
        at: authenticated.at,
      });
    } catch {
      return genericToolError();
    }
    if (authorization.kind !== "authorized") return genericToolError();

    let value: Record<string, unknown>;
    try {
      value = await this.invoke(workerTool, captured, authenticated);
    } catch {
      return genericToolError();
    }
    const output = this.outputValidators[workerTool](value);
    if (!output.valid) return genericToolError();
    const detached = structuredClone(output.data) as Record<string, unknown>;
    return {
      structuredContent: detached,
      content: [{ type: "text", text: canonicalize(detached) }],
    };
  }

  private async invoke(
    tool: WorkerToolName,
    input: unknown,
    authenticated: MusterMcpAuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    if (tool === "get_worker_status") {
      const status = authenticated.workerStatus;
      const release = this.dependencies.skillReleaseRegistry.select({
        contractVersion: status.contractVersion,
        jobClassIds: status.jobClassIds,
      });
      if (release === null) throw new Error("skill release unavailable");
      return {
        status: status.state,
        contract_version: status.contractVersion,
        skill_sha256: release.skillSha256,
        cap_usage_bucket: status.capUsageBucket,
        next_slot_bucket: status.nextSlotBucket,
      };
    }

    const result = await this.dependencies.controlPlaneService.setWorkerAvailability(
      authenticated.workerId,
      (input as SetAvailabilityInput).state,
      authenticated.at,
    );
    if (!result.ok) throw new Error("availability transition refused");
    return { outcome: "recorded" };
  }
}
