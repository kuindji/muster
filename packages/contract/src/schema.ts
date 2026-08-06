import { canonicalize } from "./canonical/jcs.js";
import { hashCanonical } from "./canonical/sha256.js";
import { deepFreeze } from "./deep-freeze.js";
import type { JSONSchema } from "./effect.js";
import { parseJsonPath } from "./jsonpath.js";
import type { CanonicalJsonValue } from "./primitives.js";

export const MUSTER_SCHEMA_DIALECT = "urn:kuindji:muster:schema:1";

export const MUSTER_SCHEMA_TYPES = deepFreeze([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const);

export type MusterSchemaType = (typeof MUSTER_SCHEMA_TYPES)[number];

export const MUSTER_SCHEMA_KEYWORDS = deepFreeze([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "title",
  "description",
] as const);

export type SchemaIssueCode =
  | "schema_not_object"
  | "dialect_missing"
  | "dialect_invalid"
  | "dialect_nested"
  | "unknown_keyword"
  | "type_invalid"
  | "annotation_invalid"
  | "object_not_closed"
  | "properties_invalid"
  | "required_invalid"
  | "required_property_missing"
  | "property_name_invalid"
  | "items_required"
  | "keyword_type_mismatch"
  | "bound_invalid"
  | "bound_order_invalid"
  | "enum_invalid"
  | "enum_type_mismatch"
  | "const_and_enum"
  | "type_mismatch"
  | "required_missing"
  | "additional_property"
  | "enum_mismatch"
  | "const_mismatch"
  | "min_length"
  | "max_length"
  | "minimum"
  | "maximum"
  | "exclusive_minimum"
  | "exclusive_maximum"
  | "min_items"
  | "max_items"
  | "unique_items"
  | "min_properties"
  | "max_properties";

export interface SchemaIssue {
  code: SchemaIssueCode;
  schemaPath: string;
  instancePath: string;
  detail?: string;
}

export interface SchemaValidationResult {
  ok: boolean;
  issues: SchemaIssue[];
}

export class MusterSchemaError extends Error {
  override name = "MusterSchemaError";

  constructor(public readonly issues: readonly SchemaIssue[]) {
    super("invalid Muster Schema 1 definition");
  }
}

const PROPERTY_NAME = /^[A-Za-z0-9_-]+$/;
const KEYWORDS = new Set<string>(MUSTER_SCHEMA_KEYWORDS);
const TYPES = new Set<string>(MUSTER_SCHEMA_TYPES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function sortedIssues(issues: SchemaIssue[]): SchemaIssue[] {
  return issues.sort(
    (left, right) =>
      compareStrings(left.instancePath, right.instancePath) ||
      compareStrings(left.schemaPath, right.schemaPath) ||
      compareStrings(left.code, right.code),
  );
}

function addIssue(
  issues: SchemaIssue[],
  code: SchemaIssueCode,
  schemaPath: string,
  instancePath = "$",
  detail?: string,
): void {
  issues.push({
    code,
    schemaPath,
    instancePath,
    ...(detail === undefined ? {} : { detail }),
  });
}

function schemaTypes(
  value: unknown,
  issues?: SchemaIssue[],
  schemaPath = "$.type",
): MusterSchemaType[] {
  if (typeof value === "string" && TYPES.has(value)) {
    return [value as MusterSchemaType];
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] !== value[1] &&
    value.every((entry) => typeof entry === "string" && TYPES.has(entry)) &&
    value.includes("null")
  ) {
    return value as MusterSchemaType[];
  }
  if (issues !== undefined) {
    addIssue(
      issues,
      "type_invalid",
      schemaPath,
      "$",
      "type must be one type or one non-null type plus null",
    );
  }
  return [];
}

function baseType(types: MusterSchemaType[]): MusterSchemaType | undefined {
  return types.find((type) => type !== "null") ?? types[0];
}

function matchesType(value: unknown, type: MusterSchemaType): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
  }
}

function canonicalIdentity(value: unknown): string | null {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}

function validateNonNegativeIntegerKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  schemaPath: string,
  issues: SchemaIssue[],
): number | undefined {
  const value = schema[keyword];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    addIssue(issues, "bound_invalid", `${schemaPath}.${keyword}`);
    return undefined;
  }
  return value as number;
}

function validateFiniteNumberKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  schemaPath: string,
  issues: SchemaIssue[],
): number | undefined {
  const value = schema[keyword];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(issues, "bound_invalid", `${schemaPath}.${keyword}`);
    return undefined;
  }
  return value;
}

