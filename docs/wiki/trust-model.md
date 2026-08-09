---
title: Trust Model and Limitations
parents: [README]
children: []
related_pages: [overview, integration/consumer-integration, operations/security]
last_updated: 2026-08-09
---

# Trust model and limitations

Muster strengthens coordination around untrusted agent output. It does not turn
probabilistic model output into a universal proof of correctness.

## What Muster guarantees

For a correctly operated deployment, Muster deterministically enforces the
registered job-class boundary: schemas, canonical identities, worker
enrollment, lease ownership, replay behavior, verification policy, reserve
accounting, adjudication, and authorization state. Durable Store commands make
the relevant comparisons and mutations atomically.

The MCP boundary authenticates every protected request, checks revocation,
maps raw OAuth identity to an opaque worker identifier, applies rate and slot
state, validates closed tool input and output, and exposes only coarse outcomes.

## What Muster does not guarantee

- An ordinary worker result may still be wrong even when it is well formed.
- Agreement among models is evidence, not truth, unless a job-class oracle or
  deterministic rule establishes more.
- A malicious or mistaken trusted consumer can ignore, misuse, or outlive an
  authorization unless its own enforcement boundary prevents that.
- Sanitized leased payloads are visible to the worker and its AI provider.
  Muster is not confidential computing and should not receive secrets that the
  worker is not permitted to see.
- Availability and queue-health buckets reduce side channels; they do not make
  traffic analysis impossible.
- The library does not operate OAuth, TLS, backups, monitoring, scheduling, or
  incident response for the deployment.

## Trusted parties

The deployment operator is trusted to configure job classes, workers, OAuth,
revocation, skill releases, rate policy, durable Stores, clocks, and operational
controls correctly. The integrating consumer is trusted to sanitize input and
honor only current action authorizations. Human adjudicators and external
oracles are trusted to the degree assigned by each job class.

Workers and their providers are not trusted with coordinator policy, raw queue
state, other workers' identities, or action authority. They receive only the
job data and coarse state required by the worker wire.

## Choosing suitable work

Good workloads are bounded, schema-expressible, independently checkable, safe
to disclose to the selected worker, and harmless if an individual attempt is
wrong or unavailable. Poor workloads require secrets, unbounded conversation,
unreviewed side effects, hidden human judgment, or correctness that cannot be
tested or escalated.

Deployment controls are summarized in [security](operations/security.md). The
full normative boundary is in the
[coordinator specification](../specs/2026-08-04-muster-coordinator-design.md).
