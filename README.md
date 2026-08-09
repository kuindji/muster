# Muster

A coordinator library for verified volunteer agent work: distributing bounded,
sanitized, schema-bound one-shot jobs to untrusted agents that run inside other
people's AI provider clouds, on other people's plan allowance, reached over
MCP — and verifying what comes back to an **achieved strength**, gated by
**what the result is permitted to cause**.

Muster performs no model inference. It deterministically rejects invalid
submissions, detects consistently bad workers by sampling, routes disagreement
to humans instead of voting, and issues evidence-bound action authorizations.
It does not guarantee that an ordinary worker result is correct, and it trusts
the consumer to obey those authorizations.

## Status

**Milestone 2 is complete.** The real-provider unattended platform gate passed.
Revision 26 is reviewed, corrected, and tagged locally as
`contract-freeze-15`. M2 now
includes the reference in-memory Store through that boundary, runtime class
registry and registration validator, class/permit/worker control plane,
enqueue/routing/lease lifecycle, and the submission plus cycle-scoped automatic
verification pipeline. It also implements authoritative reserve lifecycle and
atomic health publication, fail-closed escalation charging, authenticated
result and human-only action adjudication with exact verdict replay, bounded
dispute requeues, and class-qualified invalidation with live authorization
validity. The first Task 7 trace found frozen authorization-atomicity,
composite-reserve, verdict-replay, and processing-time gaps. The
`contract-freeze-11` amendment now has executable live-context, composite
reserve, processing-time, and early verdict-replay coverage. M2 now also
implements descriptor-bound all-actions authorization, projected automatic
effect derivation, per-action support and completeness gates, mixed human-only
review binding, atomic authorization reserve selection, immutable initial
receipt replay, and live authorization-status reads. M2 now also implements
finite effective-capacity projection, automatic degraded and truthful
pool-offline modes, explicit admission restoration, conservative live-version
adjudication-policy aggregation, persistent starvation dwell, higher-threshold
operator restoration, queue-wide atomic emergency halt, operational ledger
records, privacy-safe ledger/notification content preparation, and deterministic
reputation eligibility. Degraded mode is a truthful backpressure signal with
urgent-first routing; it does not invent unowned throttling or early-expiry
policy. M2 now also exports a Store-parametric protocol
conformance kit that drives public operations through frozen lifecycle,
registration-fixture, lease-disclosure, adjudication, invalidation,
cross-cycle, deterministic-event, and prompt-injection expectations against the
reference in-memory Store. The Task-10 semantic-review corrections also fence
cross-class emergency epoch changes and unproven diversity adjudication. The
final independent review passed. The
[PostgreSQL Store implementation plan](docs/superpowers/plans/2026-08-07-muster-store-postgres.md)
is independently reviewed and corrected against that boundary. Its package,
caller-owned connection boundary, real-PostgreSQL 16 harness, checksummed
forward migration, explicit queue bootstrap, defensive stored-record codecs,
and bounded serializable transaction runner are complete. Task 3 persists class,
permit-epoch, worker, routing, queue, and class-health control state with durable
exact replay and real-database concurrency coverage. Task 4 now persists jobs,
payloads, current-cycle attempts, candidate snapshots, leases, no-work
contributions, extension deadlines, and sticky-epoch same-cycle requeues with
atomic claim/suspension/abandonment/expiry behavior. Task 5 now persists
holder-bound accepted submissions and invalid settlements with durable replay,
optional reputation evidence, canary-excluding same-cycle replica projection,
absorbing split markers, automatic decisions, result requeues, old-cycle
isolation, and live authorization-context reads. Task 6 now persists reserve
policy windows and atomic charges, composite authorization settlements,
result/action adjudications and canonical verdict history, immutable initial
authorization receipts plus mutable live validity, complete class-qualified
invalidation and requeue batches, adjudication load/health refresh, and
queue-wide emergency halt. Task 7 completes the Store surface with closed-key,
privacy-safe ledger persistence, stable filtered ledger reads, globally unique
and replay-safe reputation evidence, and frozen bytewise evidence ordering.
The complete exported Store and public-operation protocol conformance suites
pass unchanged across adapter restarts on PostgreSQL 16 and 18, from both source
and the packed package. Every frozen concurrency case has one exact executable
owner, and fresh plus checked-in-prefix migration paths run in CI. The adapter's
documentation and independent semantic review are complete. Review corrections
add forward-only invalidation-scope indexes and fail-loud durable reserve replay
decoding without changing the frozen Store boundary. The PostgreSQL adapter
milestone is complete. The
[MCP implementation plan](docs/superpowers/plans/2026-08-08-muster-mcp.md)
is now drafted against the live boundary. Its first implementation gate is
complete: revision 27 and the reviewed
[freeze-16 MCP-boundary amendment](docs/superpowers/plans/2026-08-08-muster-contract-freeze-16-mcp-boundary.md)
own coarse status buckets and next-slot projection, canonical complete-class
skill releases, singular availability-invariant v1 leasing, transport-body
padding, exact OAuth scopes, atomic MCP mapping/rate/slot state, ordered
revocation checks, and tool outcome projection. The worker wire remains `1.1.0`
and the reviewed boundary is tagged locally as `contract-freeze-16`. MCP Task
2 now adds the `@kuindji/muster-mcp` package boundary, immutable HTTPS/resource,
issuer/JWKS, algorithm, Origin, body-limit, clock-skew, and closed-description
configuration, a framework-neutral stateless web handler, exact RFC 9728
metadata routes, and the frozen six-tool catalog. Its real v2 SDK harness passes
the `2026-07-28` JSON and request-scoped SSE paths plus the `2025-11-25`
compatibility path, concurrency, cancellation, unsupported-version, header,
body, method, media-type, and no-session cases. Tool dispatch still returns a
generic pending error. MCP Task 3 now adds fail-closed RFC 9068 JWT verification
against HTTP-metadata-aware rotating JWKS caches, exact bearer challenges and
scope step-up, mandatory per-request token revocation reads, severable
issuer/subject mapping, and pseudonymous coarse worker-status checks. Disposable
HTTP fixtures cover key rotation, stale and malformed keys, issuer/resource and
clock claims, revocation, scope, mapping, worker revocation, concurrency, and
raw-identity scrubbing. MCP Task 4 now adds the serialized reference
`McpStateStore`, operator-only one-to-one bind/sever lifecycle, monotonic worker
mapping revisions, fixed-window per-tool rate and per-slot lease-attempt
accounting, and equal-or-lower availability records. Its exported conformance
suite covers exact replay and conflict, same-key and cross-key races, slot and
window rollover, complete policy comparison, refusal atomicity, detached
records, stable snapshots, and authentication failure after severance while
pseudonymous usage remains. Tool handlers still return the generic pending
result and make no core mutation. The first Task-5 trace found two unowned
worker projections: a successful extension beyond the fixed TTL table and the
exact abandon-refusal code. Revision 28 now continues long expiry buckets by
doubling and maps every abandonment refusal to `lease_not_held`; the corrected
boundary is reviewed and tagged locally as `contract-freeze-17`. Task 5 handler
completion now implements the four job tools through the authenticated MCP
boundary, with closed input and output validation, atomic MCP-state preflight,
canonical text mirrors, complete-response lease padding, coarse expiry
projection, exact core submission replay, and uniform abandon/extension
refusals. The same authenticated real-core suite passes over the in-memory and
PostgreSQL Stores. Task 6 now adds an immutable deployment `SkillReleaseRegistry`
that canonical-renders and SHA-256-verifies every accepted-contract plus
complete-class-set release, and implements both worker tools behind the same
authenticated atomic MCP-state preflight. Worker status returns only the frozen
coarse state, contract, skill hash, cap-usage bucket, and next-slot bucket;
availability delegates only to the public core control-plane transition and
projects every refusal through one non-probing error. The authenticated
six-tool flow passes over both the in-memory and PostgreSQL Stores. Task 7's
optional experimental skill Resource adapter is explicitly pending its external
gate: SEP-2640 remains open and the pinned official TypeScript SDK has no
accepted Skills Extension implementation. No draft capability or resource URI
was added, hand installation remains normative, and the stable six-tool wire is
unchanged. Task 8 now exports `runMusterMcpConformance`, structurally binds the
frozen tool catalog and every revision-27/28 MCP fixture, and drives the real
authenticated remote layer unchanged over the in-memory and restart-per-call
PostgreSQL Stores. The suite proves singular availability-invariant selection,
coarse no-work output, exact accepted replay across handler restart, canonical
six-tool results, prompt-injection data treatment, and raw-identity exclusion
from core calls and events while reusing the MCP-state race suite. Successful
result bytes match across both Store adapters and the packed ESM/CJS exports.
Task 9 now has a public
[MCP operations guide](packages/mcp/README.md) covering handler mounting,
OAuth/JWKS and revocation, exact scopes, severable subject mappings, durable
MCP-state ownership, proxy and body-limit rules, retention, and graceful
shutdown. Its
[nonce-bound real-client protocol](docs/gate/2026-08-08-mcp-real-client-gate.md)
and closed evidence verifier keep schedule proof and raw server evidence outside
worker-visible outputs. The checked-in verifier fixture is local test evidence,
not remote provider/account acceptance. Two fresh unattended Claude Cowork
runs authenticated, returned active status, and leased their nonce-bound jobs,
but both encoded the nested submission result as a JSON string and were
correctly rejected by the object output schema. The MCP package is therefore
not yet declared complete; the remote provider gate must be rerun. Revision 29
now implements the reviewed
[freeze-18 result-JSON amendment](docs/superpowers/plans/2026-08-09-muster-contract-freeze-18-mcp-result-json.md):
successful leases disclose the exact validated frozen `output_schema`, and
`submit_result` requires one explicit `result_json` text. The MCP boundary
parses it exactly once with duplicate-name detection and JCS-domain validation
before durable call authorization, then passes only the parsed value to core.
Object-only constraints and heuristic string normalization remain rejected
because Muster Schema 1 supports every JSON root. The independently reviewed
implementation is tagged locally as `contract-freeze-18`; it changes no core
worker wire or result-validation ownership. No new provider attempt is part of
this checkpoint. The revision-29 semantic review traced the selected class
schema through the detached core projection, duplicate-safe parse ordering,
canonical result identity, replay, padding, fixtures, skill release, and both
Store adapters and found no further defect. The complete local gate passes:
68 files / 511 tests,
PostgreSQL 16 and 18 source plus packed conformance, packed MCP parity, package
inspection, fixture ownership, Markdown, privacy scans, and diff checks.
A subsequent fresh revision-29 Claude Cowork schedule started unattended and
loaded the disposable connector, but default connector permissions stopped it
on an interactive `get_worker_status` approval before any authenticated request
reached Muster. The zero-row evidence is a provider-configuration **FAIL**, not
a runtime or result-JSON finding. The gate protocol now requires durable
pre-authorization of exactly `get_worker_status`, `lease_job`, and
`submit_result`; Task 9 remains open for a new nonce-bound attempt.

