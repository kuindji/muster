---
title: Consumer Integration
parents: [integration]
children: []
related_pages: [getting-started, trust-model, integration/mcp-deployment, operations/production-readiness]
last_updated: 2026-08-09
---

# Consumer integration

The consumer is the trusted application around Muster. It owns why a job
exists, which data may leave its boundary, what evidence is sufficient, and
what an accepted result is permitted to cause.

## Design the first workload

Choose one bounded, one-shot operation. Define:

- a closed sanitized payload schema and a closed result schema;
- stable natural identities and exact replay expectations;
- the worker capabilities required before enrollment;
- ordinary and canary routing, lease, replica, and retry bounds;
- deterministic validation, oracle, agreement, sampling, or human-review
  rules that establish the intended strength;
- dispute and invalidation behavior; and
- every possible action descriptor, support threshold, reserve charge, and
  expiry rule.

If the workload needs hidden secrets, open-ended conversation, multiple
dependent stages, or direct unbounded effects, it is outside the current
one-shot boundary.

## Connect the application

1. Install or construct the Store and bootstrap the queue explicitly.
2. Register the reviewed job class and its runtime dependencies.
3. Enroll and activate workers through deployment-owned policy.
4. Sanitize application data before enqueue; retain the application-side
   correlation needed to interpret the eventual result.
5. Drive public core services rather than calling Store commands as business
   APIs.
6. Consume accepted results idempotently and record the exact Muster receipt.
7. Before an external action, read and enforce the live action authorization,
   descriptor, strength, expiry, permit epoch, reserve, and invalidation state.

## Consumer acceptance gate

Before package publication, one real consumer integration must prove the full
path with a representative workload: enqueue, remote lease, accepted result,
replay, refusal, invalidation, and—if used—authorization enforcement. The test
must also show that the consumer does not act without a matching live
authorization and does not put unsanitized secrets in worker payloads.

The MCP real-client PASS proves provider interoperability only. It does not
close this consumer gate. Track the remaining boundary in
[production readiness](../operations/production-readiness.md).
