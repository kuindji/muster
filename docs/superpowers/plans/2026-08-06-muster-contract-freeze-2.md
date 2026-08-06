# Muster contract-freeze-2 amendment plan

**Goal:** Correct the revision-12 freeze boundary before Milestone 2 by making
schema validation and the remaining atomic persistence obligations executable.

**Scope:** Contract-only work. This plan changes the normative spec,
`@kuindji/muster-contract`, the types-only `@kuindji/muster-core` boundary, and
frozen fixtures. It implements no routing, lease, verification, authorization,
Postgres, or MCP runtime engine.

**Freeze rule:** `contract-freeze-1` remains historical. Revision 13 is
normative for this amendment. The final reviewed commit is tagged
`contract-freeze-2`; the wire contract becomes `1.1.0` because registration and
schema-validation semantics change compatibly at the TypeScript shape level but
incompatibly for previously accepted arbitrary schemas.

## Task 1: Revision-13 normative amendment

- Update the coordinator design to record the passed platform gate and the
  pre-M2 freeze correction.
- Define Muster Schema 1, its URI, supported keywords, closure rules,
  deterministic identity/ordering rules, and rejected features.
- Define class-qualified compare-and-apply invalidation, per-cycle requeue
  plans, atomic emergency epoch transition, and atomic worker state/lease
  transition.
- Define durable class-version identity, pending backlog timestamps,
  reputation evidence, and the pure consumer-owned `ReputationPolicy`.
- Add the amendment coverage map to section 11 without authorizing runtime
  mechanics.

Validation: Markdown fence check, local-link check, stale revision/platform
gate wording search, and `git diff --check`.

## Task 2: Muster Schema 1 fixtures and executable contract

Files:

- `packages/contract/src/schema.ts`
- `packages/contract/test/schema.test.ts`
- `packages/contract/fixtures/schema-conformance.json`
- `packages/contract/src/index.ts`

The module exports:

- `MUSTER_SCHEMA_DIALECT`
- `MUSTER_SCHEMA_TYPES` and `MUSTER_SCHEMA_KEYWORDS`
- `SchemaIssue` and deterministic issue codes
- `validateMusterSchema(schema)`
- `validateMusterValue(schema, value)`
- `computeMusterSchemaHash(schema)`
- `schemaDeclaresPath(schema, path)`
- `schemaLeafPaths(schema)`

Tests cover accepted nested object/array/nullable schemas; unknown keywords;
boolean/ref/combinator rejection; closure; required/property consistency;
type-specific keyword misuse; finite numeric bounds; Unicode code-point string
length; JCS identity for enum, const, and unique arrays; property-name grammar;
path traversal; and deterministic issue ordering.

## Task 3: Frozen core persistence amendment

Modify `packages/core/src/ports.ts` and its compile-time tests to add:

- `ClassVersionRecord`, registration replay/conflict outcomes, lifecycle reads,
  compare-and-transition lifecycle commands, and durable current-epoch reads
  and transitions.
- `InvalidationScope`, immutable target snapshots, per-cycle requeue plans,
  optional atomic epoch transition, and applied/conflict outcomes that return
  result, pending-request, and issued-authorization-validity transitions for
  audit emission.
- `transitionWorkerState`, atomically requeuing all open leases for suspension
  or revocation and returning their identities.
- `PendingAdjudication<T>` wrappers with `openedAt` for result and action list
  reads.
- `ReputationEvidenceRecord`, idempotent append outcomes, ordered reads, and
  `ReputationPolicy`.

The existing exact-retry, verdict, reserve, decision, and authorization command
shapes remain unchanged unless the review finds a direct contradiction.

## Task 4: Lifecycle and concurrency fixture amendment

Extend the frozen required-case matrices and JSON fixture packs with:

- class-qualified emergency halt and epoch withdrawal;
- identical epoch labels in two classes remain isolated;
- multi-job withdrawal carries distinct recomputed input hashes;
- stale invalidation target snapshots conflict without partial mutation;
- emergency epoch change and invalidation/requeue are one transaction;
- suspension/revocation requeues every open holder lease while retaining
  accepted evidence;
- class-version identical-schema replay and digest conflict;
- pending backlog retains `openedAt` for starvation dwell;
- reputation evidence exact replay, conflicting reuse, canonical ordering, and
  absence of bodies/raw OAuth identity.

The fixture validators must reject malformed new fields instead of silently
ignoring them.

## Task 5: Freeze metadata and validation

- Bump `MUSTER_WIRE_CONTRACT_VERSION` to `1.1.0` and add golden coverage.
- Update README status and `CHANGELOG.md` with the exact amendment boundary.
- Run frozen install, invariants, all package typechecks, all tests, builds,
  `pnpm -F @kuindji/muster-contract fixtures:check`, Markdown/local-link/fence
  checks, package-content inspection, and `git diff --check`.
- Commit only the amendment paths.

## Task 6: Independent review and final tag

Review from the normative prose outward: prose -> exported types -> fixture
schemas -> JSON cases -> consumers/tests. Search for unqualified epoch/version
scopes, single-hash multi-cycle requeues, unobservable backlog age, arbitrary
schema-draft assumptions, raw OAuth identity, and reputation bodies. Fix every
actionable finding, rerun the full validation matrix, commit the reviewed
result, and tag that commit `contract-freeze-2`. Do not push or publish.

## Exit criteria

- Revision 13 and executable types agree field-for-field.
- Every new required fixture ID exists and is validated.
- Schema behavior is deterministic in Node and Workers-compatible source.
- Atomic Store commands can express every revision-13 transition without
  row-level orchestration or an unqualified scope.
- Full validation is green, the worktree is clean, and
  `contract-freeze-2` points at `HEAD`.
