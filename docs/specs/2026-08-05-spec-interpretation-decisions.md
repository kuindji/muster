# Spec-revision footnote: interpretation decisions frozen for `contract-freeze-1`

**Date:** 2026-08-05
**Applies to:** `2026-08-04-muster-coordinator-design.md` (revision 11)
**Status:** **Signed off by the operator on 2026-08-05.** Binding on
`docs/superpowers/plans/2026-08-05-muster-m0-m1-contract-freeze.md` and on the
`contract-freeze-1` tag it produces.

The M0+M1 plan freezes public types and hash envelopes. Six places in it commit
to a reading the spec does not actually state — because the spec declares a
structure it never defines, names a value it never gives, or says two things
that cannot both be true. Freezing them silently would bury the decisions in an
implementation plan nobody re-reads. They are recorded here instead, each with
the evidence that a decision was necessary and what would falsify it.

**These are amendments-in-waiting.** Revision 12 of the spec should absorb them
into its own text; until it does, this file is the authority for anything the
spec leaves open. Where a decision turns out wrong, the fix is a spec amendment
*plus* a new contract-freeze tag — the golden vectors in
`packages/contract/fixtures/` encode several of them.

---

## 1. `JobClass` gains `payloadSchema`

**The gap.** §4.2 (spec lines 279–314) declares `outputSchema: JSONSchema`,
`sanitize(raw): Payload`, and `maxPayloadBytes`, but no schema for the payload.
§6.7 (spec line 1390) then requires registration to check "path existence in
the frozen payload schema". That phrase is the document's only mention of a
payload schema, and no structure in the spec provides one.

**Decision.** `JobClass<Payload, Result>` gains `payloadSchema: JSONSchema` —
closed (`additionalProperties: false`), describing the **sanitized** payload,
bound by `contractVersion`.

**It does not enter `input_hash`.** §5.4's envelope is frozen as *(ordered
payload items, job class, contract version, output schema, policy version,
permit epoch)*, and the golden vectors encode exactly that. The schema is
consumed at registration, not at submission verification, and the payload's own
bytes already enter the hash as "ordered payload items". A class author who
mutates the schema without bumping `contractVersion` is caught by registration
re-validation, which is a gate that already exists — adding a seventh envelope
member to cover it would break every vector for no new protection.

**Falsified if** §6.7's "frozen payload schema" was meant to be `outputSchema`.
Then oracle payload paths, absence domains, and human-review payload paths are
validated against nothing at registration, and Tasks 12 and 17 need rework.

## 2. `input_hash` element ownership

### (a) "job class" is bound as `job_class_id`

**The gap.** §5.4 (spec line 635) lists "job class" as a hashed element. A
`JobClass` contains functions — `sanitize`, `equivalenceKey`, `leaseTtl` — and
cannot be canonicalized under RFC 8785 at all.

**Decision.** The element is `job_class_id: string`. The class's semantic
content is pinned by `contract_version` + `output_schema`, which enter the hash
separately, so the ID plus those two is the complete function-free projection.

**Falsified if** a future class-level field is expected to bind into
`input_hash` without a `contractVersion` bump. Nothing in rev 11 requires that.

### (b) `policy_version` is an operator-scoped label, snapshotted at enqueue

**The gap.** `policy_version` appears twice in the whole spec (lines 636 and
674) and no structure declares it, owns it, or says when it is read.

**Decision.** A required `string` supplied at `enqueue`, snapshotted into the
job record and into `LeaseRecord`, and **never derived from mutable state at
submit time**.

**Why the snapshot is the load-bearing half.** §6.5 makes exact retries
idempotent by recognizing an identical `input_hash`. If `policy_version` were
read from live operator config when a submission arrives, any policy change
between the first submit and a legitimate retry would change `input_hash` and
turn that retry into `input_hash_mismatch` — a worker punished for the
operator's edit. Snapshotting is what makes retries recognizable across time.

**Rejected alternative:** making it a `JobClass` field. That collapses it into
`contractVersion` and leaves operator-scoped policy with no version axis of its
own, which is the one thing its name says it is.

