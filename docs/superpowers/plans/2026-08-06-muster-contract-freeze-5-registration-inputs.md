# Muster contract-freeze-5 registration-input amendment plan

**Status:** Complete in coordinator revision 16 and the local
`contract-freeze-5` tag. No runtime mechanics were added.

**Goal:** Amend revision 15 into revision 16 so the M2 registration service can
execute every required agreement-fixture and reserve-floor check from explicit,
class-owned inputs.

**Trigger:** The first Task-2 implementation trace found two mandatory checks
whose inputs were absent. `AgreementFixture` carried candidate results but no
payload even though registration must run payload-dependent validators and
oracles. The reserve rule required `auditPerWeek` to cover a configured
retrospective-audit projection, but `JobClass` exposed no such projection and no
other frozen boundary owned it.

**Scope:** Normative coordinator prose, consumer-loaded contract types, closed
fixture shape validation, compile-time and runtime contract tests, README,
changelog, freeze metadata, and the M2 plan. No core registration service,
Store change, Postgres, MCP, worker behavior, wire schema, or hash envelope.

## Finding 1: agreement fixtures cannot call validators or oracles

Parameterize `AgreementPolicy` and `AgreementFixture` by both `Payload` and
`Result`. Every equivalent or split fixture carries one exact payload shared by
its result set. Registration first validates that payload against the frozen
payload schema and each result against the frozen output schema. It then uses
the same payload for every validator and applicable oracle invocation, including
the normalized equivalent result.

The closed shape validator requires a canonicalizable `payload`, rejects
missing or unknown fields, and still requires at least two JCS-distinct result
representations with matching `kind` and `expected` labels. It invokes no
consumer function before the closed shape passes.

## Finding 2: the retrospective-audit floor has no owner

Add `retrospectiveAuditProjectionPerWeek` to `EscalationReserves`. The value is
finite and non-negative class-owned policy: the number of retrospective checks
the class declares must be funded in each reserve window. It is distinct from
probabilistic canary rates and from the separately charged `auditPerWeek`
reserve. Registration rejects an audit reserve below the declared projection.

No Store or deployment adapter derives the projection. Reserve-policy snapshots
continue to carry the actual lane limit, and no durable record changes.

## Required executable coverage

- `AgreementPolicy<Payload, Result>` preserves the payload type into every
  fixture;
- equivalent and split fixtures both require a canonicalizable payload;
- missing, non-canonical, and unknown fixture fields are rejected before
  consumer functions run;
- a complete `JobClass` declares the retrospective-audit projection separately
  from its audit reserve;
- the normative examples and M2 registration plan name both new inputs;
- wire version `1.1.0`, Store ports, hashes, and durable fixtures remain
  unchanged.

## Exit gate

Run frozen install, invariants, contract/core typechecks and tests, builds,
package-content inspection, Markdown fence/local-link checks, and
`git diff --check`. Independently trace the payload from the fixture through
schema validation, normalization, validators, and oracles, then trace the audit
projection through registration into the reserve-floor comparison. Only a
reviewed commit tagged `contract-freeze-5` authorizes M2 Task 2 to resume.
