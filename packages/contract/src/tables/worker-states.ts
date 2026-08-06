import { deepFreeze } from "../deep-freeze.js";
import type { WorkerState } from "../job-class.js";

export interface WorkerTransition {
  from: WorkerState;
  to: WorkerState;
  cause: string;
}

/** Spec 3.1 drawn edges plus operator suspension from non-terminal states. */
export const WORKER_TRANSITIONS: readonly WorkerTransition[] =
  deepFreeze([
    {
      from: "enrolled",
      to: "active",
      cause:
        "N checked successes over >= T days at probation canary rate",
    },
    {
      from: "enrolled",
      to: "paused",
      cause: "suspicion during probation",
    },
    {
      from: "active",
      to: "maintenance",
      cause: "worker-declared, costs no standing",
    },
    {
      from: "maintenance",
      to: "active",
      cause: "worker-declared return",
    },
    {
      from: "active",
      to: "paused",
      cause: "coordinator-imposed suspicion",
    },
    {
      from: "maintenance",
      to: "paused",
      cause:
        "coordinator-imposed suspicion (e.g. retrospective audit finding)",
    },
    {
      from: "paused",
      to: "active",
      cause: "operator action or suspicion decay",
    },
    {
      from: "enrolled",
      to: "suspended",
      cause: "operator action",
    },
    {
      from: "active",
      to: "suspended",
      cause: "operator action",
    },
    {
      from: "maintenance",
      to: "suspended",
      cause: "operator action",
    },
    {
      from: "paused",
      to: "suspended",
      cause: "operator action",
    },
    {
      from: "suspended",
      to: "revoked",
      cause: "operator action",
    },
  ]);

export function canTransitionWorker(
  from: WorkerState,
  to: WorkerState,
): boolean {
  return WORKER_TRANSITIONS.some(
    (transition) =>
      transition.from === from && transition.to === to,
  );
}