function inspectSchemaNode(
  value: unknown,
  schemaPath: string,
  root: boolean,
  issues: SchemaIssue[],
): void {
  if (!isRecord(value)) {
    addIssue(issues, "schema_not_object", schemaPath);
    return;
  }

  for (const keyword of Object.keys(value).sort(compareStrings)) {
    if (!KEYWORDS.has(keyword)) {
      addIssue(issues, "unknown_keyword", `${schemaPath}.${keyword}`);
    }
  }

  if (root) {
    if (value.$schema === undefined) {
      addIssue(issues, "dialect_missing", `${schemaPath}.$schema`);
    } else if (value.$schema !== MUSTER_SCHEMA_DIALECT) {
      addIssue(issues, "dialect_invalid", `${schemaPath}.$schema`);
    }
  } else if (value.$schema !== undefined) {
    addIssue(issues, "dialect_nested", `${schemaPath}.$schema`);
  }

  for (const annotation of ["title", "description"] as const) {
    if (value[annotation] !== undefined && typeof value[annotation] !== "string") {
      addIssue(issues, "annotation_invalid", `${schemaPath}.${annotation}`);
    }
  }

  const types = schemaTypes(value.type, issues, `${schemaPath}.type`);
  const type = baseType(types);

  if (value.enum !== undefined && value.const !== undefined) {
    addIssue(issues, "const_and_enum", schemaPath);
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      addIssue(issues, "enum_invalid", `${schemaPath}.enum`);
    } else {
      const identities = value.enum.map(canonicalIdentity);
      if (
        identities.some((identity) => identity === null) ||
        new Set(identities).size !== identities.length
      ) {
        addIssue(issues, "enum_invalid", `${schemaPath}.enum`);
      }
      if (
        types.length > 0 &&
        value.enum.some((entry) => !types.some((entryType) => matchesType(entry, entryType)))
      ) {
        addIssue(issues, "enum_type_mismatch", `${schemaPath}.enum`);
      }
    }
  }
  if (
    value.const !== undefined &&
    types.length > 0 &&
    !types.some((entryType) => matchesType(value.const, entryType))
  ) {
    addIssue(issues, "enum_type_mismatch", `${schemaPath}.const`);
  }

  const keywordsByType: Record<string, MusterSchemaType[]> = {
    properties: ["object"], required: ["object"], additionalProperties: ["object"],
    minProperties: ["object"], maxProperties: ["object"],
    items: ["array"], minItems: ["array"], maxItems: ["array"], uniqueItems: ["array"],
    minLength: ["string"], maxLength: ["string"],
    minimum: ["number", "integer"], maximum: ["number", "integer"],
    exclusiveMinimum: ["number", "integer"], exclusiveMaximum: ["number", "integer"],
  };
  for (const [keyword, allowedTypes] of Object.entries(keywordsByType)) {
    if (value[keyword] !== undefined && (type === undefined || !allowedTypes.includes(type))) {
      addIssue(issues, "keyword_type_mismatch", `${schemaPath}.${keyword}`);
    }
  }

  if (type === "object") {
    if (value.additionalProperties !== false) {
      addIssue(issues, "object_not_closed", `${schemaPath}.additionalProperties`);
    }
    const properties = value.properties;
    if (!isRecord(properties)) {
      addIssue(issues, "properties_invalid", `${schemaPath}.properties`);
    } else {
      for (const name of Object.keys(properties).sort(compareStrings)) {
        if (!PROPERTY_NAME.test(name)) {
          addIssue(
            issues,
            "property_name_invalid",
            `${schemaPath}.properties.${name}`,
          );
        }
        inspectSchemaNode(
          properties[name],
          `${schemaPath}.properties.${name}`,
          false,
          issues,
        );
      }
    }
    if (value.required !== undefined) {
      if (
        !Array.isArray(value.required) ||
        value.required.some((entry) => typeof entry !== "string") ||
        new Set(value.required).size !== value.required.length
      ) {
        addIssue(issues, "required_invalid", `${schemaPath}.required`);
      } else if (isRecord(properties)) {
        for (const name of value.required) {
          if (!Object.hasOwn(properties, name as string)) {
            addIssue(
              issues,
              "required_property_missing",
              `${schemaPath}.required`,
              "$",
              String(name),
            );
          }
        }
      }
    }
    const min = validateNonNegativeIntegerKeyword(value, "minProperties", schemaPath, issues);
    const max = validateNonNegativeIntegerKeyword(value, "maxProperties", schemaPath, issues);
    if (min !== undefined && max !== undefined && min > max) {
      addIssue(issues, "bound_order_invalid", schemaPath);
    }
  } else if (type === "array") {
    if (!isRecord(value.items)) {
      addIssue(issues, "items_required", `${schemaPath}.items`);
    } else {
      inspectSchemaNode(value.items, `${schemaPath}.items`, false, issues);
    }
    if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean") {
      addIssue(issues, "bound_invalid", `${schemaPath}.uniqueItems`);
    }
    const min = validateNonNegativeIntegerKeyword(value, "minItems", schemaPath, issues);
    const max = validateNonNegativeIntegerKeyword(value, "maxItems", schemaPath, issues);
    if (min !== undefined && max !== undefined && min > max) {
      addIssue(issues, "bound_order_invalid", schemaPath);
    }
  } else if (type === "string") {
    const min = validateNonNegativeIntegerKeyword(value, "minLength", schemaPath, issues);
    const max = validateNonNegativeIntegerKeyword(value, "maxLength", schemaPath, issues);
    if (min !== undefined && max !== undefined && min > max) {
      addIssue(issues, "bound_order_invalid", schemaPath);
    }
  } else if (type === "number" || type === "integer") {
    const minimum = validateFiniteNumberKeyword(value, "minimum", schemaPath, issues);
    const maximum = validateFiniteNumberKeyword(value, "maximum", schemaPath, issues);
    const exclusiveMinimum = validateFiniteNumberKeyword(value, "exclusiveMinimum", schemaPath, issues);
    const exclusiveMaximum = validateFiniteNumberKeyword(value, "exclusiveMaximum", schemaPath, issues);
    const lowerCandidates = [
      ...(minimum === undefined ? [] : [{ value: minimum, exclusive: false }]),
      ...(exclusiveMinimum === undefined
        ? []
        : [{ value: exclusiveMinimum, exclusive: true }]),
    ];
    const upperCandidates = [
      ...(maximum === undefined ? [] : [{ value: maximum, exclusive: false }]),
      ...(exclusiveMaximum === undefined
        ? []
        : [{ value: exclusiveMaximum, exclusive: true }]),
    ];
    const lower = lowerCandidates.reduce<
      { value: number; exclusive: boolean } | undefined
    >(
      (selected, candidate) =>
        selected === undefined || candidate.value > selected.value
          ? candidate
          : candidate.value === selected.value
            ? {
                value: selected.value,
                exclusive: selected.exclusive || candidate.exclusive,
              }
            : selected,
      undefined,
    );
    const upper = upperCandidates.reduce<
      { value: number; exclusive: boolean } | undefined
    >(
      (selected, candidate) =>
        selected === undefined || candidate.value < selected.value
          ? candidate
          : candidate.value === selected.value
            ? {
                value: selected.value,
                exclusive: selected.exclusive || candidate.exclusive,
              }
            : selected,
      undefined,
    );
    if (
      lower !== undefined &&
      upper !== undefined &&
      (lower.value > upper.value ||
        (lower.value === upper.value && (lower.exclusive || upper.exclusive)))
    ) {
      addIssue(issues, "bound_order_invalid", schemaPath);
    }
  }
}

