import {
  ACTION_GATE_TABLE,
  absenceDomainCovers,
  canonicalize,
  effectiveGateAction,
  pathsCover,
  validateMusterValue,
  type ActionPermit,
  type CanonicalJsonValue,
  type JobClass,
} from "@kuindji/muster-contract";

import type { DecisionResultRecord } from "./ports.js";
import { projectCanonical } from "./projection.js";

const same = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
};

export type PermitEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "descriptor_mismatch" | "gate_failed" };

/** Runtime evaluation shared by first intents and first human approvals. */
export const evaluateActionPermit = (
  jobClass: JobClass<unknown, unknown>,
  permit: ActionPermit,
  payload: CanonicalJsonValue,
  decision: DecisionResultRecord,
  descriptor: CanonicalJsonValue,
): PermitEvaluation => {
  if (!validateMusterValue(permit.effectSchema, descriptor).ok) {
    return { ok: false, reason: "descriptor_mismatch" };
  }
  if (permit.mode === "human_only") return { ok: true };

  let derived: CanonicalJsonValue;
  try {
    derived = permit.deriveEffect({
      payload: projectCanonical(payload, permit.effectInput.payloadPaths),
      result: projectCanonical(decision.result, permit.effectInput.resultPaths),
    });
  } catch {
    return { ok: false, reason: "descriptor_mismatch" };
  }
  if (!same(derived, descriptor)) {
    return { ok: false, reason: "descriptor_mismatch" };
  }

  const gate = ACTION_GATE_TABLE[
    effectiveGateAction(permit.action, jobClass.surface)
  ];
  if (
    gate.automaticGate === "unavailable" ||
    (gate.automaticGate === "deterministic_oracle" &&
      decision.achievedStrength !== "deterministic_oracle")
  ) return { ok: false, reason: "gate_failed" };

  try {
    if (gate.automaticGate === "deterministic_oracle") {
      const requirement = jobClass.evidenceRequirements.find((entry) =>
        entry.action === permit.action
      );
      if (
        requirement === undefined ||
        !jobClass.oracles.some((oracle) =>
          oracle.kind === "support" &&
          oracle.predicates.includes(requirement.predicate) &&
          pathsCover(
            oracle.coversPayloadPaths,
            requirement.requiredPayloadPaths,
          ) &&
          pathsCover(
            oracle.coversResultPaths,
            requirement.requiredResultPaths,
          ) &&
          oracle.run(payload, decision.result).kind === "pass"
        )
      ) return { ok: false, reason: "gate_failed" };
    }
    if (gate.requiresCompletenessOracle) {
      const requirement = jobClass.absenceRequirements.find((entry) =>
        entry.action === permit.action
      );
      if (
        requirement === undefined ||
        !jobClass.oracles.some((oracle) =>
          oracle.kind === "completeness" &&
          oracle.predicates.includes(requirement.predicate) &&
          oracle.absenceDomain !== undefined &&
          pathsCover(
            oracle.coversPayloadPaths,
            requirement.requiredPayloadPaths,
          ) &&
          pathsCover(
            oracle.coversResultPaths,
            requirement.requiredResultPaths,
          ) &&
          absenceDomainCovers(
            oracle.absenceDomain,
            requirement.requiredDomain,
          ) &&
          oracle.run(payload, decision.result).kind === "pass"
        )
      ) return { ok: false, reason: "gate_failed" };
    }
  } catch {
    return { ok: false, reason: "gate_failed" };
  }
  return { ok: true };
};