## MCP verification

See the package's [operations guide](packages/mcp/README.md) for construction,
deployment ownership, security operations, and the remote acceptance protocol.

```sh
pnpm --filter @kuindji/muster-mcp test
pnpm --filter @kuindji/muster-mcp test:gate-verifier
pnpm --filter @kuindji/muster-mcp test:packed
```

## PostgreSQL adapter verification

See the package's
[construction and operations guide](packages/store-postgres/README.md) for
explicit migration/bootstrap, caller-owned pool shutdown, transaction retries,
deployment roles, backup responsibility, and safe rollout order.

The adapter package uses PostgreSQL 16 through Docker/Testcontainers by default.
Test files run serially, while each frozen race still uses independent clients:

```sh
pnpm --filter @kuindji/muster-store-postgres test
pnpm --filter @kuindji/muster-store-postgres test:packed
```

Use PostgreSQL 18 locally by selecting its disposable Testcontainers image:

```sh
MUSTER_POSTGRES_TEST_IMAGE=postgres:18-alpine pnpm --filter @kuindji/muster-store-postgres test
MUSTER_POSTGRES_TEST_IMAGE=postgres:18-alpine pnpm --filter @kuindji/muster-store-postgres test:packed
```

An explicitly managed test database can be reused instead. Keep its URL in the
shell or CI secret store rather than the repository:

