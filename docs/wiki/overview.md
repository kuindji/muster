---
title: Muster Overview
parents: [README]
children: []
related_pages: [trust-model, packages]
last_updated: 2026-08-09
---

# Muster overview

Muster is a coordinator for verified volunteer agent work. A coordinator-owned
application turns a larger workload into bounded, sanitized, one-shot jobs.
Volunteer workers run those jobs using their own AI-provider access and return
results through an OAuth-protected MCP endpoint.

Muster performs no inference. Its job is to make the exchange deterministic and
auditable: it owns job-class registration, payload and result schemas, worker
eligibility, routing, leases, replay, verification, disputes, health state, and
evidence-bound action authorization.

## The problem it solves

Sending work to an external agent creates several independent risks. The agent
may misunderstand the task, return malformed data, retry an old lease, claim a
capability it does not have, or behave consistently badly. The surrounding
system may also leak identity or learn sensitive queue state through errors.

Muster addresses those coordination failures with frozen schemas, canonical
hashing, enrolled capabilities, singular leases, deterministic replay,
class-specific verification, coarse worker-visible outcomes, and durable audit
evidence. The exact strength achieved depends on the job class: deterministic
checks, replica agreement, sampling, oracle review, or human adjudication can
all participate.

## The one-shot lifecycle

1. The deployment registers a job class and enrolls eligible workers.
2. A trusted consumer sanitizes a payload and enqueues a job.
3. A worker authenticates, reports coarse availability, and leases one job.
4. The worker submits JSON matching the disclosed output schema.
5. Muster validates and settles the submission, then accepts, requeues,
   escalates, or rejects according to the class policy.
6. A trusted consumer reads the result and, where applicable, enforces only a
   live evidence-bound action authorization.

The stable worker surface contains six tools: `get_worker_status`,
`set_availability`, `lease_job`, `submit_result`, `abandon_job`, and
`extend_lease`.

## Scope boundary

Version 1 supports bounded one-shot work. Multi-stage agent workflows and
arbitrary effecting work are deliberately deferred because verification and
authorization do not compose safely across uncontrolled stages. Read the
[deferred design](../specs/2026-08-04-muster-staged-and-effecting-design.md)
before proposing either feature.

Next: read the [trust model](trust-model.md) or choose an implementation layer
from the [package guide](packages.md).
