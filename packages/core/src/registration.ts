import {
  ACTION_GATE_TABLE,
  ACTION_ORDER,
  AXIS_CONFIDENCE,
  CONSEQUENCE_ORDER,
  TTL_BUCKETS_SECONDS,
  absenceDomainCovers,
  bucketFor,
  canonicalize,
  computeMusterSchemaHash,
  deepFreeze,
  effectiveGateAction,
  isAgreementFixtureShape,
  isJsonPath,
  isOracleNegativeFixtureShape,
  isWireId,
  pathsCover,
  schemaDeclaresPath,
  schemaLeafPaths,
  validateMusterSchema,
  validateMusterValue,
} from "@kuindji/muster-contract";
import type {
  Action,
  ActionEvidenceRequirement,
  ActionPermit,
  CanonicalJsonValue,
  ClassHealth,
  JobClass,
  JSONSchema,
  OracleSpec,
  Timestamp,
} from "@kuindji/muster-contract";

import type {
  ClassHealthSnapshot,
  ClassVersionRecord,
  Clock,
  CoreDeploymentPolicy,
  Store,
} from "./ports.js";

export type RegistrationIssueCode =
  | "identity_invalid"
  | "duplicate_id"
  | "schema_invalid"
  | "size_limit_invalid"
  | "path_invalid"
  | "path_not_declared"
  | "replication_invalid"
  | "diversity_invalid"
  | "lease_policy_invalid"
  | "reserve_invalid"
  | "adjudication_invalid"
  | "oracle_invalid"
  | "oracle_coverage_missing"
  | "oracle_fixture_invalid"
  | "oracle_fixture_did_not_fail"
  | "agreement_invalid"
  | "agreement_fixture_invalid"
  | "agreement_fixture_mismatch"
  | "permit_invalid"
  | "requirement_invalid"
  | "effect_fixture_invalid"
  | "consumer_function_threw"
  | "durable_schema_conflict";

export interface RegistrationIssue {
  readonly code: RegistrationIssueCode;
  readonly path: string;
  readonly detail?: string;
}

export interface RuntimeClassEntry<Payload = unknown, Result = unknown> {
  readonly jobClass: JobClass<Payload, Result>;
  readonly payloadSchemaHash: string;
  readonly outputSchemaHash: string;
}

export type RuntimeCompatibility =
  | { readonly ok: true; readonly entry: RuntimeClassEntry }
  | {
      readonly ok: false;
      readonly reason: "not_loaded" | "not_registered" | "schema_mismatch";
    };

const pairKey = (classId: string, contractVersion: string): string =>
  `${classId.length}:${classId}${contractVersion}`;

/** In-process function registry. Durable state stores only frozen identities. */
export class RuntimeClassRegistry {
  private readonly entries = new Map<string, RuntimeClassEntry>();

  get(
    classId: string,
    contractVersion: string,
  ): RuntimeClassEntry | null {
    return this.entries.get(pairKey(classId, contractVersion)) ?? null;
  }

  load<Payload, Result>(
    entry: RuntimeClassEntry<Payload, Result>,
  ): RuntimeClassEntry<Payload, Result> {
    const key = pairKey(entry.jobClass.id, entry.jobClass.contractVersion);
    const current = this.entries.get(key);
    if (
      current !== undefined &&
      (current.payloadSchemaHash !== entry.payloadSchemaHash ||
        current.outputSchemaHash !== entry.outputSchemaHash)
    ) {
      throw new Error("runtime class schema identity conflict");
    }
    if (current === undefined) {
      const loaded = deepFreeze(entry);
      this.entries.set(key, loaded as RuntimeClassEntry);
      return loaded;
    }
    return current as RuntimeClassEntry<Payload, Result>;
  }

  async compatibility(
    store: Store,
    classId: string,
    contractVersion: string,
  ): Promise<RuntimeCompatibility> {
    const entry = this.get(classId, contractVersion);
    if (entry === null) return { ok: false, reason: "not_loaded" };
    const durable = await store.getClassVersion(classId, contractVersion);
    if (durable === null) return { ok: false, reason: "not_registered" };
    if (
      durable.payloadSchemaHash !== entry.payloadSchemaHash ||
      durable.outputSchemaHash !== entry.outputSchemaHash
    ) {
      return { ok: false, reason: "schema_mismatch" };
    }
    return { ok: true, entry };
  }

  clear(): void {
    this.entries.clear();
  }
}

export type ClassRegistrationResult =
  | {
      readonly ok: true;
      readonly kind: "registered" | "replayed";
      readonly record: ClassVersionRecord;
      readonly health: ClassHealthSnapshot;
      readonly entry: RuntimeClassEntry;
    }
  | {
      readonly ok: false;
      readonly kind: "invalid" | "conflict";
      readonly issues: readonly RegistrationIssue[];
    };

