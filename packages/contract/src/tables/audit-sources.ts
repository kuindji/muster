import { deepFreeze } from "../deep-freeze.js";

export type AuditSource =
  | "held_out_canary"
  | "deterministic_or_completeness_oracle"
  | "human_audit"
  | "independent_worker_audit";

interface AuditSourceRule {
  mayMoveReputationDirectly: boolean;
}

/** Spec 6.11. Independent-worker audits escalate only and require diversity. */
export const AUDIT_SOURCE_TABLE: Record<
  AuditSource,
  AuditSourceRule
> = deepFreeze({
  held_out_canary: { mayMoveReputationDirectly: true },
  deterministic_or_completeness_oracle: {
    mayMoveReputationDirectly: true,
  },
  human_audit: { mayMoveReputationDirectly: true },
  independent_worker_audit: {
    mayMoveReputationDirectly: false,
  },
});
