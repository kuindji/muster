import { hashCanonical } from "./canonical/sha256.js";
import type {
  CanonicalJsonValue,
  SubmissionEvidence,
} from "./primitives.js";

/** Spec revision 12 section 5.4. Snake-case keys are the frozen wire shape. */
export interface InputHashEnvelope {
  payload: CanonicalJsonValue;
  payload_schema: CanonicalJsonValue;
  job_class_id: string;
  contract_version: string;
  output_schema: CanonicalJsonValue;
  policy_version: string;
  permit_epoch: string;
}

export async function computeInputHash(
  envelope: InputHashEnvelope,
): Promise<string> {
  return hashCanonical({
    payload: envelope.payload,
    payload_schema: envelope.payload_schema,
    job_class_id: envelope.job_class_id,
    contract_version: envelope.contract_version,
    output_schema: envelope.output_schema,
    policy_version: envelope.policy_version,
    permit_epoch: envelope.permit_epoch,
  });
}

/**
 * Spec 6.5 step 2: canonicalize and digest the submitted JSON body. An
 * uncanonicalizable value throws and therefore has no result hash.
 */
export async function computeResultHash(
  resultBody: CanonicalJsonValue,
): Promise<string> {
  return hashCanonical(resultBody);
}

/**
 * Lease IDs satisfy the frozen ASCII wire grammar, so JavaScript string order
 * agrees with UTF-8 byte order. Boundaries reject non-wire IDs before this.
 */
function byLeaseIdBytes(
  left: SubmissionEvidence,
  right: SubmissionEvidence,
): number {
  return left.leaseId < right.leaseId
    ? -1
    : left.leaseId > right.leaseId
      ? 1
      : 0;
}

export interface DecisionResultHashEnvelope {
  result: CanonicalJsonValue;
  evidence: SubmissionEvidence[];
  result_adjudication_verdict_hash?: string;
}

/**
 * Spec 6.5 step 11. Evidence is sorted here and must belong to one collection
 * cycle. The optional verdict-hash key is omitted entirely when absent.
 */
export async function computeDecisionResultHash(
  envelope: DecisionResultHashEnvelope,
): Promise<string> {
  const collectionCycle = envelope.evidence[0]?.collectionCycle;
  if (
    collectionCycle === undefined ||
    !Number.isInteger(collectionCycle) ||
    collectionCycle < 1 ||
    envelope.evidence.some(
      (item) => item.collectionCycle !== collectionCycle,
    )
  ) {
    throw new Error("mixed collection cycles");
  }

  const evidence = [...envelope.evidence]
    .sort(byLeaseIdBytes)
    .map((item) => ({
      leaseId: item.leaseId,
      collectionCycle: item.collectionCycle,
      resultHash: item.resultHash,
      workerId: item.workerId,
    }));
  const body: Record<string, unknown> = {
    result: envelope.result,
    evidence,
  };

  if (envelope.result_adjudication_verdict_hash !== undefined) {
    body.result_adjudication_verdict_hash =
      envelope.result_adjudication_verdict_hash;
  }

  return hashCanonical(body);
}
