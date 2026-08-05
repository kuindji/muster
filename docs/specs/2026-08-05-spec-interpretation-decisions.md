# Historical spec-revision footnote: revision 11 interpretation decisions

**Date:** 2026-08-05
**Applies to:** `2026-08-04-muster-coordinator-design.md` (revision 11)
**Status:** **Superseded by coordinator revision 12 on 2026-08-05.** Retained as
the signed decision record that bridged revision 11 to the plan; no longer a
second normative authority.

The M0+M1 plan freezes public types and hash envelopes. Six places in its
revision-11 draft committed
to a reading the spec does not actually state — because the spec declares a
structure it never defines, names a value it never gives, or says two things
that cannot both be true. Freezing them silently would bury the decisions in an
implementation plan nobody re-reads. They are recorded here instead, each with
the evidence that a decision was necessary and what would falsify it.

**Revision 12 absorbed these decisions into the spec.** It also superseded one
part of decision 1 before any freeze tag or golden-vector file existed: the
exact canonical sanitized payload and `payload_schema` now both enter
`input_hash`. Current implementations follow revision 12 and the revised plan,
not the historical wording below.

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

**Revision 12 disposition.** The schema does enter `input_hash`, alongside the
exact canonical sanitized `payload`. The review found that revision 11's
"ordered payload items" did not define a projection for arbitrary `Payload`
shapes and that registration validity alone did not bind a schema's bytes. No
golden vectors or freeze tag existed, so revision 12 corrected the envelope
before implementation.

**Falsified if** §6.7's "frozen payload schema" was meant to be `outputSchema`.
Then oracle payload paths, absence domains, and human-review payload paths are
validated against nothing at registration, and Tasks 12 and 17 need rework.

## 2. `input_hash` element ownership

### (a) "job class" is bound as `job_class_id`

**The gap.** §5.4 (spec line 635) lists "job class" as a hashed element. A
`JobClass` contains functions — `sanitize`, `equivalenceKey`, `leaseTtl` — and
cannot be canonicalized under RFC 8785 at all.

**Decision.** The element is `job_class_id: string`. Revision 12 retains this
function-free identity and separately hashes `contract_version`,
`payload_schema`, and `output_schema`.

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
storage. Without this sentence, a generic `public → bodies in events: true`
rule reads as licence to put raw bodies in the audit trail, which is never
intended.

**The trade the operator accepted.** `sensitive` with `ledgerBodies:
'hash_only'` means a sensitive body may be available operationally only while
its verification or adjudication lifecycle is active. After that lifecycle or
its maximum lifetime, **it cannot be re-examined from the ledger** — only its
hash survives. That is the intended privacy guarantee. `internal` exists as
the middle rung for classes that want bodies out of the event fan-out but still
adjudicable.

---

## What this footnote does not cover

Frozen design decisions that filled a gap revision 11 left *open* rather than
resolving something it *stated* — the quantization bucket values, the ASCII
wire-identifier grammar, the typed error vocabularies — remain recorded in the
plan at their point of use. Revision 12 is now the complete normative spec.
