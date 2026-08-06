import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JSONSchema } from "../src/effect.js";
import {
  MUSTER_SCHEMA_DIALECT,
  MusterSchemaError,
  computeMusterSchemaHash,
  schemaDeclaresPath,
  schemaLeafPaths,
  validateMusterSchema,
  validateMusterValue,
} from "../src/schema.js";

interface SchemaCase {
  id: string;
  valid: boolean;
  issueCode?: string;
  schemaHash?: string;
  schema: JSONSchema;
}

interface ValueCase {
  id: string;
  schemaId: string;
  value: unknown;
  valid: boolean;
  issueCode?: string;
}

interface FixturePack {
  version: 1;
  schemas: SchemaCase[];
  values: ValueCase[];
  paths: Array<{ schemaId: string; path: string; declared: boolean }>;
  leafPaths: Array<{ schemaId: string; paths: string[] }>;
}

const fixtures: FixturePack = JSON.parse(
  readFileSync(
    new URL("../fixtures/schema-conformance.json", import.meta.url),
    "utf8",
  ),
);
const schemas = new Map(fixtures.schemas.map((entry) => [entry.id, entry]));

describe("Muster Schema 1", () => {
  it("has a closed, internally consistent fixture pack", () => {
    expect(fixtures.version).toBe(1);
    expect(new Set(fixtures.schemas.map((entry) => entry.id)).size)
      .toBe(fixtures.schemas.length);
    expect(new Set(fixtures.values.map((entry) => entry.id)).size)
      .toBe(fixtures.values.length);
    for (const entry of fixtures.schemas) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.valid
          ? entry.schemaHash === undefined
            ? ["id", "schema", "valid"]
            : ["id", "schema", "schemaHash", "valid"]
          : ["id", "issueCode", "schema", "valid"],
      );
    }
    for (const entry of [...fixtures.values, ...fixtures.paths, ...fixtures.leafPaths]) {
      expect(schemas.has(entry.schemaId), entry.schemaId).toBe(true);
    }
  });

  it("uses the revision-13 dialect URI", () => {
    expect(MUSTER_SCHEMA_DIALECT).toBe("urn:kuindji:muster:schema:1");
  });

  it("accepts and rejects the frozen schema fixtures", () => {
    for (const fixture of fixtures.schemas) {
      const result = validateMusterSchema(fixture.schema);
      expect(result.ok, fixture.id).toBe(fixture.valid);
      if (!fixture.valid) {
        expect(result.issues.map((issue) => issue.code), fixture.id)
          .toContain(fixture.issueCode);
      }
    }
  });

  it("validates values with deterministic typed issues", () => {
    for (const fixture of fixtures.values) {
      const schema = schemas.get(fixture.schemaId);
      expect(schema, fixture.schemaId).toBeDefined();
      const result = validateMusterValue(schema!.schema, fixture.value);
      expect(result.ok, fixture.id).toBe(fixture.valid);
      if (!fixture.valid) {
        expect(result.issues.map((issue) => issue.code), fixture.id)
          .toContain(fixture.issueCode);
      }
      const sorted = [...result.issues].sort((left, right) =>
        left.instancePath.localeCompare(right.instancePath) ||
        left.schemaPath.localeCompare(right.schemaPath) ||
        left.code.localeCompare(right.code)
      );
      expect(result.issues, `${fixture.id} issue ordering`).toEqual(sorted);
    }
  });

  it("walks only paths declared by the closed schema", () => {
    for (const fixture of fixtures.paths) {
      const schema = schemas.get(fixture.schemaId)!;
      expect(schemaDeclaresPath(schema.schema, fixture.path), fixture.path)
        .toBe(fixture.declared);
    }
    for (const fixture of fixtures.leafPaths) {
      const schema = schemas.get(fixture.schemaId)!;
      expect(schemaLeafPaths(schema.schema)).toEqual(fixture.paths);
    }
  });

  it("pins schema identity to SHA-256(JCS(schema)) after validation", async () => {
    const fixture = schemas.get("closed-nested-object")!;
    const original = fixture.schema;
    const reordered = {
      additionalProperties: false,
      required: ["name"],
      properties: original.properties!,
      type: "object",
      $schema: MUSTER_SCHEMA_DIALECT,
    };
    expect(await computeMusterSchemaHash(reordered)).toBe(
      await computeMusterSchemaHash(original),
    );
    expect(await computeMusterSchemaHash(original)).toBe(fixture.schemaHash);
    await expect(computeMusterSchemaHash({
      $schema: MUSTER_SCHEMA_DIALECT,
      type: "object",
      properties: {},
      additionalProperties: true,
    })).rejects.toBeInstanceOf(MusterSchemaError);
  });

  it("rejects a wrong or nested dialect declaration", () => {
    const wrong = validateMusterSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.map((issue) => issue.code))
      .toContain("dialect_invalid");

    const nested = validateMusterSchema({
      $schema: MUSTER_SCHEMA_DIALECT,
      type: "array",
      items: { $schema: MUSTER_SCHEMA_DIALECT, type: "string" },
    });
    expect(nested.ok).toBe(false);
    expect(nested.issues.map((issue) => issue.code))
      .toContain("dialect_nested");
  });

  it("rejects empty numeric intervals with an exclusive boundary", () => {
    const result = validateMusterSchema({
      $schema: MUSTER_SCHEMA_DIALECT,
      type: "number",
      minimum: 1,
      exclusiveMaximum: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code))
      .toContain("bound_order_invalid");

    const crossed = validateMusterSchema({
      $schema: MUSTER_SCHEMA_DIALECT,
      type: "number",
      minimum: 2,
      exclusiveMinimum: 1,
      maximum: 1.5,
    });
    expect(crossed.ok).toBe(false);
    expect(crossed.issues.map((issue) => issue.code))
      .toContain("bound_order_invalid");
  });
});
