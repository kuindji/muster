import { readFile } from "node:fs/promises";

import { REQUIRED_CONCURRENCY_CASE_IDS } from "@kuindji/muster-contract";
import { TASK8_STORE_CONFORMANCE_CASES } from "@kuindji/muster-core";
import { describe, expect, it } from "vitest";

type CoverageOwner =
  | { readonly kind: "store_conformance"; readonly caseId: string }
  | {
      readonly kind: "postgres_multiclient";
      readonly sourceFile: string;
      readonly testName: string;
    };

const store = (caseId: string): CoverageOwner => ({
  kind: "store_conformance",
  caseId,
});
const postgres = (sourceFile: string, testName: string): CoverageOwner => ({
  kind: "postgres_multiclient",
  sourceFile,
  testName,
});

/** One and only one executable owner for every frozen concurrency case. */
const POSTGRES_CONCURRENCY_COVERAGE: Readonly<Record<string, CoverageOwner>> =
  Object.freeze({
    "concurrent-claim-single-winner": store("candidate-compare-and-claim-single-winner"),
    "no-double-lease-per-job": store("candidate-compare-and-claim-single-winner"),
    "worker-id-binding-rejects-other-holder": store("worker-id-binding-rejects-other-holder"),
    "submit-idempotency-exact-triple": store("submit-idempotency-exact-triple"),
    "conflicting-retry-preserves-accepted-row": store("conflicting-retry-preserves-accepted-row"),
    "invalid-submission-settlement-atomic": store("invalid-submission-settlement-atomic"),
    "contract-expiry-settlement-atomic": store("contract-expiry-settlement-atomic"),
    "split-marker-evidence-fenced": store("split-marker-evidence-fenced"),
    "decision-evidence-snapshot-atomic": store("decision-evidence-snapshot-atomic"),
    "canary-submission-excluded-from-replicas": store("canary-submission-excluded-from-replicas"),
    "expiry-requeue-atomic": store("expiry-requeue-atomic"),
    "result-requeue-cycle-increment-atomic": store("result-requeue-cycle-increment-atomic"),
    "new-cycle-hash-and-epoch-atomic": store("result-requeue-cycle-increment-atomic"),
    "old-cycle-replicas-excluded": postgres(
      "result-state.test.ts",
      "keeps accepted replicas isolated across a result requeue",
    ),
    "authorization-identity-per-intent-id": postgres(
      "result-state.test.ts",
      "persists composite authorization, action verdict, and live invalidation atomically",
    ),
    "verdict-single-accepted-per-request": store("pending-backlog-preserves-opened-at"),
    "charge-key-idempotent-under-race": store("reserve-last-unit-race-fails-closed"),
    "reserve-last-unit-race-fails-closed": store("reserve-last-unit-race-fails-closed"),
    "class-qualified-epoch-invalidation": store("queue-class-precedence-atomic"),
    "multi-cycle-invalidation-set-atomic": store("queue-class-precedence-atomic"),
    "stale-invalidation-snapshot-conflicts": store("queue-class-precedence-atomic"),
    "emergency-epoch-transition-and-requeue-atomic": store("queue-class-precedence-atomic"),
    "worker-suspension-requeues-open-leases": store("worker-suspension-requeues-open-leases"),
    "class-version-schema-digest-conflict": store("class-version-schema-digest-conflict"),
    "pending-backlog-preserves-opened-at": store("pending-backlog-preserves-opened-at"),
    "reputation-evidence-idempotent-under-race": postgres(
      "ledger-reputation.test.ts",
      "records, replays, conflicts, races, restarts, and bytewise-orders evidence",
    ),
    "candidate-compare-and-claim-single-winner": store("candidate-compare-and-claim-single-winner"),
    "claim-worker-exclusion-snapshot-race": store("worker-state-transition-fences-prepared-claim"),
    "claim-cycle-change-stale-snapshot": store("candidate-compare-and-claim-single-winner"),
    "claim-operational-state-stale": store("losing-claim-id-leaves-no-state"),
    "contribution-cap-claim-race": store("candidate-compare-and-claim-single-winner"),
    "slot-occurrence-claim-race": store("candidate-compare-and-claim-single-winner"),
    "core-id-collision-refused": store("core-id-collision-refused"),
    "losing-claim-id-leaves-no-state": store("losing-claim-id-leaves-no-state"),
    "halt-versus-enqueue-atomic": store("queue-class-precedence-atomic"),
    "halt-versus-claim-atomic": store("queue-class-precedence-atomic"),
    "stale-health-refresh-cannot-replace-operator-halt": store("queue-class-precedence-atomic"),
    "queue-class-precedence-atomic": store("queue-class-precedence-atomic"),
    "reserve-policy-change-race-fails-closed": store("reserve-policy-change-race-fails-closed"),
    "reserve-health-last-unit-atomic": store("reserve-last-unit-race-fails-closed"),
    "result-adjudication-id-collision-atomic": store("core-id-collision-refused"),
    "reserve-retirement-health-recompute-atomic": postgres(
      "control-state.test.ts",
      "preserves lifecycle cutoffs and republishes reserve health on retirement",
    ),
    "worker-registration-routing-atomic": store("worker-registration-routing-atomic"),
    "worker-routing-period-transition-race": store("worker-routing-period-transition-race"),
    "class-health-initialization-replay-conflict": store("class-health-initialization-replay-conflict"),
    "no-work-contribution-single-winner": store("no-work-contribution-single-winner"),
    "canary-payload-claim-atomic": store("canary-payload-claim-atomic"),
    "authorization-vs-invalidation-single-winner": postgres(
      "result-state.test.ts",
      "persists composite authorization, action verdict, and live invalidation atomically",
    ),
    "authorization-context-change-fails-closed": postgres(
      "result-state.test.ts",
      "persists composite authorization, action verdict, and live invalidation atomically",
    ),
    "composite-reserve-charges-atomic": postgres(
      "result-state.test.ts",
      "persists composite authorization, action verdict, and live invalidation atomically",
    ),
    "composite-reserve-exhaustion-no-partial-debit": postgres(
      "result-state.test.ts",
      "persists composite authorization, action verdict, and live invalidation atomically",
    ),
    "action-verdict-vs-invalidation-single-winner": postgres(
      "result-state.test.ts",
      "persists composite authorization, action verdict, and live invalidation atomically",
    ),
    "result-verdict-vs-invalidation-single-winner": store("pending-backlog-preserves-opened-at"),
    "result-verdict-cutoff-retires-before-transition": store("pending-backlog-preserves-opened-at"),
    "health-refresh-load-race-fails-closed": store("health-refresh-load-race-fails-closed"),
    "privacy-ledger-rejects-sensitive-body": store("privacy-ledger-rejects-sensitive-body"),
    "emergency-new-class-race-fails-closed": store("emergency-new-class-race-fails-closed"),
    "health-refresh-version-race-fails-closed": store("health-refresh-version-race-fails-closed"),
  });

describe("PostgreSQL frozen concurrency coverage manifest", () => {
  it("has exact, unique ownership with executable Store cases or named tests", async () => {
    const required = [...REQUIRED_CONCURRENCY_CASE_IDS].sort();
    expect(Object.keys(POSTGRES_CONCURRENCY_COVERAGE).sort()).toEqual(required);

    const storeCaseIds = new Set(TASK8_STORE_CONFORMANCE_CASES.map(({ id }) => id));
    for (const [requiredId, owner] of Object.entries(
      POSTGRES_CONCURRENCY_COVERAGE,
    )) {
      if (owner.kind === "store_conformance") {
        expect(storeCaseIds.has(owner.caseId), requiredId).toBe(true);
        continue;
      }
      const source = await readFile(new URL(owner.sourceFile, import.meta.url), "utf8");
      expect(source.includes(`it(\"${owner.testName}\"`), requiredId).toBe(true);
    }
  });
});