```sh
MUSTER_POSTGRES_TEST_URL="$YOUR_POSTGRES_TEST_URL" pnpm --filter @kuindji/muster-store-postgres test
MUSTER_POSTGRES_TEST_URL="$YOUR_POSTGRES_TEST_URL" pnpm --filter @kuindji/muster-store-postgres test:packed
```

The harness passes the external URL to `node-postgres` without weakening its TLS
configuration. Put the required TLS mode in the URL and any private trust
material in the process environment, such as `NODE_EXTRA_CA_CERTS`. Tests create
and remove only randomly named `muster_test_*` or `muster_pack_*` schemas.

## Specs

| Spec | Status | What it settles |
|---|---|---|
| [2026-08-04 - coordinator design](docs/specs/2026-08-04-muster-coordinator-design.md) (rev 29) | `oneshot` scope; tagged `contract-freeze-18` | What Muster does and does not guarantee, exact MCP scopes/status/skill/rate/revocation/side-channel ownership, leased output-schema disclosure, duplicate-safe result-JSON parsing, deterministic long-extension and abandon-refusal projections, honest pull-based reputation eligibility, truthful degraded-mode behavior, class-qualified invalidation including epoch changes, proven diversity adjudication, class-health live-version policy aggregation, queue-wide atomic emergency batches, operations observations and queue causes, atomic starvation/load comparison, privacy-safe ledger records, live authorization contexts, atomic composite reserves, distinct verdict processing time, early exact verdict replay, the trusted-consumer boundary, Muster Schema 1, authoritative reserve policy and atomic accounting/health publication, atomic submission settlement and absorbing-split routing, core-owned routing and bootstrap state with atomic Store comparison, exact ordinary/canary lease payload binding, atomic no-work contribution accounting, deployment-owned worker probation and routing policy, payload-bound agreement fixtures, explicit retrospective-audit projections, per-lease worker-state requeue audit identity, explicit identity ownership, versioned operational state, bounded lease and reserve policy, mechanically classified fixtures, unanimous replication agreement, collection-cycle-isolated result requeues, exact sanitized-payload/schema hashing, pseudonymous core identity, replay-stable receipts, live validity, privacy, platform gate, licence |
| [2026-08-04 - staged and effecting work](docs/specs/2026-08-04-muster-staged-and-effecting-design.md) | **Deferred; authorizes nothing** | Why multi-stage and side-effecting volunteer work were removed from v1, what was tried, the three unsolved staged-work problems, and the effecting-work trust/execution contract that gate their return |
| [2026-08-05 - interpretation decisions](docs/specs/2026-08-05-spec-interpretation-decisions.md) | Historical operator-signed footnote; superseded by rev 12 | The six revision-11 readings absorbed into revision 12, including the pre-freeze correction that now places the exact canonical sanitized payload and `payload_schema` in `input_hash` |