const READY_HEALTH: ClassHealth = {
  operating: "ready",
  reserves: {
    lowCost: "available",
    urgent: "available",
    splitAndAdjudication: "available",
    audit: "available",
  },
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedIssues = (issues: RegistrationIssue[]): RegistrationIssue[] =>
  issues.sort(
    (left, right) =>
      compare(left.path, right.path) ||
      compare(left.code, right.code) ||
      compare(left.detail ?? "", right.detail ?? ""),
  );

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const finitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const nonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const positiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

const issue = (
  issues: RegistrationIssue[],
  code: RegistrationIssueCode,
  path: string,
  detail?: string,
): void => {
  issues.push({ code, path, ...(detail === undefined ? {} : { detail }) });
};

function validatePaths(
  issues: RegistrationIssue[],
  schema: JSONSchema,
  paths: readonly string[],
  path: string,
): boolean {
  let valid = true;
  const seen = new Set<string>();
  paths.forEach((candidate, index) => {
    const candidatePath = `${path}[${index}]`;
    if (typeof candidate !== "string" || !isJsonPath(candidate)) {
      issue(issues, "path_invalid", candidatePath);
      valid = false;
    } else if (seen.has(candidate)) {
      issue(issues, "duplicate_id", candidatePath, candidate);
      valid = false;
    } else if (!schemaDeclaresPath(schema, candidate)) {
      issue(issues, "path_not_declared", candidatePath, candidate);
      valid = false;
    }
    seen.add(candidate);
  });
  return valid;
}

function validateRequirement(
  issues: RegistrationIssue[],
  requirement: {
    predicate: string;
    requiredPayloadPaths: readonly string[];
    requiredResultPaths: readonly string[];
  },
  path: string,
  payloadSchema: JSONSchema,
  outputSchema: JSONSchema,
): boolean {
  let valid = true;
  if (typeof requirement?.predicate !== "string" || requirement.predicate.length === 0) {
    issue(issues, "requirement_invalid", `${path}.predicate`);
    valid = false;
  }
  if (!Array.isArray(requirement?.requiredPayloadPaths)) {
    issue(issues, "requirement_invalid", `${path}.requiredPayloadPaths`);
    valid = false;
  } else {
    valid = validatePaths(
      issues,
      payloadSchema,
      requirement.requiredPayloadPaths,
      `${path}.requiredPayloadPaths`,
    ) && valid;
  }
  if (!Array.isArray(requirement?.requiredResultPaths)) {
    issue(issues, "requirement_invalid", `${path}.requiredResultPaths`);
    valid = false;
  } else {
    valid = validatePaths(
      issues,
      outputSchema,
      requirement.requiredResultPaths,
      `${path}.requiredResultPaths`,
    ) && valid;
  }
  return valid;
}

function requirementCovered(
  requirement: {
    predicate: string;
    requiredPayloadPaths: readonly string[];
    requiredResultPaths: readonly string[];
  },
  oracles: readonly OracleSpec<unknown, unknown>[],
  kind?: "support" | "completeness",
): boolean {
  try {
    return oracles.some((oracle) =>
      (kind === undefined || oracle.kind === kind) &&
      oracle.predicates.includes(requirement.predicate) &&
      pathsCover(oracle.coversPayloadPaths, requirement.requiredPayloadPaths) &&
      pathsCover(oracle.coversResultPaths, requirement.requiredResultPaths)
    );
  } catch {
    return false;
  }
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function mergeProjection(left: unknown, right: unknown): unknown {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.map((entry, index) => mergeProjection(entry, right[index]));
  }
  if (
    typeof left === "object" && left !== null && !Array.isArray(left) &&
    typeof right === "object" && right !== null && !Array.isArray(right)
  ) {
    const merged: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      merged[key] = mergeProjection(merged[key], value);
    }
    return merged;
  }
  return right;
}

