import type { Action } from "./actions.js";
import { ACTION_ORDER, compareActions } from "./actions.js";
import { hashCanonical } from "./canonical/sha256.js";
import type {
  EffectIntent,
  HumanReviewRequirement,
} from "./effect.js";
import type {
  CanonicalJsonValue,
  NonEmptyArray,
  SubmissionEvidence,
  Timestamp,
} from "./primitives.js";
import type { AuthorizationDenialReason } from "./states.js";

export type ResultAdjudicationReason =
  | "split_exhausted"
  | "diversity_shortfall";

export interface ResultAdjudicationRequest {
  id: string;
  reason: ResultAdjudicationReason;
  jobId: string;
  collectionCycle: number;
  inputHash: string;
  candidateResultHashes: string[];
  evidence: SubmissionEvidence[];
  contractVersion: string;
  permitEpoch: string;
}

export interface ResultAdjudicationVerdict {
  kind: "human";
  resultAdjudicationRequestId: string;
  reason: ResultAdjudicationReason;
  jobId: string;
  collectionCycle: number;
  inputHash: string;
  candidateResultHashes: string[];
  evidence: SubmissionEvidence[];
  contractVersion: string;
  permitEpoch: string;
  adjudicatorId: string;
  decision:
    | { kind: "resolve"; result: CanonicalJsonValue }
    | { kind: "reject" };
  decidedAt: Timestamp;
}

export interface HumanActionReviewRequirement
  extends HumanReviewRequirement {
  action: Action;
}

export interface ActionAdjudicationRequest {
  authorizationRequestId: string;
  jobId: string;
  collectionCycle: number;
  effectIntent: EffectIntent;
  effectIntentHash: string;
  inputHash: string;
  decisionResultHash: string;
  evidence: SubmissionEvidence[];
  resultAdjudicationVerdictHash?: string;
  contractVersion: string;
  permitEpoch: string;
  humanReviews: NonEmptyArray<HumanActionReviewRequirement>;
}

export interface ActionAdjudicationVerdict {
  kind: "human";
  jobId: string;
  collectionCycle: number;
  authorizationRequestId: string;
  effectIntentId: string;
  effectIntentHash: string;
  actions: Action[];
  inputHash: string;
  decisionResultHash: string;
  evidence: SubmissionEvidence[];
  resultAdjudicationVerdictHash?: string;
  contractVersion: string;
  permitEpoch: string;
  adjudicatorId: string;
  decision: "approve" | "reject";
  decidedAt: Timestamp;
}

export interface ActionAuthorization {
  authorizationRequestId: string;
  effectIntentId: string;
  effectIntentHash: string;
  jobId: string;
  collectionCycle: number;
  inputHash: string;
  decisionResultHash: string;
  evidence: SubmissionEvidence[];
  resultAdjudicationVerdictHash?: string;
  actionAdjudicationVerdictHash?: string;
  contractVersion: string;
  permitEpoch: string;
  actions: Action[];
}

interface AuthorizationInitialReceiptBase {
  authorizationRequestId: string;
  effectIntentId: string;
  effectIntentHash: string;
  jobId: string;
  collectionCycle: number;
  decisionResultHash: string;
  at: Timestamp;
}

/** Revision 12 section 4.3: first call and exact retries replay this value. */
export type AuthorizationInitialReceipt =
  | (AuthorizationInitialReceiptBase & {
      outcome: "pending_adjudication";
    })
  | (AuthorizationInitialReceiptBase & {
      outcome: "authorized";
      authorization: ActionAuthorization;
    })
  | (AuthorizationInitialReceiptBase & {
      outcome: "denied";
      denialReason: AuthorizationDenialReason;
    });

export class VerdictShapeError extends Error {
  override name = "VerdictShapeError";
}

/** Canonical action set: known, non-empty, unique, and in enum order. */
export function validateActionSet(
  actions: Action[],
): { ok: true } | { ok: false; error: string } {
  if (actions.length === 0) {
    return { ok: false, error: "empty action set" };
  }

  const seen = new Set<string>();
  for (const action of actions) {
    if (!ACTION_ORDER.includes(action)) {
      return { ok: false, error: `unknown action ${action}` };
    }
    if (seen.has(action)) {
      return { ok: false, error: `duplicate action ${action}` };
    }
    seen.add(action);
  }

  for (let index = 1; index < actions.length; index += 1) {
    if (compareActions(actions[index - 1]!, actions[index]!) > 0) {
      return {
        ok: false,
        error: "actions not in canonical enum order",
      };
    }
  }

  return { ok: true };
}