## Research

| Note | Status | What it covers |
|---|---|---|
| [2026-08-04 - AI Horde as a design reference](docs/research/2026-08-04-ai-horde-reference.md) | Open subject | What transfers from AI Horde, what to avoid, what does not port, the AGPL clean-room boundary, and the SEP-2640 skills-over-MCP finding |

## Planned packages

| Package | Contains |
|---|---|
| `@kuindji/muster-contract` | envelopes, schemas, types, canonical hashing, contract lifecycle, skill generator |
| `@kuindji/muster-core` | routing, leases, verification, action gates, reputation, escalation budgets, ledger |
| `@kuindji/muster-store-postgres` | store adapter and migrations |
| `@kuindji/muster-mcp` | tool surfaces, skill Resource, OAuth, rate limits |

## Contract freeze

The wire contract remains frozen at version `1.1.0`. The current tagged
internal boundary is revision 29 at `contract-freeze-18`. The binding scope is
defined
by [spec §11.1–11.18](docs/specs/2026-08-04-muster-coordinator-design.md#111-milestone-one-is-a-contract-freeze-and-nothing-else),
the checked-in [M0+M1 plan](docs/superpowers/plans/2026-08-05-muster-m0-m1-contract-freeze.md),
the [freeze-2 amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-2.md),
the [freeze-3 M2-entry amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-3-m2-entry.md),
the [freeze-4 Store-bootstrap amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-4-store-bootstrap.md),
the [freeze-5 registration-input amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-5-registration-inputs.md),
the [freeze-6 worker-state audit amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-6-worker-requeue-audit.md),
and the [freeze-7 worker-control policy amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-7-worker-control-policy.md).
The independently reviewed [freeze-8 lease-payload and no-work accounting amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-8-lease-payload-accounting.md)
is implemented and tagged locally; that boundary authorized M2 Task 4.
The [freeze-9 submission-settlement amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-9-submission-settlement.md)
is independently reviewed, corrected, and tagged; M2 Task 5 is complete against
that boundary.
The [freeze-10 reserve-accounting amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-10-reserve-accounting.md)
is independently reviewed, corrected, and tagged; M2 Task 6 is complete against
that boundary.
The independently reviewed and corrected
[freeze-11 action-authorization amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-11-action-authorization.md)
records and implements the first Task-7 trace findings; the reviewed boundary
is tagged locally.
The independently reviewed
[freeze-12 operations-observability amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-12-operations-observability.md)
records and implements the first Task-8 trace findings; the reviewed boundary
is tagged locally.
The independently reviewed
[freeze-13 emergency-batch amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-13-emergency-batch.md)
records and implements the multi-class emergency trace finding; the reviewed
boundary is tagged locally.
The independently reviewed
[freeze-14 class-health policy-set amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-14-class-health-policy-set.md)
records and implements the live-version aggregation finding; the reviewed
boundary is tagged locally.
The reviewed
[freeze-15 Task-10 correction amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-15-task10-review.md)
removes unrepresentable policy promises and fences cross-class invalidation and
unproven diversity adjudication; the corrected boundary is tagged locally.
The reviewed
[freeze-16 MCP-boundary amendment](docs/superpowers/plans/2026-08-08-muster-contract-freeze-16-mcp-boundary.md)
freezes the remaining status, skill, availability, rate, scope, revocation,
output, and side-channel semantics without changing worker wire `1.1.0`; no MCP
runtime code is part of that tag.
The reviewed
[freeze-17 MCP-job projection amendment](docs/superpowers/plans/2026-08-08-muster-contract-freeze-17-mcp-projections.md)
adds deterministic long-extension TTL buckets and one exact abandonment
refusal code without changing worker wire `1.1.0`; no MCP runtime code is part
of that tag.
The reviewed
[freeze-18 MCP-result JSON amendment](docs/superpowers/plans/2026-08-09-muster-contract-freeze-18-mcp-result-json.md)
leases the exact output schema and replaces ambiguous raw results with one
duplicate-safe `result_json` text; the implemented boundary is tagged locally.
Golden hashes, schema conformance, lifecycle, store-concurrency, and
prompt-injection fixtures live under `packages/contract/fixtures/`.

Changes to a frozen type, table, state machine, hash envelope, schema, or
fixture require a spec revision before implementation.

## License

[Apache-2.0](LICENSE). AI Horde is AGPL-3.0-or-later; Muster studies its
design and never copies its code, schemas, or documentation text.
