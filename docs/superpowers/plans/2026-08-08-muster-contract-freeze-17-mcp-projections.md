# Muster contract-freeze amendment 17: MCP job projections

**Goal:** Correct the two missing worker-visible projections discovered by the
first MCP Task-5 runtime trace without widening worker wire `1.1.0` or changing
core lease behavior.

**Scope:** Isomorphic MCP contract tables, exact tool output schemas, stable
lifecycle fixtures, coordinator prose, and focused tests only. This amendment
does not implement MCP handlers, change core `Store` or services, publish,
deploy, or push.

## Gap 1: successful extension beyond the fixed TTL table

The fixed `TTL_BUCKETS_SECONDS` table ends at 7,200 seconds. Core legitimately
allows a snapshotted deployment extension to move a lease farther from the
request-start clock when the class's strict absolute in-flight bound permits
it. `extendLease()` commits that durable mutation before returning
`newExpiry`. Revision 27 required the MCP adapter to return a bucket but defined
neither an overflow projection nor a pre-mutation refusal. Returning a generic
tool error after the successful mutation would strand an extended lease and
make the worker-visible result disagree with durable state.

Revision 28 adds `mcpTtlBucketSeconds()`. It uses the frozen table first and,
above 7,200 seconds, doubles the last bucket until it is an upper bound for the
durable seconds-until-expiry value. The value remains coarse, positive, and
deterministic; exact expiry never crosses the worker boundary. This continuation
mirrors the already-reviewed no-stranding rule for transport padding while
using a factor of two appropriate to time buckets. Initial leases remain
restricted to the original fixed table by core's existing quantization rule.

## Gap 2: abandonment refusal code

Revision 27 said `abandon_job` uses a frozen worker-wire error but did not assign
which one. Core intentionally collapses absent, closed, expired, and other-
holder lease states into `{ outcome: "refused" }`. Revision 28 assigns every
such refusal to the sole coarse code `lease_not_held`. No precise holder or
state fact is exposed. The abandon output schema is narrowed to this exact code;
submission retains the complete frozen worker-error set.

## Executable checkpoint

- contract tests pin fixed-table edges, doubled overflow, invalid inputs, and
  the exact abandon-refusal constant;
- lease output advertises only the original fixed TTL values, extension output
  requires a positive integer, and abandon refusal advertises only
  `lease_not_held`;
- two stable lifecycle fixtures own long-extension projection and abandon
  refusal; and
- build, typecheck, lifecycle fixture validation, full tests, package
  inspection, Markdown checks, invariants, and whitespace checks pass before
  the reviewed local `contract-freeze-17` tag.