function selectProjection(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return cloneCanonical(value);
  const [head, ...tail] = segments;
  if (head === "[*]") {
    if (!Array.isArray(value)) return undefined;
    return value.map((entry) => selectProjection(entry, tail));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (head === undefined || !Object.hasOwn(record, head)) return undefined;
  return { [head]: selectProjection(record[head], tail) };
}

function parseProjectionPath(path: string): string[] {
  const segments: string[] = [];
  let rest = path.slice(1);
  while (rest.length > 0) {
    if (rest.startsWith("[*]")) {
      segments.push("[*]");
      rest = rest.slice(3);
    } else {
      const match = /^\.([A-Za-z0-9_-]+)/.exec(rest);
      if (match === null) throw new Error(`invalid projection path: ${path}`);
      segments.push(match[1]!);
      rest = rest.slice(match[0].length);
    }
  }
  return segments;
}

function project(value: CanonicalJsonValue, paths: readonly string[]): CanonicalJsonValue {
  let selected: unknown;
  for (const path of paths) {
    selected = mergeProjection(
      selected,
      selectProjection(value, parseProjectionPath(path)),
    );
  }
  return cloneCanonical((selected ?? {}) as CanonicalJsonValue);
}

const HUMAN_ABSENCE_ACTIONS = new Set<Action>([
  "updateRetrievalIndex",
  "selectCandidateSet",
  "enqueueDerivedWork",
  "suppress",
  "drop",
]);

function humanNeedsAbsence(action: Action, jobClass: JobClass<unknown, unknown>): boolean {
  return HUMAN_ABSENCE_ACTIONS.has(action) ||
    (action === "deprioritize" && jobClass.surface === "bounded");
}

function validateBasicPolicy(
  jobClass: JobClass<unknown, unknown>,
  deployment: CoreDeploymentPolicy,
  issues: RegistrationIssue[],
): void {
  if (!isWireId(jobClass.id)) issue(issues, "identity_invalid", "$.id");
  if (!isWireId(jobClass.contractVersion)) {
    issue(issues, "identity_invalid", "$.contractVersion");
  }
  if (!positiveInteger(jobClass.maxPayloadBytes)) {
    issue(issues, "size_limit_invalid", "$.maxPayloadBytes");
  }
  if (!positiveInteger(jobClass.maxResultBytes)) {
    issue(issues, "size_limit_invalid", "$.maxResultBytes");
  }
  if (!positiveInteger(jobClass.replication.target)) {
    issue(issues, "replication_invalid", "$.replication.target");
  }
  if (!nonNegativeInteger(jobClass.replication.maxSplitEvidenceReroutes)) {
    issue(issues, "replication_invalid", "$.replication.maxSplitEvidenceReroutes");
  }
  if (jobClass.replication.target > 1 && jobClass.agreement === undefined) {
    issue(issues, "replication_invalid", "$.agreement", "required for replicated classes");
  }
  if (
    jobClass.replication.target === 1 &&
    jobClass.replication.maxSplitEvidenceReroutes !== 0
  ) {
    issue(issues, "replication_invalid", "$.replication.maxSplitEvidenceReroutes");
  }

  if (jobClass.diversity !== undefined) {
    const { axes, minDistinct } = jobClass.diversity;
    if (!Array.isArray(axes) || axes.length === 0 || new Set(axes).size !== axes.length) {
      issue(issues, "diversity_invalid", "$.diversity.axes");
    } else {
      axes.forEach((axis, index) => {
        const confidence = AXIS_CONFIDENCE[axis];
        if (confidence !== "attested" && confidence !== "observed") {
          issue(issues, "diversity_invalid", `$.diversity.axes[${index}]`, String(axis));
        }
      });
    }
    if (!positiveInteger(minDistinct) || minDistinct < 2 || minDistinct > jobClass.replication.target) {
      issue(issues, "diversity_invalid", "$.diversity.minDistinct");
    }
  }

  if (!finitePositive(jobClass.cost.maxLeaseTtl)) {
    issue(issues, "lease_policy_invalid", "$.cost.maxLeaseTtl");
  }
  if (!finitePositive(jobClass.cost.maxInFlightLifetime)) {
    issue(issues, "lease_policy_invalid", "$.cost.maxInFlightLifetime");
  }
  if (!isWireId(deployment.version)) {
    issue(issues, "lease_policy_invalid", "$.deploymentPolicy.version");
  }
  if (!finitePositive(deployment.extensionTtl)) {
    issue(issues, "lease_policy_invalid", "$.deploymentPolicy.extensionTtl");
  }
  if (!nonNegativeInteger(deployment.maxExtensionsPerLease)) {
    issue(issues, "lease_policy_invalid", "$.deploymentPolicy.maxExtensionsPerLease");
  }
  if (finitePositive(jobClass.cost.maxLeaseTtl)) {
    const quantized = bucketFor(jobClass.cost.maxLeaseTtl, TTL_BUCKETS_SECONDS);
    if (quantized === null) {
      issue(issues, "lease_policy_invalid", "$.cost.maxLeaseTtl", "no TTL bucket");
    } else if (
      finitePositive(deployment.extensionTtl) &&
      nonNegativeInteger(deployment.maxExtensionsPerLease) &&
      quantized + deployment.extensionTtl * deployment.maxExtensionsPerLease >=
        jobClass.cost.maxInFlightLifetime
    ) {
      issue(issues, "lease_policy_invalid", "$.cost.maxInFlightLifetime", "strict bound violated");
    }
  }

  const reserveEntries = Object.entries(jobClass.escalation);
  for (const [name, value] of reserveEntries) {
    if (!finiteNonNegative(value)) {
      issue(issues, "reserve_invalid", `$.escalation.${name}`);
    }
  }
  if (
    finiteNonNegative(jobClass.escalation.auditPerWeek) &&
    finiteNonNegative(jobClass.escalation.retrospectiveAuditProjectionPerWeek) &&
    jobClass.escalation.auditPerWeek <
      jobClass.escalation.retrospectiveAuditProjectionPerWeek
  ) {
    issue(issues, "reserve_invalid", "$.escalation.auditPerWeek", "below retrospective projection");
  }

  const requiresAdjudication =
    jobClass.replication.target > 1 ||
    jobClass.diversity !== undefined ||
    jobClass.permits.some((permit) =>
      permit.mode === "human_only" ||
      ["routeToHumanLowCost", "routeToHumanUrgent", "routeToUrgent"].includes(permit.action)
    );
  if (requiresAdjudication && jobClass.adjudication === undefined) {
    issue(issues, "adjudication_invalid", "$.adjudication", "required by class policy");
  }
  if (jobClass.adjudication !== undefined) {
    const policy = jobClass.adjudication;
    if (!finiteNonNegative(policy.requiredRatePerWeek)) {
      issue(issues, "adjudication_invalid", "$.adjudication.requiredRatePerWeek");
    }
    if (!finitePositive(policy.starvationDwell)) {
      issue(issues, "adjudication_invalid", "$.adjudication.starvationDwell");
    }
    if (!finitePositive(policy.capacityMaxAge)) {
      issue(issues, "adjudication_invalid", "$.adjudication.capacityMaxAge");
    }
    if (!finiteNonNegative(policy.restoreAbovePerWeek) ||
      policy.restoreAbovePerWeek <= policy.requiredRatePerWeek) {
      issue(issues, "adjudication_invalid", "$.adjudication.restoreAbovePerWeek");
    }
    if (!nonNegativeInteger(policy.maxRejectedDisputeRequeues)) {
      issue(issues, "adjudication_invalid", "$.adjudication.maxRejectedDisputeRequeues");
    }
    const requiredFloor = jobClass.escalation.lowCostPerWeek +
      jobClass.escalation.urgentPerWeek +
      jobClass.escalation.splitAndAdjudicationPerWeek;
    if (Number.isFinite(requiredFloor) && policy.requiredRatePerWeek < requiredFloor) {
      issue(issues, "adjudication_invalid", "$.adjudication.requiredRatePerWeek", "below reserve floor");
    }
  }
}

function validateOracles(
  jobClass: JobClass<unknown, unknown>,
  schemasValid: boolean,
  issues: RegistrationIssue[],
): void {
  const functionIds = new Set<string>();
  const boundPredicates = {
    support: new Set<string>([
      ...(jobClass.resultEvidenceRequirement === undefined
        ? []
        : [jobClass.resultEvidenceRequirement.predicate]),
      ...jobClass.evidenceRequirements.map((entry) => entry.predicate),
    ]),
    completeness: new Set<string>(
      jobClass.absenceRequirements.map((entry) => entry.predicate),
    ),
  };
  const declaredPredicates = new Map<string, "support" | "completeness">();
  jobClass.validators.forEach((validator, index) => {
    if (!isWireId(validator.id) || functionIds.has(validator.id)) {
      issue(issues, functionIds.has(validator.id) ? "duplicate_id" : "identity_invalid", `$.validators[${index}].id`);
    }
    functionIds.add(validator.id);
  });

  jobClass.oracles.forEach((oracle, oracleIndex) => {
    const path = `$.oracles[${oracleIndex}]`;
    if (!isWireId(oracle.id) || functionIds.has(oracle.id)) {
      issue(issues, functionIds.has(oracle.id) ? "duplicate_id" : "identity_invalid", `${path}.id`);
    }
    functionIds.add(oracle.id);
    if (!Array.isArray(oracle.predicates) || oracle.predicates.length === 0 ||
      new Set(oracle.predicates).size !== oracle.predicates.length ||
      oracle.predicates.some((predicate) => typeof predicate !== "string" || predicate.length === 0)) {
      issue(issues, "oracle_invalid", `${path}.predicates`);
    }
    oracle.predicates.forEach((predicate, predicateIndex) => {
      const priorKind = declaredPredicates.get(predicate);
      if (priorKind !== undefined) {
        issue(
          issues,
          "duplicate_id",
          `${path}.predicates[${predicateIndex}]`,
          `${predicate} already declared as ${priorKind}`,
        );
      } else {
        declaredPredicates.set(predicate, oracle.kind);
      }
      if (!boundPredicates[oracle.kind].has(predicate)) {
        issue(
          issues,
          "oracle_invalid",
          `${path}.predicates[${predicateIndex}]`,
          "predicate is extraneous or bound to the other oracle kind",
        );
      }
    });
    if (schemasValid) {
      validatePaths(issues, jobClass.payloadSchema, oracle.coversPayloadPaths, `${path}.coversPayloadPaths`);
      validatePaths(issues, jobClass.outputSchema, oracle.coversResultPaths, `${path}.coversResultPaths`);
    }
    if (oracle.kind === "completeness") {
      if (oracle.absenceDomain === undefined) {
        issue(issues, "oracle_invalid", `${path}.absenceDomain`, "required for completeness oracle");
      } else if (schemasValid) {
        validatePaths(issues, jobClass.payloadSchema, oracle.absenceDomain.payloadPaths, `${path}.absenceDomain.payloadPaths`);
      }
    } else if (oracle.absenceDomain !== undefined) {
      issue(issues, "oracle_invalid", `${path}.absenceDomain`, "support oracle cannot declare absence domain");
    }

    const categoryByPredicate = new Map<string, Set<string>>();
    oracle.negativeFixtures.forEach((fixture, fixtureIndex) => {
      const fixturePath = `${path}.negativeFixtures[${fixtureIndex}]`;
      if (!isOracleNegativeFixtureShape(fixture)) {
        issue(issues, "oracle_fixture_invalid", fixturePath, "malformed closed fixture");
        return;
      }
      if (!oracle.predicates.includes(fixture.predicate)) {
        issue(issues, "oracle_fixture_invalid", `${fixturePath}.predicate`, "predicate not declared by oracle");
      }
      const categories = categoryByPredicate.get(fixture.predicate) ?? new Set<string>();
      categories.add(fixture.category);
      categoryByPredicate.set(fixture.predicate, categories);
      if (schemasValid) {
        if (!validateMusterValue(jobClass.payloadSchema, fixture.payload).ok) {
          issue(issues, "oracle_fixture_invalid", `${fixturePath}.payload`, "payload schema failure");
          return;
        }
        if (!validateMusterValue(jobClass.outputSchema, fixture.result).ok) {
          issue(issues, "oracle_fixture_invalid", `${fixturePath}.result`, "output schema failure");
          return;
        }
        try {
          if (oracle.run(fixture.payload, fixture.result).kind !== "fail") {
            issue(issues, "oracle_fixture_did_not_fail", fixturePath);
          }
        } catch (error) {
          issue(issues, "consumer_function_threw", fixturePath, error instanceof Error ? error.message : String(error));
        }
      }
    });
    for (const predicate of oracle.predicates) {
      const categories = categoryByPredicate.get(predicate) ?? new Set<string>();
      const semanticCategory = oracle.kind === "support" ? "unsupported_material" : "omitted_material";
      if (!categories.has("out_of_domain") || !categories.has(semanticCategory)) {
        issue(issues, "oracle_fixture_invalid", `${path}.negativeFixtures`, `${predicate} lacks required failure families`);
      }
    }
  });
}

function validateAgreement(
  jobClass: JobClass<unknown, unknown>,
  schemasValid: boolean,
  issues: RegistrationIssue[],
): void {
  const agreement = jobClass.agreement;
  if (agreement === undefined) return;
  if (!Array.isArray(agreement.agreementFixtures) || agreement.agreementFixtures.length === 0) {
    issue(issues, "agreement_invalid", "$.agreement.agreementFixtures");
    return;
  }
  const kinds = new Set<string>();
  agreement.agreementFixtures.forEach((fixture, fixtureIndex) => {
    const path = `$.agreement.agreementFixtures[${fixtureIndex}]`;
    if (!isAgreementFixtureShape(fixture)) {
      issue(issues, "agreement_fixture_invalid", path, "malformed closed fixture");
      return;
    }
    kinds.add(fixture.kind);
    if (!schemasValid) return;
    if (!validateMusterValue(jobClass.payloadSchema, fixture.payload).ok) {
      issue(issues, "agreement_fixture_invalid", `${path}.payload`, "payload schema failure");
      return;
    }
    for (let index = 0; index < fixture.results.length; index += 1) {
      if (!validateMusterValue(jobClass.outputSchema, fixture.results[index]).ok) {
        issue(issues, "agreement_fixture_invalid", `${path}.results[${index}]`, "output schema failure");
        return;
      }
    }
    let keys: string[];
    try {
      keys = fixture.results.map((result) => canonicalize(agreement.equivalenceKey(result)));
    } catch (error) {
      issue(issues, "consumer_function_threw", `${path}.results`, error instanceof Error ? error.message : String(error));
      return;
    }
    const unanimous = keys.every((key) => key === keys[0]);
    if ((fixture.kind === "equivalent") !== unanimous) {
      issue(issues, "agreement_fixture_mismatch", path, fixture.kind);
      return;
    }
    if (fixture.kind !== "equivalent") return;
    try {
      const resolved = agreement.resolveEquivalent(fixture.results);
      if (!validateMusterValue(jobClass.outputSchema, resolved).ok) {
        issue(issues, "agreement_fixture_mismatch", path, "resolved output schema failure");
        return;
      }
      if (canonicalize(agreement.equivalenceKey(resolved)) !== keys[0]) {
        issue(issues, "agreement_fixture_mismatch", path, "resolved equivalence key changed");
      }
      for (const [index, validator] of jobClass.validators.entries()) {
        if (validator.run(fixture.payload, resolved).kind !== "pass") {
          issue(issues, "agreement_fixture_mismatch", path, `validator ${index} failed`);
        }
      }
      for (const oracle of jobClass.oracles) {
        if (oracle.run(fixture.payload, resolved).kind !== "pass") {
          issue(issues, "agreement_fixture_mismatch", path, `oracle ${oracle.id} failed`);
        }
      }
    } catch (error) {
      issue(issues, "consumer_function_threw", path, error instanceof Error ? error.message : String(error));
    }
  });
  for (const kind of ["equivalent", "split"]) {
    if (!kinds.has(kind)) {
      issue(issues, "agreement_invalid", "$.agreement.agreementFixtures", `missing ${kind} fixture`);
    }
  }
}

function validateEvidenceCoverage(
  jobClass: JobClass<unknown, unknown>,
  schemasValid: boolean,
  issues: RegistrationIssue[],
): void {
  const oracles = jobClass.oracles as OracleSpec<unknown, unknown>[];
  if (jobClass.verification === "deterministic_oracle") {
    if (jobClass.resultEvidenceRequirement === undefined) {
      issue(issues, "requirement_invalid", "$.resultEvidenceRequirement", "required for deterministic floor");
    } else {
      const valid = schemasValid && validateRequirement(
        issues,
        jobClass.resultEvidenceRequirement,
        "$.resultEvidenceRequirement",
        jobClass.payloadSchema,
        jobClass.outputSchema,
      );
      if (valid && !requirementCovered(jobClass.resultEvidenceRequirement, oracles, "support")) {
        issue(issues, "oracle_coverage_missing", "$.resultEvidenceRequirement");
      }
    }
  } else if (jobClass.resultEvidenceRequirement !== undefined) {
    issue(issues, "requirement_invalid", "$.resultEvidenceRequirement", "extraneous for structural floor");
  }
}

function validateEffectFixture(
  jobClass: JobClass<unknown, unknown>,
  permit: Extract<ActionPermit, { mode: "automatic" }>,
  permitPath: string,
  schemasValid: boolean,
  issues: RegistrationIssue[],
): void {
  if (!Array.isArray(permit.effectFixtures) || permit.effectFixtures.length === 0) {
    issue(issues, "effect_fixture_invalid", `${permitPath}.effectFixtures`);
    return;
  }
  permit.effectFixtures.forEach((fixture, fixtureIndex) => {
    const path = `${permitPath}.effectFixtures[${fixtureIndex}]`;
    if (
      typeof fixture !== "object" || fixture === null ||
      !Object.keys(fixture).every((key) => ["input", "expectedDescriptor"].includes(key)) ||
      typeof fixture.input !== "object" || fixture.input === null ||
      !Object.keys(fixture.input).every((key) => ["payload", "result"].includes(key)) ||
      !Object.hasOwn(fixture.input, "payload") || !Object.hasOwn(fixture.input, "result")
    ) {
      issue(issues, "effect_fixture_invalid", path, "malformed closed fixture");
      return;
    }
    try {
      canonicalize(fixture.input.payload);
      canonicalize(fixture.input.result);
      canonicalize(fixture.expectedDescriptor);
    } catch {
      issue(issues, "effect_fixture_invalid", path, "non-canonical fixture value");
      return;
    }
    if (schemasValid && !validateMusterValue(jobClass.payloadSchema, fixture.input.payload).ok) {
      issue(issues, "effect_fixture_invalid", `${path}.input.payload`, "payload schema failure");
      return;
    }
    if (schemasValid && !validateMusterValue(jobClass.outputSchema, fixture.input.result).ok) {
      issue(issues, "effect_fixture_invalid", `${path}.input.result`, "output schema failure");
      return;
    }
    if (!validateMusterValue(permit.effectSchema, fixture.expectedDescriptor).ok) {
      issue(issues, "effect_fixture_invalid", `${path}.expectedDescriptor`, "effect schema failure");
      return;
    }
    try {
      const input = {
        payload: project(fixture.input.payload, permit.effectInput.payloadPaths),
        result: project(fixture.input.result, permit.effectInput.resultPaths),
      };
      const first = permit.deriveEffect(input);
      const second = permit.deriveEffect(cloneCanonical(input));
      if (
        canonicalize(first) !== canonicalize(second) ||
        canonicalize(first) !== canonicalize(fixture.expectedDescriptor)
      ) {
        issue(issues, "effect_fixture_invalid", path, "derivation mismatch or instability");
      }
    } catch (error) {
      issue(issues, "consumer_function_threw", path, error instanceof Error ? error.message : String(error));
    }
  });
}

function validatePermits(
  jobClass: JobClass<unknown, unknown>,
  schemasValid: boolean,
  issues: RegistrationIssue[],
): void {
  const permitsByAction = new Map<Action, { permit: ActionPermit; index: number }>();
  jobClass.permits.forEach((permit, index) => {
    const path = `$.permits[${index}]`;
    if (!ACTION_ORDER.includes(permit.action)) {
      issue(issues, "permit_invalid", `${path}.action`);
      return;
    }
    if (permitsByAction.has(permit.action)) {
      issue(issues, "duplicate_id", `${path}.action`, permit.action);
    } else {
      permitsByAction.set(permit.action, { permit, index });
    }
    const gateAction = effectiveGateAction(permit.action, jobClass.surface);
    const gate = ACTION_GATE_TABLE[gateAction];
    if (permit.mode === "automatic") {
      const consequenceIndex = CONSEQUENCE_ORDER.indexOf(jobClass.consequence);
      const humanFloorIndex = gate.humanOnlyAtOrAbove === null
        ? Number.POSITIVE_INFINITY
        : CONSEQUENCE_ORDER.indexOf(gate.humanOnlyAtOrAbove);
      const maxAutomaticIndex = gate.maxAutomaticConsequence === null
        ? Number.POSITIVE_INFINITY
        : CONSEQUENCE_ORDER.indexOf(gate.maxAutomaticConsequence);
      if (gate.automaticGate === "unavailable" || consequenceIndex >= humanFloorIndex || consequenceIndex > maxAutomaticIndex) {
        issue(issues, "permit_invalid", `${path}.mode`, "automatic mode unavailable");
      }
      const effectSchemaValid = validateMusterSchema(permit.effectSchema).ok;
      if (!effectSchemaValid) issue(issues, "schema_invalid", `${path}.effectSchema`);
      if (schemasValid) {
        validatePaths(issues, jobClass.payloadSchema, permit.effectInput.payloadPaths, `${path}.effectInput.payloadPaths`);
        validatePaths(issues, jobClass.outputSchema, permit.effectInput.resultPaths, `${path}.effectInput.resultPaths`);
      }
      if (effectSchemaValid && schemasValid) {
        validateEffectFixture(jobClass, permit, path, schemasValid, issues);
      }
    } else {
      const effectSchemaValid = validateMusterSchema(permit.effectSchema).ok;
      if (!effectSchemaValid) issue(issues, "schema_invalid", `${path}.effectSchema`);
      const review = permit.reviewRequirement;
      if (schemasValid) {
        validateRequirement(issues, review, `${path}.reviewRequirement`, jobClass.payloadSchema, jobClass.outputSchema);
      }
      if (effectSchemaValid) {
        const pathsValid = validatePaths(issues, permit.effectSchema, review.requiredEffectPaths, `${path}.reviewRequirement.requiredEffectPaths`);
        if (pathsValid && !pathsCover(review.requiredEffectPaths, schemaLeafPaths(permit.effectSchema))) {
          issue(issues, "requirement_invalid", `${path}.reviewRequirement.requiredEffectPaths`, "effect leaves uncovered");
        }
      }
      const needsAbsence = humanNeedsAbsence(permit.action, jobClass);
      if (needsAbsence && review.requiredAbsenceDomain === undefined) {
        issue(issues, "requirement_invalid", `${path}.reviewRequirement.requiredAbsenceDomain`);
      } else if (review.requiredAbsenceDomain !== undefined && schemasValid) {
        validatePaths(issues, jobClass.payloadSchema, review.requiredAbsenceDomain.payloadPaths, `${path}.reviewRequirement.requiredAbsenceDomain.payloadPaths`);
        if (!needsAbsence) {
          issue(issues, "requirement_invalid", `${path}.reviewRequirement.requiredAbsenceDomain`, "extraneous absence domain");
        }
      }
    }
  });

  const evidenceByAction = new Map<Action, Array<{ requirement: ActionEvidenceRequirement; index: number }>>();
  jobClass.evidenceRequirements.forEach((requirement, index) => {
    const items = evidenceByAction.get(requirement.action) ?? [];
    items.push({ requirement, index });
    evidenceByAction.set(requirement.action, items);
    if (schemasValid) {
      validateRequirement(issues, requirement, `$.evidenceRequirements[${index}]`, jobClass.payloadSchema, jobClass.outputSchema);
    }
  });
  const absenceByAction = new Map<Action, Array<{ requirement: typeof jobClass.absenceRequirements[number]; index: number }>>();
  jobClass.absenceRequirements.forEach((requirement, index) => {
    const items = absenceByAction.get(requirement.action) ?? [];
    items.push({ requirement, index });
    absenceByAction.set(requirement.action, items);
    if (schemasValid) {
      validateRequirement(issues, requirement, `$.absenceRequirements[${index}]`, jobClass.payloadSchema, jobClass.outputSchema);
      validatePaths(issues, jobClass.payloadSchema, requirement.requiredDomain.payloadPaths, `$.absenceRequirements[${index}].requiredDomain.payloadPaths`);
    }
  });

  for (const action of ACTION_ORDER) {
    const permitEntry = permitsByAction.get(action);
    const evidence = evidenceByAction.get(action) ?? [];
    const absence = absenceByAction.get(action) ?? [];
    if (permitEntry?.permit.mode !== "automatic") {
      for (const entry of evidence) issue(issues, "requirement_invalid", `$.evidenceRequirements[${entry.index}]`, "extraneous requirement");
      for (const entry of absence) issue(issues, "requirement_invalid", `$.absenceRequirements[${entry.index}]`, "extraneous requirement");
      continue;
    }
    const gate = ACTION_GATE_TABLE[effectiveGateAction(action, jobClass.surface)];
    const needsEvidence = gate.automaticGate === "deterministic_oracle";
    const needsAbsence = gate.requiresCompletenessOracle;
    if (evidence.length !== (needsEvidence ? 1 : 0)) {
      issue(issues, "requirement_invalid", "$.evidenceRequirements", `${action} requires ${needsEvidence ? "exactly one" : "no"} entry`);
    }
    if (absence.length !== (needsAbsence ? 1 : 0)) {
      issue(issues, "requirement_invalid", "$.absenceRequirements", `${action} requires ${needsAbsence ? "exactly one" : "no"} entry`);
    }
    const evidenceRequirement = evidence[0]?.requirement;
    if (evidenceRequirement !== undefined) {
      if (!requirementCovered(
        evidenceRequirement,
        jobClass.oracles as OracleSpec<unknown, unknown>[],
        "support",
      )) {
        issue(issues, "oracle_coverage_missing", `$.evidenceRequirements[${evidence[0]!.index}]`);
      }
      if (
        !pathsCover(evidenceRequirement.requiredPayloadPaths, permitEntry.permit.effectInput.payloadPaths) ||
        !pathsCover(evidenceRequirement.requiredResultPaths, permitEntry.permit.effectInput.resultPaths)
      ) {
        issue(issues, "requirement_invalid", `$.evidenceRequirements[${evidence[0]!.index}]`, "does not cover effect input");
      }
    }
    const absenceRequirement = absence[0]?.requirement;
    if (absenceRequirement !== undefined) {
      const matching = (jobClass.oracles as OracleSpec<unknown, unknown>[]).some((oracle) => {
        try {
          return oracle.kind === "completeness" &&
            oracle.predicates.includes(absenceRequirement.predicate) &&
            oracle.absenceDomain !== undefined &&
            requirementCovered(absenceRequirement, [oracle], "completeness") &&
            absenceDomainCovers(oracle.absenceDomain, absenceRequirement.requiredDomain);
        } catch {
          return false;
        }
      });
      if (!matching) {
        issue(issues, "oracle_coverage_missing", `$.absenceRequirements[${absence[0]!.index}]`);
      }
    }
  }
}

export class ClassRegistrationService {
  readonly registry: RuntimeClassRegistry;

  constructor(private readonly options: {
    readonly store: Store;
    readonly clock: Clock;
    readonly deploymentPolicy: CoreDeploymentPolicy;
    readonly registry?: RuntimeClassRegistry;
  }) {
    this.registry = options.registry ?? new RuntimeClassRegistry();
  }

  async register<Payload, Result>(
    jobClass: JobClass<Payload, Result>,
  ): Promise<ClassRegistrationResult> {
    const untyped = jobClass as JobClass<unknown, unknown>;
    const issues: RegistrationIssue[] = [];
    const payloadSchemaResult = validateMusterSchema(jobClass.payloadSchema);
    const outputSchemaResult = validateMusterSchema(jobClass.outputSchema);
    if (!payloadSchemaResult.ok) {
      for (const schemaIssue of payloadSchemaResult.issues) {
        issue(issues, "schema_invalid", `$.payloadSchema${schemaIssue.schemaPath.slice(1)}`, schemaIssue.code);
      }
    }
    if (!outputSchemaResult.ok) {
      for (const schemaIssue of outputSchemaResult.issues) {
        issue(issues, "schema_invalid", `$.outputSchema${schemaIssue.schemaPath.slice(1)}`, schemaIssue.code);
      }
    }
    const schemasValid = payloadSchemaResult.ok && outputSchemaResult.ok;
    validateBasicPolicy(untyped, this.options.deploymentPolicy, issues);
    validateOracles(untyped, schemasValid, issues);
    validateEvidenceCoverage(untyped, schemasValid, issues);
    validateAgreement(untyped, schemasValid, issues);
    validatePermits(untyped, schemasValid, issues);
    if (issues.length > 0) {
      return { ok: false, kind: "invalid", issues: sortedIssues(issues) };
    }

    const [payloadSchemaHash, outputSchemaHash] = await Promise.all([
      computeMusterSchemaHash(jobClass.payloadSchema),
      computeMusterSchemaHash(jobClass.outputSchema),
    ]);
    const existing = await this.options.store.getClassVersion(
      jobClass.id,
      jobClass.contractVersion,
    );
    let kind: "registered" | "replayed";
    let record: ClassVersionRecord;
    if (existing !== null) {
      if (
        existing.payloadSchemaHash !== payloadSchemaHash ||
        existing.outputSchemaHash !== outputSchemaHash
      ) {
        return {
          ok: false,
          kind: "conflict",
          issues: [{
            code: "durable_schema_conflict",
            path: "$",
            detail: `${jobClass.id}@${jobClass.contractVersion}`,
          }],
        };
      }
      kind = "replayed";
      record = existing;
    } else {
      const registeredAt: Timestamp = this.options.clock.now();
      const outcome = await this.options.store.registerClassVersion({
        classId: jobClass.id,
        contractVersion: jobClass.contractVersion,
        payloadSchemaHash,
        outputSchemaHash,
        registeredAt,
      });
      if (outcome.kind === "conflict") {
        if (
          outcome.existing.payloadSchemaHash !== payloadSchemaHash ||
          outcome.existing.outputSchemaHash !== outputSchemaHash
        ) {
          return {
            ok: false,
            kind: "conflict",
            issues: [{ code: "durable_schema_conflict", path: "$" }],
          };
        }
        kind = "replayed";
        record = outcome.existing;
      } else {
        kind = outcome.kind;
        record = outcome.record;
      }
    }

    let health = await this.options.store.getClassHealth(jobClass.id);
    if (health === null) {
      const initialized = await this.options.store.initializeClassHealth({
        initial: {
          classId: jobClass.id,
          health: READY_HEALTH,
          updatedAt: record.registeredAt,
          source: "automatic",
        },
      });
      health = initialized.current;
    }
    const entry: RuntimeClassEntry<Payload, Result> = {
      jobClass,
      payloadSchemaHash,
      outputSchemaHash,
    };
    const loadedEntry = this.registry.load(entry);
    return {
      ok: true,
      kind,
      record,
      health,
      entry: loadedEntry as RuntimeClassEntry,
    };
  }
}