## 3. The `JsonPath` grammar is narrowed to three productions

**The gap.** `JsonPath` is used at spec lines 338, 339, 362, 1333, 1334, 1341,
1346, and 1347, and **never defined**. §6.7 requires "plain path containment,
never semantic inference".

**Decision.** `$` is the payload or result root; `.name` selects an object
property; `[*]` selects every element of an array. No filters, slices, indices,
or quoted names. Containment is a segment-list prefix check (`isPathExtension`,
`pathsCover`).

**The consequence that needed sign-off.** Closed JSON Schemas do not force
identifier-like property names, so **M2 registration rejects any class whose
frozen payload or result schema declares a property that cannot be written in
this grammar** — spaces, dots, brackets, or non-ASCII in a property name. Class
authors must use `name`-safe properties.

The trade is deliberate: every richer construct — filters especially — makes
"does path A cover path B" undecidable in general, and containment is the
mechanism §6.7 depends on. Adding an escaped-segment syntax later is a
**compatible grammar extension, not an amendment**: it widens what parses
without changing what any existing path means.

## 4. `AbsenceDomain` identity excludes `id`

**The conflict.** Spec lines 1382–1383, two adjacent clauses:

> Domain identity is canonical (JCS) equality over the closed structure above;
> `id` labels the domain for humans and audit records and carries no matching
> semantics.

The "closed structure above" is `{ id, payloadPaths }` (lines 1339–1341), so a
literal reading puts `id` in the identity — which the next clause denies.

**Decision.** `canonicalAbsenceDomainKey(d)` = JCS of
`{ payloadPaths: sorted-deduped }`. `id` excluded; path order and duplicates
normalized away.

**Why.** Including `id` would make a human-facing label safety-relevant:
renaming a domain — an audit or readability edit — would produce a *different*
domain, so absence coverage established under the old label would stop
matching, and the coordinator would demand fresh absence evidence for an
unchanged universe. Sorting and deduping follows from `payloadPaths` being "the
universe": a set, in which order carries no meaning.

**Falsified if** rev 12 intends two domains over identical paths to be
distinguishable by label. Then `id` returns to the projection and every
absence-domain golden vector changes.

## 5. `PRIVACY_CLASS_RULES` values

**This is new policy, not a transcription.** §7 (spec lines 1530–1531) names
the governance and stops:

> `PrivacyClass` governing submission-body and effect-descriptor retention and
> whether either appears in events.

No per-class values exist anywhere in the spec.

**Decision.**

| `PrivacyClass` | bodies in consumer notifications | descriptors in consumer notifications | ledger bodies |
|---|---|---|---|
| `public` | yes | yes | full |
| `internal` | no | no | full |
| `sensitive` | no | no | hash-only |

Retention **durations** remain operator deployment config in M2, keyed by this
class.

**Scope clarification, and it matters.** The **audit event stream carries
bodies and effect descriptors only as hashes, for every class without
exception** — that rule comes from the audit schema itself, not from this
table. `PRIVACY_CLASS_RULES` governs (i) consumer notifications and (ii) ledger
storage. Without this sentence, `public → bodiesInEvents: true` reads as
licence to put raw bodies in the audit trail, which is never intended.

**The trade the operator accepted.** `sensitive` with `ledgerBodies:
'hash_only'` means a disputed result under a sensitive class **cannot be
re-examined by a human adjudicator from the ledger** — only its hash survives.
That is the intended privacy guarantee, and it constrains adjudication for
exactly the classes most likely to need it. `internal` exists as the middle
rung for classes that want bodies out of the event fan-out but still
adjudicable.

---

## What this footnote does not cover

Frozen design decisions that fill a gap the spec left *open* rather than
resolving something it *stated* — the quantization bucket values, the ASCII
wire-identifier grammar, the typed error vocabularies — are recorded in the
plan at their point of use and need no spec amendment. Only the six decisions
above put words in revision 11's mouth.
