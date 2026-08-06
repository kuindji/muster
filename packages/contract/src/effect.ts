import type { Action } from "./actions.js";
import { ACTION_ORDER, sortByActionOrder } from "./actions.js";
import { hashCanonical } from "./canonical/sha256.js";
import type { JsonPath } from "./jsonpath.js";
import type {
  AbsenceDomain,
  EvidenceRequirement,
} from "./oracle.js";
import type {
  CanonicalJsonValue,
  NonEmptyArray,
} from "./primitives.js";

/**
 * JSON Schema type alias for the contract freeze. Core validates schemas at
 * registration in M2; this package only carries their canonical JSON shape.
 */
export type JSONSchema = Record<string, CanonicalJsonValue>;

export interface EffectDerivationInput {
  payload: CanonicalJsonValue;
  result: CanonicalJsonValue;
}

export interface EffectFixture {
  input: EffectDerivationInput;
  expectedDescriptor: CanonicalJsonValue;
}

export interface HumanReviewRequirement extends EvidenceRequirement {
  requiredEffectPaths: NonEmptyArray<JsonPath>;
  requiredAbsenceDomain?: AbsenceDomain;
}

export type ActionPermit =
  | {
      action: Action;
      mode: "automatic";
      effectSchema: JSONSchema;
      effectInput: {
        payloadPaths: JsonPath[];
        resultPaths: JsonPath[];
      };
      deriveEffect(input: EffectDerivationInput): CanonicalJsonValue;
      effectFixtures: NonEmptyArray<EffectFixture>;
    }
  | {
      action: Action;
      mode: "human_only";
      effectSchema: JSONSchema;
      reviewRequirement: HumanReviewRequirement;
    };

export interface EffectIntentItem {
  action: Action;
  descriptor: CanonicalJsonValue;
}

export interface EffectIntent {
  id: string;
  effects: NonEmptyArray<EffectIntentItem>;
}

/** Spec 4.3 transport cap on the canonical intent. Core enforces it in M2. */
export const EFFECT_INTENT_TRANSPORT_CAP_BYTES = 262_144;

export type EffectIntentError =
  | "duplicate_action"
  | "unknown_action"
  | "empty_effects";

/**
 * Validate and normalize an effect intent into stable Action enum order.
 * Typed failures create no authorization-request record in core (spec 4.3).
 */
export function canonicalEffectIntent(
  intent: EffectIntent,
):
  | { ok: true; value: EffectIntent }
  | { ok: false; error: EffectIntentError } {
  if (!Array.isArray(intent.effects) || intent.effects.length === 0) {
    return { ok: false, error: "empty_effects" };
  }

  const seen = new Set<string>();
  for (const effect of intent.effects) {
    if (!ACTION_ORDER.includes(effect.action)) {
      return { ok: false, error: "unknown_action" };
    }
    if (seen.has(effect.action)) {
      return { ok: false, error: "duplicate_action" };
    }
    seen.add(effect.action);
  }

  const effects = sortByActionOrder(
    intent.effects,
    (effect) => effect.action,
  ) as NonEmptyArray<EffectIntentItem>;

  return { ok: true, value: { id: intent.id, effects } };
}

/**
 * effect_intent_hash = SHA-256(JCS({ id, effects })) over sorted effects.
 * The envelope and item keys are frozen by the revision-12 contract.
 */
export async function computeEffectIntentHash(
  intent: EffectIntent,
): Promise<string> {
  const canonical = canonicalEffectIntent(intent);
  if (!canonical.ok) {
    throw new Error(`invalid effect intent: ${canonical.error}`);
  }

  return hashCanonical({
    id: canonical.value.id,
    effects: canonical.value.effects,
  });
}