export function validateMusterSchema(schema: JSONSchema): SchemaValidationResult {
  const issues: SchemaIssue[] = [];
  inspectSchemaNode(schema, "$", true, issues);
  sortedIssues(issues);
  return { ok: issues.length === 0, issues };
}

/** Schema identity persisted at class-version registration. */
export async function computeMusterSchemaHash(
  schema: JSONSchema,
): Promise<string> {
  const validation = validateMusterSchema(schema);
  if (!validation.ok) throw new MusterSchemaError(validation.issues);
  return hashCanonical(schema);
}

function validateValueNode(
  schema: Record<string, unknown>,
  value: unknown,
  schemaPath: string,
  instancePath: string,
  issues: SchemaIssue[],
): void {
  const types = schemaTypes(schema.type);
  if (!types.some((type) => matchesType(value, type))) {
    addIssue(issues, "type_mismatch", `${schemaPath}.type`, instancePath);
    return;
  }

  const identity = canonicalIdentity(value);
  if (schema.const !== undefined && identity !== canonicalIdentity(schema.const)) {
    addIssue(issues, "const_mismatch", `${schemaPath}.const`, instancePath);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => canonicalIdentity(entry) === identity)
  ) {
    addIssue(issues, "enum_mismatch", `${schemaPath}.enum`, instancePath);
  }

  if (value === null) return;
  const type = baseType(types);
  if (type === "object" && isRecord(value)) {
    const properties = schema.properties as Record<string, JSONSchema>;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const name of required) {
      if (!Object.hasOwn(value, name)) {
        addIssue(
          issues,
          "required_missing",
          `${schemaPath}.required`,
          instancePath,
          name,
        );
      }
    }
    for (const name of Object.keys(value).sort(compareStrings)) {
      const childPath = `${instancePath}.${name}`;
      if (!Object.hasOwn(properties, name)) {
        addIssue(
          issues,
          "additional_property",
          `${schemaPath}.additionalProperties`,
          childPath,
        );
      } else {
        validateValueNode(
          properties[name] as Record<string, unknown>,
          value[name],
          `${schemaPath}.properties.${name}`,
          childPath,
          issues,
        );
      }
    }
    const count = Object.keys(value).length;
    if (typeof schema.minProperties === "number" && count < schema.minProperties) {
      addIssue(issues, "min_properties", `${schemaPath}.minProperties`, instancePath);
    }
    if (typeof schema.maxProperties === "number" && count > schema.maxProperties) {
      addIssue(issues, "max_properties", `${schemaPath}.maxProperties`, instancePath);
    }
  } else if (type === "array" && Array.isArray(value)) {
    const itemSchema = schema.items as Record<string, unknown>;
    for (let index = 0; index < value.length; index += 1) {
      validateValueNode(
        itemSchema,
        value[index],
        `${schemaPath}.items`,
        `${instancePath}[${index}]`,
        issues,
      );
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      addIssue(issues, "min_items", `${schemaPath}.minItems`, instancePath);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      addIssue(issues, "max_items", `${schemaPath}.maxItems`, instancePath);
    }
    if (schema.uniqueItems === true) {
      const identities = value.map(canonicalIdentity);
      if (new Set(identities).size !== identities.length) {
        addIssue(issues, "unique_items", `${schemaPath}.uniqueItems`, instancePath);
      }
    }
  } else if (type === "string" && typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      addIssue(issues, "min_length", `${schemaPath}.minLength`, instancePath);
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      addIssue(issues, "max_length", `${schemaPath}.maxLength`, instancePath);
    }
  } else if ((type === "number" || type === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      addIssue(issues, "minimum", `${schemaPath}.minimum`, instancePath);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      addIssue(issues, "maximum", `${schemaPath}.maximum`, instancePath);
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      addIssue(issues, "exclusive_minimum", `${schemaPath}.exclusiveMinimum`, instancePath);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      addIssue(issues, "exclusive_maximum", `${schemaPath}.exclusiveMaximum`, instancePath);
    }
  }
}

