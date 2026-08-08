import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_SCHEMA,
  NO_WORK_SHAPE,
  TOOL_SCHEMAS,
  UNIFORM_ERROR_SHAPE,
} from "../src/mcp-schemas.js";

describe("tool surface (spec 5.2)", () => {
  it("exposes exactly the six tools with their scopes", () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([
      "abandon_job", "extend_lease", "get_worker_status", "lease_job",
      "set_availability", "submit_result",
    ]);
    expect(TOOL_SCHEMAS.lease_job.scope).toBe("muster:jobs");
    expect(TOOL_SCHEMAS.submit_result.scope).toBe("muster:jobs");
    expect(TOOL_SCHEMAS.abandon_job.scope).toBe("muster:jobs");
    expect(TOOL_SCHEMAS.extend_lease.scope).toBe("muster:jobs");
    expect(TOOL_SCHEMAS.get_worker_status.scope).toBe("muster:worker");
    expect(TOOL_SCHEMAS.set_availability.scope).toBe("muster:worker");
  });

  it("every input schema is closed", () => {
    for (const tool of Object.values(TOOL_SCHEMAS)) {
      expect(
        (tool.inputSchema as { additionalProperties: boolean })
          .additionalProperties,
      ).toBe(false);
    }
  });
});

describe("availability (spec 5.2/5.7)", () => {
  it("is a closed one-field schema: budget_bucket 0-3", () => {
    expect(AVAILABILITY_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["budget_bucket"],
      properties: {
        budget_bucket: { type: "integer", minimum: 0, maximum: 3 },
      },
    });
  });
});

describe("coarse wire shapes (spec 5.7)", () => {
  it("no_work carries no reason on the wire", () => {
    expect(NO_WORK_SHAPE).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
      properties: { outcome: { const: "no_work" } },
    });
  });

  it("errors are uniform: code only, no detail", () => {
    expect(
      Object.keys(
        (UNIFORM_ERROR_SHAPE as { properties: object }).properties,
      ),
    ).toEqual(["error"]);
  });

  it("get_worker_status exposes skill hash, not a Resource URI (spec 5.3)", () => {
    const properties = (
      TOOL_SCHEMAS.get_worker_status.outputSchema as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(Object.keys(properties).sort()).toEqual([
      "cap_usage_bucket", "contract_version", "next_slot_bucket",
      "skill_sha256", "status",
    ]);
    expect(properties.next_slot_bucket).toEqual({ type: "integer", minimum: 0 });
  });
});
