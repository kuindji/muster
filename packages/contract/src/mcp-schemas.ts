import { deepFreeze } from "./deep-freeze.js";
import { WORKER_WIRE_ERROR_CODES } from "./errors.js";
import {
  MUSTER_MCP_ABANDON_REFUSAL_ERROR,
  MUSTER_MCP_TOOL_SCOPES,
} from "./mcp-boundary.js";
import { TTL_BUCKETS_SECONDS } from "./tables/quantization.js";

/** Spec 5.2/5.7. All schemas are closed and expose buckets, not precision. */
export const AVAILABILITY_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["budget_bucket"],
  properties: {
    budget_bucket: { type: "integer", minimum: 0, maximum: 3 },
  },
} as const);

/** Remaining-allowance tier for one scheduled invocation window. */
export const BUDGET_BUCKET_MEANINGS = deepFreeze({
  0: "exhausted",
  1: "low",
  2: "standard",
  3: "ample",
} as const);

export const NO_WORK_SHAPE = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: { outcome: { const: "no_work" } },
} as const);

export const UNIFORM_ERROR_SHAPE = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: { error: { enum: [...WORKER_WIRE_ERROR_CODES] } },
} as const);

const LEASE_BATCH_SHAPE = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "lease_id",
    "input_hash",
    "job_class_id",
    "contract_version",
    "ttl_bucket_seconds",
    "payload",
  ],
  properties: {
    lease_id: { type: "string" },
    input_hash: { type: "string" },
    job_class_id: { type: "string" },
    contract_version: { type: "string" },
    ttl_bucket_seconds: { enum: [...TTL_BUCKETS_SECONDS] },
    payload: {},
  },
} as const);

export const TOOL_SCHEMAS = deepFreeze({
  lease_job: {
    scope: MUSTER_MCP_TOOL_SCOPES.lease_job,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["availability"],
      properties: { availability: AVAILABILITY_SCHEMA },
    },
    outputSchema: { oneOf: [LEASE_BATCH_SHAPE, NO_WORK_SHAPE] },
  },
  submit_result: {
    scope: MUSTER_MCP_TOOL_SCOPES.submit_result,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["lease_id", "input_hash", "result"],
      properties: {
        lease_id: { type: "string" },
        input_hash: { type: "string" },
        result: {},
      },
    },
    outputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "lease_id", "job_id", "collection_cycle", "input_hash",
            "result_hash", "contract_version", "permit_epoch", "outcome",
            "accepted_at",
          ],
          properties: {
            lease_id: { type: "string" },
            job_id: { type: "string" },
            collection_cycle: { type: "integer", minimum: 1 },
            input_hash: { type: "string" },
            result_hash: { type: "string" },
            contract_version: { type: "string" },
            permit_epoch: { type: "string" },
            outcome: { const: "accepted" },
            accepted_at: { type: "string", format: "date-time" },
          },
        },
        UNIFORM_ERROR_SHAPE,
      ],
    },
  },
  abandon_job: {
    scope: MUSTER_MCP_TOOL_SCOPES.abandon_job,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["lease_id", "reason"],
      properties: {
        lease_id: { type: "string" },
        reason: {
          enum: ["before_payload", "after_payload", "platform_failure"],
        },
      },
    },
    outputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["outcome"],
          properties: { outcome: { const: "recorded" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: { const: MUSTER_MCP_ABANDON_REFUSAL_ERROR },
          },
        },
      ],
    },
  },
  extend_lease: {
    scope: MUSTER_MCP_TOOL_SCOPES.extend_lease,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["lease_id"],
      properties: { lease_id: { type: "string" } },
    },
    outputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["new_expiry_bucket_seconds"],
          properties: {
            new_expiry_bucket_seconds: { type: "integer", minimum: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["outcome"],
          properties: { outcome: { const: "refused" } },
        },
      ],
    },
  },
  get_worker_status: {
    scope: MUSTER_MCP_TOOL_SCOPES.get_worker_status,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "contract_version",
        "skill_sha256",
        "cap_usage_bucket",
        "next_slot_bucket",
      ],
      properties: {
        status: {
          enum: ["enrolled", "active", "maintenance", "paused", "suspended"],
        },
        contract_version: { type: "string" },
        skill_sha256: { type: "string" },
        cap_usage_bucket: { type: "integer", minimum: 0, maximum: 3 },
        next_slot_bucket: { type: "integer", minimum: 0 },
      },
    },
  },
  set_availability: {
    scope: MUSTER_MCP_TOOL_SCOPES.set_availability,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["state"],
      properties: { state: { enum: ["active", "maintenance"] } },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
      properties: { outcome: { const: "recorded" } },
    },
  },
} as const);