function sortEvidenceByLeaseId(
  evidence: SubmissionEvidence[],
): SubmissionEvidence[] {
  return [...evidence]
    .sort((left, right) =>
      left.leaseId < right.leaseId
        ? -1
        : left.leaseId > right.leaseId
          ? 1
          : 0,
    )
    .map((item) => ({
      leaseId: item.leaseId,
      resultHash: item.resultHash,
      collectionCycle: item.collectionCycle,
      workerId: item.workerId,
    }));
}

/**
 * Frozen canonical verdict form: evidence sorted bytewise by lease ID and
 * action verdicts constrained to the canonical action set.
 */
export function canonicalVerdict<
  Verdict extends
    | ResultAdjudicationVerdict
    | ActionAdjudicationVerdict,
>(verdict: Verdict): Verdict {
  if ("actions" in verdict) {
    const actionSet = validateActionSet(verdict.actions);
    if (!actionSet.ok) {
      throw new VerdictShapeError(actionSet.error);
    }
  }

  if (
    !Number.isInteger(verdict.collectionCycle) ||
    verdict.collectionCycle < 1 ||
    verdict.evidence.some(
      (item) => item.collectionCycle !== verdict.collectionCycle,
    )
  ) {
    throw new VerdictShapeError("mixed collection cycles");
  }

  return {
    ...verdict,
    evidence: sortEvidenceByLeaseId(verdict.evidence),
  };
}

/** Both adjudication verdict hashes share this canonicalized digest path. */
export async function computeVerdictHash(
  verdict: ResultAdjudicationVerdict | ActionAdjudicationVerdict,
): Promise<string> {
  return hashCanonical(canonicalVerdict(verdict));
}

/** Result-dispute provenance must neither be stripped nor invented. */
export function validateResultDisputeProvenance(
  value: { resultAdjudicationVerdictHash?: string },
  options: {
    humanResolvedDispute: boolean;
    boundVerdictHash?: string;
  },
): { ok: true } | { ok: false; error: string } {
  if (options.humanResolvedDispute) {
    if (value.resultAdjudicationVerdictHash === undefined) {
      return {
        ok: false,
        error:
          "result_adjudication_verdict_hash required after a human-resolved dispute",
      };
    }
    if (
      value.resultAdjudicationVerdictHash !== options.boundVerdictHash
    ) {
      return {
        ok: false,
        error:
          "result_adjudication_verdict_hash does not match the bound verdict",
      };
    }
    return { ok: true };
  }

  if (value.resultAdjudicationVerdictHash !== undefined) {
    return {
      ok: false,
      error:
        "result_adjudication_verdict_hash must be absent without a human-resolved dispute",
    };
  }
  return { ok: true };
}

/**
 * Candidate hashes must be unique, bytewise-sorted, and equal the
 * deduplicated result-hash projection of same-cycle evidence.
 */
export function validateCandidateHashes(
  candidateResultHashes: string[],
  evidence: SubmissionEvidence[],
  collectionCycle: number,
): { ok: true } | { ok: false; error: string } {
  if (
    !Number.isInteger(collectionCycle) ||
    collectionCycle < 1 ||
    evidence.some(
      (item) => item.collectionCycle !== collectionCycle,
    )
  ) {
    return { ok: false, error: "mixed collection cycles" };
  }

  for (let index = 1; index < candidateResultHashes.length; index += 1) {
    const previous = candidateResultHashes[index - 1]!;
    const current = candidateResultHashes[index]!;
    if (current === previous) {
      return { ok: false, error: "duplicate candidate hash" };
    }
    if (current < previous) {
      return {
        ok: false,
        error: "candidate hashes not in canonical (bytewise) order",
      };
    }
  }

  const projection = [
    ...new Set(evidence.map((item) => item.resultHash)),
  ].sort();
  if (
    projection.length !== candidateResultHashes.length ||
    projection.some(
      (hash, index) => hash !== candidateResultHashes[index],
    )
  ) {
    return {
      ok: false,
      error:
        "candidate hashes do not equal the evidence result-hash projection",
    };
  }

  return { ok: true };
}