export function validateMusterValue(
  schema: JSONSchema,
  value: unknown,
): SchemaValidationResult {
  const schemaResult = validateMusterSchema(schema);
  if (!schemaResult.ok) return schemaResult;
  const issues: SchemaIssue[] = [];
  validateValueNode(schema, value, "$", "$", issues);
  sortedIssues(issues);
  return { ok: issues.length === 0, issues };
}

function schemaAtPath(
  schema: JSONSchema,
  path: string,
): Record<string, unknown> | null {
  let current: Record<string, unknown> = schema;
  for (const segment of parseJsonPath(path)) {
    const type = baseType(schemaTypes(current.type));
    if (segment === "[*]") {
      if (type !== "array" || !isRecord(current.items)) return null;
      current = current.items;
    } else {
      if (type !== "object" || !isRecord(current.properties)) return null;
      const next = current.properties[segment];
      if (!isRecord(next)) return null;
      current = next;
    }
  }
  return current;
}

export function schemaDeclaresPath(schema: JSONSchema, path: string): boolean {
  if (!validateMusterSchema(schema).ok) return false;
  try {
    return schemaAtPath(schema, path) !== null;
  } catch {
    return false;
  }
}

function collectLeafPaths(
  schema: Record<string, unknown>,
  path: string,
  output: string[],
): void {
  const type = baseType(schemaTypes(schema.type));
  if (type === "object" && isRecord(schema.properties)) {
    const names = Object.keys(schema.properties).sort(compareStrings);
    for (const name of names) {
      const child = schema.properties[name];
      if (isRecord(child)) collectLeafPaths(child, `${path}.${name}`, output);
    }
    return;
  }
  if (type === "array" && isRecord(schema.items)) {
    collectLeafPaths(schema.items, `${path}[*]`, output);
    return;
  }
  output.push(path);
}

export function schemaLeafPaths(schema: JSONSchema): string[] {
  if (!validateMusterSchema(schema).ok) return [];
  const paths: string[] = [];
  collectLeafPaths(schema, "$", paths);
  return paths.sort(compareStrings);
}
