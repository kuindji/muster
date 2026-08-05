# Muster - a coordinator for verified volunteer agent work

**Date:** 2026-08-04 (revision 11)

**Status:** Design, converged for `oneshot` scope. Authorizes an implementation
plan for a one-shot v1; not code. The platform gate (section 9) blocks anything
beyond a stub until it passes.

**Package:** `@kuindji/muster-*` on npm, repo `muster`, **Apache-2.0**, public
from the first commit.

**Origin:** extracted from the design of its first consumer, a news-service
product that is not yet public. That consumer is the first adopter, not the
owner.

**Companion documents:**
`2026-08-04-muster-staged-and-effecting-design.md` (deferred, not authorized);
`../research/2026-08-04-ai-horde-reference.md`.

**Amendments in waiting:** `2026-08-05-spec-interpretation-decisions.md` records
six places where this revision declares a structure it never defines, names a
value it never gives, or says two things that cannot both be true. Each has an
operator-signed reading that the M0+M1 plan freezes. Revision 12 should absorb
them; until then that file is the authority wherever this one is open.

**Revision note.** Five gpt-5.5 review rounds have been applied. Rounds 3 and 4
both concluded that staged and effecting work were not ready to plan against,
the second time after a revision devoted to fixing them, so **revision 5
removed both from this spec** and moved them, with their unsolved problems, to
a separate deferred design. What remains — one-shot jobs — is the half that
converged. Revision 5 also expanded the action enum to cover internal state
mutation, **budgeted `routeToHuman`** (it was a denial-of-service channel
against the scarcest safety resource), defined `OracleSpec` with coverage and
mandatory negative fixtures, made class health a required surface rather than
an event, and stated plainly that selective withholding is undetectable for
sparse contributors.

Revision 6 answers round 5. Its two blocking findings were both consequences of
revision 5's own wording: "every side effect maps to **exactly one** action"
let a composite behaviour declare only its weakest gate and skip `suppress`
(section 4.3), and removing staged work removed the action that covered
creating downstream jobs while the deferred spec recommends composing one-shot
classes by hand — so `enqueueDerivedWork` is added and gated as
absence-affecting. Revision 6 also makes `surface` mandatory rather than an
optional flag a bounded consumer could omit; splits escalation into
**non-borrowable reserves** with urgent exhaustion failing closed; requires
each absence-gated action to declare an `AbsenceRequirement` whose coverage
must pass registration validation; adds a precedence table for epochs,
draining, and class health; and turns section 11.1 into an explicit
contract-freeze list.

Revision 7 closes the contract-review findings that remained before planning:
it states the trusted-consumer boundary instead of claiming Muster can enforce
effects in arbitrary consumer code; adds the missing replication policy and a
human-adjudication lifecycle; makes escalation saturation multidimensional;
removes sampled canaries from per-result verification strength; defines exact
submission-conflict semantics; requires human adjudication for every `drop`;
and describes oracle coverage as checked evidence rather than proof.

Revision 8 closes the lifecycle review findings before planning. It
separates result-dispute adjudication from action authorization, gives every
pending state explicit invalidation transitions, removes model inference from
the core oracle contract, makes accepted-submission replay precede terminal
lease checks, distinguishes admission halts from emergency halts, replaces the
unconstrained agreement callback with unanimous equivalence, and makes
low-cost escalation overflow bounded rather than an unbounded review queue. It
also reconciles the first consumer's contract and keeps the in-review Skills
Extension behind an experimental adapter boundary.

Revision 9 closes the evidence-and-authorization review findings. It binds
every deterministic action gate to action-specific payload and result coverage
instead of trusting a class-wide strength label; makes result strength an
achieved property rather than a declaration; gives every action permit an
explicit automatic or human-only mode; and makes human action verdicts a
separate type from reputation evidence. It also fixes the contradiction between
unanimous agreement and split rerouting: once any accepted replicas disagree,
more replicas may enrich human-review evidence but can never restore automatic
agreement. Finally, it gives effect-intent action requests and both verdict
paths exact-retry and conflict semantics, and makes higher-precedence conditions
invalidate issued but not-yet-acted-on authorizations at the consumer boundary.
It also removes the experimental Skills Resource URI from the stable
worker-status schema.

Revision 10 closes the follow-up lifecycle and human-review findings. It
separates immutable authorization receipts from live validity, retires every
affected verified result from future effect intents when a higher-precedence
condition applies, and makes the emergency-withdrawal rule safe for results
that already authorized one of several possible intents. Human-only permits now
bind the effect-descriptor paths the reviewer must inspect and, for
absence-affecting actions, the exact absence domain. It also makes the
action-adjudication request identity unambiguous and extends conformance coverage
for those contracts.

Revision 11 pins three contracts the milestone-one freeze could not survive
without. `SubmissionReceipt` is defined as immutable acceptance facts only, so
byte-identical replay cannot leak post-acceptance state or canary status.
`AbsenceDomain` gets a canonical shape with path-containment coverage, so
registration's completeness checks are implementable identically everywhere.
Urgent-reserve saturation gets an explicit denial outcome for in-flight
authorization requests — the one reserve whose exhaustion previously left an
authorization lifecycle hole. A second review pass over those fixes added two
more contracts: denial reasons are typed (`AuthorizationDenialReason`) so a
budget denial, gate failure, out-of-permit action, and human rejection stay
distinguishable across replays and status reads, and rejected-dispute requeues
are bounded per logical job by `adjudication.maxRejectedDisputeRequeues`, so a
reject-and-requeue loop cannot burn the split-and-adjudication reserve forever.
It also renames the stale `onSplitVerdict` event
to `onSplit`, aligns enrollment's calibration wording with the probation gate,
and states what happens to a job after a rejected result dispute.

## 1. What Muster is

A coordinator library for distributing bounded, sanitized, schema-bound
one-shot jobs to untrusted agents that run inside other people's AI provider
clouds, on other people's plan allowance, reached over MCP — and for verifying
what comes back to an **achieved strength**, gated by **what the result is
permitted to cause**.

### 1.1 What Muster guarantees

Revision 1 claimed Muster returns results "the operator can verify without
trusting the worker." **That was false and is retracted.** Schema checks,
`input_hash` binding, and canary sampling do not establish that an ordinary
result is correct. A worker returning schema-valid, plausible garbage on every
non-canary job passes all of them.

What Muster actually guarantees:

- **Deterministic rejection.** Malformed, oversized, out-of-enum, wrong-hash,
  wrong-subject, and conflicting same-lease submissions never reach the
  consumer.
- **Sampled detection.** Canaries detect a consistently bad worker with
  probability `1 - (1 - q)^n` over `n` attempts: at `q = 0.1`, 22 attempts for
  90%, 29 for 95%, 44 for 99%. For a weekly contributor that is months.
- **Disagreement routing.** Divergent replicas escalate; never a vote.
- **Deterministic authorization decisions.** Muster never authorizes an action
  whose minimum verification strength its class and evidence do not meet
  (section 6.3). A conforming consumer acts only through those authorizations;
  the consumer trust boundary is explicit below.
- **An audit trail.** Every result is bound to a lease, payload, contract
  version, permit epoch, and worker.

### 1.2 The invariant

> **Muster performs no model inference.**

`muster-core` has one runtime dependency and a CI assertion that it references
no network or filesystem API (section 8.3).

**Scoped to the library, and not a legal shield.** An adopter may run inference
before or after Muster; the first consumer does. Model-based advisory work remains outside
the core oracle contract and never satisfies an automatic action gate. An
operator that selects sources, sanitizes them, coordinates agents, validates
outputs, and publishes results is very likely a publisher and a data controller
regardless of where inference runs.

**Trusted-consumer boundary.** Muster distrusts workers. It trusts the adopting
consumer to execute only actions that Muster authorizes and to describe every
consumer-side effect honestly. Core returns a bound `ActionAuthorization`; it
does not own the consumer's database, publication surface, or effect executor
and therefore cannot prevent buggy or dishonest consumer code from ignoring an
authorization. Guarantees in this document cover Muster's authorization
decision and conforming consumers, not arbitrary code after the library returns.

### 1.3 The envelope

**v1 supports one shape: one-shot jobs** — bounded, sanitized, schema-bound,
**worker-side-effect-free**, resolved in a single worker turn. The worker
performs no action on the world; the *result* may cause consumer-side effects,
but a conforming consumer causes them only through the action authorizations in
section 6.3. In a spec whose core invariant is action gating, that distinction
and the consumer trust boundary are load-bearing.

Staged (multi-stage) and effecting (side-effect-proposing) work are **not in
this spec**. They are designed, with their unsolved problems enumerated, in
`2026-08-04-muster-staged-and-effecting-design.md`, which authorizes nothing.
Revisions 1 and 2 of this document claimed Muster served "any agent task."
That was false and is retracted.

### 1.4 What is out of reach

- **Semantic completeness or recall** without a completeness oracle or human
  review. Verification confirms what is present; absence is the hard axis
  throughout this design.
- **Automated high-impact suppression** — "duplicate", "no material change",
  "not newsworthy" are omission decisions needing section 6.3's strongest
  gates.
- **Automated high-impact publication**, and **urgent unverified output**.
- **Detection of selective withholding by sparse contributors.** Withholding is
  unpreventable (section 5.7), and it is only detectable at population scale. A
  worker running once a week who declines one sensitive batch a month is
  statistically indistinguishable from noise, and no amount of tuning changes
  that. High-consequence queues need redundancy, a higher-volume cohort, or
  capacity that does not depend on sparse workers.
- **Confidentiality from workers or their model providers.** A payload is read
  by a volunteer and processed by their provider under their account and terms.
  Anything in a payload is disclosed. The only control is what goes in one.
- **Enforceable model-family diversity** (section 6.2) and **Sybil-resistant
  independence** (section 8.4).
- **Hard latency SLAs.** Capacity rests on volunteer schedules and provider
  clouds; latency is statistical.
- **Legal or publisher-liability shielding** (section 1.2).
- **Protection from a buggy or dishonest consumer.** Muster authorizes effects;
  it cannot stop consumer code from bypassing the library after a result is
  returned (section 1.2).

For a news-service consumer, the safe use is **worker output as triage and extraction evidence**
feeding deterministic checks and human editorial review.

## 2. Scope

**Core:** worker state and enrollment; queue and routing with replication
diversity; leases; the verification pipeline; action-authorization decisions;
the ledger with fair-outcome classification; reputation, suspicion, escalation
budgets, and adjudication accounting; capacity, backpressure, and class health;
contract lifecycle and canonical hashing; the event schema.

**Not in core:** authentication, which lives in `muster-mcp` (core consumes an
authenticated `WorkerSubject`).

**The consumer's:** fetching and sanitizing source material; membership and
eligibility policy; publication and editorial surfaces; notifications; staffing
human adjudication; any operator-funded fallback inference; and faithfully
enforcing Muster's `ActionAuthorization` at every consumer-side-effect boundary.

**Non-goals:** no worker-side runtime; no automation of provider scheduling; no
generic fetch, proxy, or query tool on the MCP surface, ever; no trusted or
API-key worker class; no worker-driven loops; no worker that acts on the world.

## 3. Worker model

A worker is an OAuth subject reached over MCP, executing inside a provider's
cloud, invoked by a schedule the operator does not control, spending allowance
the operator cannot measure.

### 3.1 States

```
enrolled --(N checked successes over >= T days)--> active <--> maintenance
   |                                                  |
   +-----------> paused <---------(suspicion)---------+   suspended --> revoked
                    |                                     (operator)
                    +--(operator or decay)--> active
```

`maintenance` is worker-declared and costs no standing. `paused` is
coordinator-imposed by suspicion. `suspended` is an operator action.

### 3.2 Capabilities are enrolled, never claimed at lease time

Capabilities are server-recorded at enrollment and revalidated by probe:
provider surface, whether the plan executes unattended scheduled tasks,
verified language coverage, supported job classes. A caller-supplied capability
that affects eligibility is a content selector in disguise. A worker's
self-reported model, provider, or version is operational metadata, never
attestation — hence section 6.2's confidence typing.

### 3.3 Enrollment

Binds an OAuth subject to a worker record; captures the declared contribution
cap; probes and records capabilities; records provider and account cluster for
diversity routing; assigns a slot; records contract acceptance; issues a first
calibration job that opens probation. `enrolled -> active` is gated by section
3.1's N checked successes over at least T days at the probation canary rate
(section 6.11), not by the calibration job alone. Consumers supply an
`AdmissionHook`. Muster refuses to lease to anyone not enrolled.

## 4. Job model

### 4.1 Packages

| Package | Contains | Depends on |
|---|---|---|
| `@kuindji/muster-contract` | envelopes, schemas, types, `input_hash` canonicalization, contract lifecycle, skill generator | nothing; isomorphic, zero-dependency |
| `@kuindji/muster-core` | routing, lease state machine, verification, action gates, reputation, suspicion, escalation budgets, ledger, slots, capacity, class health, event schema, in-memory store, conformance kit | `muster-contract` |
| `@kuindji/muster-store-postgres` | adapter and migrations | `muster-core` |
| `@kuindji/muster-mcp` | tool surfaces, skill Resource, OAuth and JWKS, rate limits, as a mountable handler | `muster-core`, `muster-contract` |

`muster-core` performs no I/O. Ports: `Store`, `Clock`, `EventSink`,
`AdmissionHook`, `AdjudicationSource`.

### 4.2 `JobClass`

```ts
interface JobClass<Payload, Result> {
  id: string
  contractVersion: string                  // enters input_hash
  kind: 'oneshot'                          // reserved; see section 1.3

  outputSchema: JSONSchema                 // closed: additionalProperties false
  maxPayloadBytes: number
  maxResultBytes: number
  sanitize(raw: unknown): Payload

  verification: AutomaticVerificationStrength // required result floor; section 6.3
  resultEvidenceRequirement?: EvidenceRequirement // required for deterministic floor
  validators: Validator<Payload, Result>[] // deterministic, no I/O
  oracles: OracleSpec<Payload, Result>[]   // section 6.7
  agreement?: AgreementPolicy<Result>       // section 6.2; deterministic, no I/O
  replication: ReplicationPolicy
  canaries?: CanarySource<Payload, Result>

  permits: ActionPermit[]                 // section 4.3; empty is meaningful
  consequence: 'low' | 'material' | 'high' | 'irreversible'
  surface: 'bounded' | 'unbounded'         // MANDATORY; section 4.3
  evidenceRequirements: ActionEvidenceRequirement[] // section 6.7
  absenceRequirements: AbsenceRequirement[]          // section 6.7

  requires: CapabilityRequirement
  diversity?: DiversityRule                // section 6.2
  privacy: PrivacyClass
  cost: {
    expectedTurns: number
    leaseTtl(p: Payload): Seconds
    maxInFlightLifetime: Seconds
  }
  sla?: { targetLatency: Seconds; urgency: 'normal' | 'urgent' }
  escalation: EscalationReserves           // section 6.4
  adjudication?: AdjudicationPolicy         // required when a gate needs a human
}

interface ReplicationPolicy {
  target: number                      // integer >= 1; independent accepted results needed
  maxSplitEvidenceReroutes: number    // integer >= 0; evidence only after a split
}

interface AgreementPolicy<Result> {
  equivalenceKey(result: Result): CanonicalJsonValue
  resolveEquivalent(results: NonEmptyArray<Result>): Result
  agreementFixtures: NonEmptyArray<AgreementFixture<Result>>
}

interface AgreementFixture<Result> {
  results: NonEmptyArray<Result>
  expected: 'equivalent' | 'split'
}

type ActionPermit =
  | {
      action: Action
      mode: 'automatic'
      effectSchema: JSONSchema
      effectInput: {
        payloadPaths: JsonPath[]
        resultPaths: JsonPath[]
      }
      deriveEffect(input: EffectDerivationInput): CanonicalJsonValue
      effectFixtures: NonEmptyArray<EffectFixture>
    }
  | {
      action: Action
      mode: 'human_only'
      effectSchema: JSONSchema
      reviewRequirement: HumanReviewRequirement
    }

interface EffectDerivationInput {
  payload: CanonicalJsonValue
  result: CanonicalJsonValue
}

interface EffectFixture {
  input: EffectDerivationInput
  expectedDescriptor: CanonicalJsonValue
}

interface HumanReviewRequirement extends EvidenceRequirement {
  requiredEffectPaths: NonEmptyArray<JsonPath>
  requiredAbsenceDomain?: AbsenceDomain
}

type AgreementOutcome<Result> =
  | { kind: 'agreed'; result: Result }
  | {
      kind: 'split'
      equivalenceKeys: NonEmptyArray<CanonicalJsonValue>
    }

interface AdjudicationPolicy {
  requiredRatePerWeek: number
  starvationDwell: Seconds
  restoreAbovePerWeek: number // strictly greater than requiredRatePerWeek
  capacityMaxAge: Seconds
  maxRejectedDisputeRequeues: number // integer >= 0; section 6.6
}
```

`surface` is mandatory rather than optional. A boundedness flag a consumer may
simply omit is not a control: a bounded consumer that never declares itself
gets the weaker gate for free, which is the failure the flag existed to
prevent.

Registration rejects non-positive payload or result byte ceilings, a
non-positive replication target, a negative split-evidence limit, `target > 1`
without `agreement`, a split-evidence allowance when `target === 1`, or a
diversity rule that cannot cover the target in principle. The maximum in-flight
lifetime must exceed every possible lease plus extension. A class declaring a
`deterministic_oracle` result floor must declare a matching
`resultEvidenceRequirement`. Each `automatic` permit whose gate requires
deterministic evidence must have exactly one matching entry in
`evidenceRequirements`, and every automatically absence-gated action must
additionally have exactly one matching `absenceRequirement`. A `human_only`
permit has neither; its mandatory `reviewRequirement` binds the predicate and
payload, result, and effect-descriptor paths the human must inspect directly.
For `updateRetrievalIndex`, `selectCandidateSet`, `enqueueDerivedWork`,
`suppress`, `drop`, and bounded `deprioritize`, it also binds the required
absence domain. Section 6.7 defines
coverage validation and rejects missing, duplicate, or extraneous requirements.
Registration also rejects duplicate action permits, an `automatic` mode where
the action table requires a human, or an unavailable automatic
action/consequence combination. Every permit's `effectSchema` is closed; it
describes the complete consumer-side parameters for that action, not merely a
display summary. Every automatic permit's `deriveEffect` is deterministic and
I/O-free. Core gives it only canonical projections of `effectInput`'s declared
payload and result paths, never the full objects. Registration validates those
paths, runs the non-empty golden fixtures, and validates every expected
descriptor against the effect schema. For a deterministic automatic gate, the
matching `ActionEvidenceRequirement` paths must be supersets of the effect-input
paths. For a human-only gate, registration validates every required effect path
against the closed effect schema and rejects any effect-schema leaf outside the
declared review coverage.

Agreement registration runs every mandatory fixture. It rejects a policy that
accepts a fixture with fewer than two results, maps a fixture expected to split
to one equivalence key, maps a fixture expected to be equivalent to different
keys, or resolves an equivalent fixture to an output whose equivalence key
differs from the unanimous input key or that fails schema, validators, or
oracles. The fixture set must contain at least one expected split; equivalent
fixtures are required whenever `resolveEquivalent` can normalize distinct
representations.
`adjudication` is optional only when the class permits neither human-routing
action (`routeToHumanLowCost`, `routeToHumanUrgent`, or `routeToUrgent`), has no
`human_only` permit, `target === 1`, and no diversity rule can route a shortfall
to a human; otherwise registration requires it and validates the separate
restore threshold and the non-negative integer dispute-requeue cap.

### 4.3 Actions

```ts
type Action =
  | 'routeToHumanLowCost'     // escalate to a review queue
  | 'routeToHumanUrgent'      // escalate with priority
  | 'annotateDecisionRecord'  // record an observation that changes no behaviour
  | 'deprioritize'            // lower ranking, still reachable
  | 'routeToUrgent'           // raise urgency
  | 'updateRetrievalIndex'    // change what future work can find
  | 'selectCandidateSet'      // choose what later work considers
  | 'mutateCanonicalState'    // durable internal state: topic evidence, dedup keys
  | 'enqueueDerivedWork'      // create or shape a downstream job
  | 'suppress'                // withhold: duplicate, no material change
  | 'drop'                    // remove from the pipeline entirely
  | 'publish'

interface ActionAuthorization {
  authorizationRequestId: string
  effectIntentId: string
  effectIntentHash: string
  jobId: string
  inputHash: string
  decisionResultHash: string
  evidence: SubmissionEvidence[]
  resultAdjudicationVerdictHash?: string
  actionAdjudicationVerdictHash?: string
  contractVersion: string
  permitEpoch: string
  actions: Action[]
}

interface EffectIntentItem {
  action: Action
  descriptor: CanonicalJsonValue
}

interface EffectIntent {
  id: string
  effects: NonEmptyArray<EffectIntentItem>
}

interface SubmissionEvidence {
  leaseId: string
  resultHash: string
  workerSubject: WorkerSubject
}
```

**In a conforming consumer, every side effect maps to one *or more* actions with
complete descriptors. The consumer passes the complete effect intent to
`authorizeActions`, and every mapped gate must pass before core returns a bound
`ActionAuthorization` for the entire intent. There is no partial authorization:
one failed gate denies the whole request.** Revision 5 said "exactly one
action," which was
exploitable: a no-material-change path both writes topic evidence *and*
withholds the item, so
a consumer could declare only `mutateCanonicalState` — `deterministic_oracle`,
no completeness oracle needed — and never invoke `suppress` at all. One
behaviour, two effects, and the weaker gate wins. Composite effects now require
every applicable gate.

Muster owns that authorization decision and its audit record, not execution of
the effect. The consumer is trusted to reject absent, stale, mismatched, or
insufficient authorizations at the side-effect boundary and to request the
complete intent rather than a convenient subset (section 1.2). `JobClass.permits`
is an upper bound with an authorization mode per action; an authorization
request outside it is rejected.
`authorizeActions` takes a consumer-generated `EffectIntent`, unique to one
atomic side-effect transaction. Core enforces a transport cap, rejects duplicate
or unknown actions, sorts effects in stable `Action` enum order, and computes
`effect_intent_hash = SHA-256(JCS({ id, effects }))`. There is exactly one
authorization-request identity per globally unique `effect_intent_id`; it binds
the `decision_result_hash` and canonical intent hash. An exact retry returns the
byte-identical initial request receipt — pending, denied, or automatically
authorized as applicable — and consumes no second budget. A request denied at
submission binds its typed `AuthorizationDenialReason` in that receipt; a
request denied later, by a human rejection, keeps its `pending` initial receipt
and surfaces `human_rejected` through the status read — either way a budget
denial, a failed gate, an out-of-permit action, and a human rejection stay
distinguishable forever. A request that fails intent validation — the
transport cap, duplicate or unknown actions, effect-schema validation, or
`effect_descriptor_mismatch` — is a typed error that creates no
authorization-request record and claims no intent identity; only a well-formed
intent binds its ID. The request's current
state and an issued authorization's live validity are separate status reads and
may have changed since that receipt. A different decision or intent hash for
the same ID returns `authorization_conflict` and changes nothing. This lookup precedes result
expiry, permit, class-health, and effect-schema checks, so a lost response
remains retrievable; `getAuthorizationStatus` exposes any later invalidation.
Only a new intent validates each descriptor against its action
permit's closed `effectSchema`. A result may
support multiple genuinely separate intents — for example, routing a finding
for review and later recording an independently reached editorial decision.
The consumer remains trusted not to split one composite effect across invented
intent IDs to evade a gate; core cannot infer consumer transaction boundaries.

For an `automatic` permit, core also projects the declared effect-input paths,
runs `deriveEffect(input)`, and requires its canonical output to be
byte-identical to the proposed descriptor; otherwise it returns
`effect_descriptor_mismatch`. The consumer cannot use a verified result to
authorize parameters derived from undeclared or unsupported fields. A
human-only permit has no deriver: its reviewer sees and approves the exact stored
descriptor. As with consumer-authored oracles, fixtures and determinism are
executable evidence, not proof that a dishonest `deriveEffect` expresses the
intended semantics.

`effectIntentId` is also the consumer adapter's idempotency key. A conforming
side-effect boundary recomputes and matches `effectIntentHash`, then atomically
records or deduplicates the ID with execution of those exact descriptors. Core
guarantees one authorization record per intent, not exactly-once execution
inside a database or publisher it does not own.

The patterns that **always** include `suppress`, regardless of what else they
also do: no-material-change, duplicate determination, candidate omission,
deprioritization on a bounded surface, and any "last checked, nothing new"
update that reduces an item's future visibility.

**Derived work is an action.** `enqueueDerivedWork` covers a result that
creates or shapes a downstream job — the shape an earlier revision of the
first consumer's design used when extraction fed candidate retrieval and then
a materiality comparison. That consumer's current contract forbids the
dependency. It is
absence-affecting: an extraction that omits a claim means the downstream job is
never created, or is created with a narrowed payload, which is **suppression by
pipeline omission**. Support verification is not sufficient for it.

This is the seam left by removing staged work. The deferred spec recommends
that consumers compose multi-step behaviour from independently-gated one-shot
classes — so the composition itself must be gated, or removing staged work
merely moved the hole outside the library.

**Ranking is suppression on a bounded surface.** If `surface: 'bounded'` — a
top-N feed, a fixed-length digest — `deprioritize` is gated as `suppress`,
because pushing an item off a bounded surface withholds it in fact whatever it
is called.

### 4.4 Staged and effecting work

Not in v1. See `2026-08-04-muster-staged-and-effecting-design.md`, which records
three unsolved staged-work problems — transitive provenance through
coordinator-derived fields, oracle coverage contracts, and epoch semantics
across retries — plus the deferred effecting-work boundary: receipts are audit
records, and revision 7's trusted-consumer assumption does not itself define or
authorize external execution.

## 5. Protocol

### 5.1 Authentication

OAuth 2.1 authorization code flow with PKCE, completed in the provider's app.
Short-lived revocable tokens. Signature, issuer, audience, expiry, scope,
worker state, and rate limits validated on every call, in `muster-mcp`. No
model-provider credential is ever requested, stored, or transmitted.

### 5.2 Tools

Job surface, scope `jobs:*`:

```text
lease_job(availability)                     -> lease and sanitized batch, or no_work
submit_result(lease_id, input_hash, result) -> receipt or validation errors
abandon_job(lease_id, reason)               -> attempt receipt
extend_lease(lease_id)                      -> new expiry, or refusal
```

Worker surface, scope `worker:*`:

```text
get_worker_status()      -> coarse status, contract_version, skill_sha256,
                            coarse cap usage, next slot
set_availability(state)  -> active | maintenance
```

`availability` is a closed schema with exactly one field: a **coarse, monotonic
budget bucket** for this run. It carries nothing that maps to job content.

**Every `lease_id` is bound to the worker subject that holds it.** Submit,
abandon, and extend from any other subject are rejected regardless of token
validity.

### 5.3 The skill as a Resource

The generator's canonical output is the skill; the served Resource and the
per-provider hand-install packages are renderings of one source. SEP-2640, the
Resources-based Skills Extension, remains in review. Its current shape is
implemented only behind an explicitly experimental, versioned adapter and is
not frozen into Muster's stable public wire contract. Hand-install is the
normative v1 path until at least one target client proves compatible support;
the adapter may become normative after the extension and client behavior
stabilize.

The stable `get_worker_status` schema exposes the canonical skill hash, not a
Resource URI. The experimental adapter may expose its URI only in its own
versioned extension surface; disabling that adapter does not change the base
tool schema.

**A served skill is remote instruction text entering a member's agent.**
Releases are versioned and hash-pinned, the Resource carries its hash, results
record their `contract_version`, and a contract bump is a visible release,
never a live edit.

### 5.4 `input_hash`

SHA-256 over an RFC 8785 (JCS) canonicalization of *(ordered payload items, job
class, contract version, output schema, policy version, permit epoch)*.
Specified in `muster-contract` with golden vectors.

**Its property is payload and contract binding** — nothing more. Exact retries
are idempotent under section 6.5, but `input_hash` does not prove fresh
computation: a result body may be reused on a later lease for identical input.
It does not establish that the worker read the payload.

### 5.5 Job payload

The coordinator, never the worker, obtains and sanitizes source material.
Workers receive no user profiles, secrets, or view of the consumer's wider
state. Binary payloads are content-addressed blob references whose digests
enter `input_hash`. Per section 1.4, **everything in a payload is disclosed**;
the consumer decides what may go in one.

### 5.6 Contract lifecycle

`draft -> active -> draining -> retired`, with `lease_disabled_at` and
`accepted_until`. Queued jobs are re-emitted or explicitly migrated; open
leases under a draining version are honoured until `accepted_until`; validators
for draining versions stay loaded — dual-read is mandatory; canary sets are per
version; results after `accepted_until` are rejected as `contract_expired` and
classified as **coordinator fault**.

### 5.7 Side channels, and the limit

No tool argument names job content, but statistical channels exist and are
managed rather than denied.

| Channel | Mitigation |
|---|---|
| `availability` budget steering batch shape | Coarse monotonic buckets; job chosen **before** batch sizing |
| `no_work` reasons | Coarse to the worker; precise in the ledger |
| Repeated lease attempts | Rate-limited and bound to the assigned slot |
| Lease timing, response latency | Slot randomization; no timing-dependent selection |
| TTL, batch size | Quantized into buckets, not derived per payload |
| Payload byte size | Padded into buckets |
| Schema and policy version | Public by necessity; excluded from routing decisions |
| Source and language metadata | Minimized to what the task needs; `PrivacyClass` governs |
| Canary statistical oddities | Canaries drawn from real resolved work, not synthesized |
| `extend_lease` refusal shape | Uniform refusal; reason in the ledger |
| `submit_result` validation errors | Uniform error shapes to the worker; detail in the ledger |
| `get_worker_status` cap and slot data | Coarse buckets |
| Degraded and `no_work` frequency | Coarse; uncorrelated to queue composition |

**The limit, stated plainly.** Pre-lease selection is not expressible in the
protocol. **Post-lease withholding is unpreventable and, for sparse
contributors, undetectable.** A worker who dislikes a payload can abandon,
stall, or lie. Correlated selective abandonment is a monitored signal, but it
is a *population*-level signal: it can show that a cohort is behaving oddly
about a source or language, and it cannot convict a once-weekly contributor who
declines one batch a month. Section 1.4 records the consequence.

## 6. Mechanics

### 6.1 Lease

Authentication, worker state, contribution cap, then candidate selection — job
classes the worker's contract version supports, capability match against the
*enrolled* record, diversity constraints, exclusion of workers already on this
job, priority, `not_before` — then canary injection at rate `q`, then an
**atomic claim**, then a lease whose TTL is a quantized bucket from
`cost.leaseTtl`, floored so it cannot expire immediately after pickup.
`extend_lease` is bounded.

### 6.2 Replication diversity, typed by confidence

Every class declares `replication.target`. Each accepted replica must come from
a different worker subject, and the configured diversity rule must hold across
the set that reaches the target. `target: 1` is explicit rather than an implicit
default.

**Agreement is unanimous equivalence, never a vote.** Core computes
`agreement.equivalenceKey` independently for every accepted result. The target
agrees only when every canonical key is byte-identical. A majority, plurality,
or consumer-selected subset cannot convert disagreement into agreement. Only
after unanimity may `resolveEquivalent` normalize equivalent representations;
core recomputes its equivalence key and requires it to equal the unanimous input
key. Its output then reruns schema, validators, and oracles, and the audit record
retains every input result hash. Any non-unanimous set produces a `split`
outcome.
Mandatory `agreementFixtures` exercise equivalent representations and domain
pairs that must split; as with oracle fixtures, they are checked evidence at the
trusted-consumer boundary rather than proof that arbitrary consumer code
expresses the intended semantics.

**A split is absorbing for automatic agreement.** Once any accepted results
have different equivalence keys, retaining the dissent means no later superset
can be unanimous. Revision 8 nevertheless said another replica could resolve a
split, which was mathematically impossible unless core silently discarded an
accepted result or took a vote. Core does neither. It may request at most
`replication.maxSplitEvidenceReroutes` additional diverse replicas, one at a
time, solely to enrich the human-review record; each is appended to the split
evidence and can never restore automatic agreement. At the configured limit —
or immediately when the limit is zero — core creates a result-adjudication
request against the split-and-adjudication reserve. A diversity shortfall that
cannot reach the original target also goes directly to result adjudication.

Replicas sharing a model, provider, account cluster, or slot buy much less than
they appear to — but diversity is only as real as the axis is knowable, and
section 3.2 says self-reports are not attestation.

| Axis | Confidence | Usable in v1 |
|---|---|---|
| Assigned time slot | `attested` (coordinator-assigned) | yes |
| Provider | `observed` (OAuth issuer and surface) | yes |
| Account cluster | `observed` (subject) | yes, weakly |
| Language coverage | `observed` (enrollment probe) | yes |
| Model family | `self_reported` or `unknown` | **no** |

**Only `attested` and `observed` axes satisfy a diversity requirement;
`unknown` never counts as diverse.** A class requiring model-family diversity
is refused at registration. When diversity cannot be satisfied the coordinator
**escalates rather than pretending**: the shortfall is recorded as
`diversity_shortfall`, not as a met target.

### 6.3 Verification strength and action gates

```ts
type AutomaticVerificationStrength =
  | 'structural_only'
  | 'deterministic_oracle'

type VerificationStrength =
  | AutomaticVerificationStrength
  | 'human_adjudicated'
```

| Strength | Meaning |
|---|---|
| `structural_only` | schema, size, hash, enums |
| `deterministic_oracle` | plus passing deterministic evidence whose declared payload and result coverage meets the relevant requirement |
| `human_adjudicated` | an action gate satisfied by a bound human verdict before the result is acted on; never an automatic result strength |

`JobClass.verification` is the minimum automatic floor required before a result
may become `verified`; core derives the achieved strength from evidence and
never accepts a caller-supplied strength. A deterministic floor is met only when
the class's `resultEvidenceRequirement` passes section 6.7's coverage check and
the covering oracle succeeds at runtime. Action gates are evaluated separately:
each deterministic action must satisfy its own `ActionEvidenceRequirement`, so
an oracle over one harmless field cannot authorize a different decision. Human
adjudication augments a particular action request and is never stamped as a
reusable class-wide or result-wide strength.

Canaries provide sampled evidence about a worker over time. They do **not**
increase the verification strength of an ordinary result and never authorize a
result action. Canary outcomes affect worker state, suspicion, reputation, and
routing only.

Gates are ordered by **fail-safe direction**: actions that increase human
attention need less verification, actions that reduce visibility need more,
because a wrong suppression is invisible while a wrong escalation is expensive.

| Action | `automatic` gate | Mode rule and additional constraint |
|---|---|---|
| `annotateDecisionRecord` | `structural_only` | Must change no behaviour |
| `routeToHumanLowCost` | `structural_only` | **Budgeted** — section 6.4 |
| `routeToHumanUrgent` | `deterministic_oracle` | Budgeted, tighter quota |
| `deprioritize` | `deterministic_oracle` | Gated as `suppress` when `surface: 'bounded'` |
| `routeToUrgent` | `deterministic_oracle` | Costs attention, but can consume scarce urgent capacity |
| `updateRetrievalIndex` | `deterministic_oracle` **with a completeness oracle** | Changes what future work can find; reduced recall is invisible |
| `selectCandidateSet` | `deterministic_oracle` **with a completeness oracle** | Recall, not just precision |
| `enqueueDerivedWork` | `deterministic_oracle` **with a completeness oracle** | Omission here suppresses by pipeline |
| `mutateCanonicalState` | `deterministic_oracle` | `human_only` required at `high`+; durable and hard to unwind |
| `suppress` | `deterministic_oracle` **with a completeness oracle** | `human_only` required at `high`+; reversible and logged |
| `drop` | unavailable | `human_only` at every consequence; irreversible loss |
| `publish` | `deterministic_oracle`, consequence ≤ `material` | `human_only` required at `high`+ |

An operator may choose the stronger `human_only` mode for any action; the table
marks where it is mandatory. A human-only approval directly judges the exact
`reviewRequirement` predicate against its bound payload, result, and effect
paths, submission evidence, and required absence domain when applicable. It
therefore does not borrow an automatic support or completeness verdict. It
remains bound to this action request and cannot raise the reusable result
strength.

Every `automatic` action with a `deterministic_oracle` gate must carry a
matching `ActionEvidenceRequirement`. Every automatic action additionally
marked "with a completeness oracle" is **absence-gated** and must also carry a
matching `AbsenceRequirement` (section 6.7). A deterministic support oracle
satisfies no absence requirement. A `human_only` permit carries neither action
requirement; its bound `reviewRequirement` and human verdict are the gate.

A class permitting nothing is legitimate and useful — triage and extraction
evidence feeding downstream checks is what volunteer work is good for — but
"permits nothing" means the consumer must not act on it, including by
withholding or by writing internal state. The conformance obligation is on the
consumer boundary described in section 1.2.

### 6.4 Escalation is budgeted, because human capacity is a safety resource

Revision 4 made `routeToHuman` always permitted at `structural_only`, reasoning
that escalation is the fail-safe direction. **That was a denial-of-service
channel**: a worker flooding structurally valid junk into the review queue
exhausts adjudication, which under section 6.6 stops intake — and for a news
consumer, silently ages the feed.

So escalation is budgeted — but a single pooled budget merely converts a flood
attack into buried urgency, which is the same integrity failure wearing a
different hat. Budgets are therefore **separate reserves that cannot borrow
from each other**:

```ts
interface EscalationReserves {
  lowCostPerWeek: number        // routine review queue
  urgentPerWeek: number         // routeToHumanUrgent and routeToUrgent
  splitAndAdjudicationPerWeek: number   // core-routed split and human gates only
  auditPerWeek: number          // reserved for retrospective checks
  perWorkerLowCostQuotaPerWeek: number
  perWorkerUrgentQuotaPerWeek: number
}
```

Registration rejects negative reserves, an adjudication requirement below the
sum of `lowCostPerWeek`, `urgentPerWeek`, and
`splitAndAdjudicationPerWeek`, or an audit reserve below the class's configured
retrospective audit projection.

A worker exceeding either quota has further escalations in that lane denied and
its suspicion raised — flooding costs the flooder first. Low-cost work never
spends a worker's urgent quota. Exhausting the low-cost reserve sets
`health.reserves.lowCost = 'saturated'`; further routine escalations return
`escalation_budget_exhausted`, create no review work, and fire
`onLowCostUncovered`. It does not stop ordinary intake. A deployment may retain
a bounded diagnostic sample of rejected requests, but it must not turn reserve
overflow into an unbounded human-review backlog.

Quota attribution is deterministic. For a single result, charge its worker; for
a unanimously equivalent replica set, charge every contributing worker once in
the relevant lane, so colluders cannot hide behind replication. A
human-resolved result dispute consumes the split-and-adjudication reserve but
does not charge later action escalation to every candidate worker: adjudication
may establish which evidence was false, and section 6.8 applies individual
reputation from that verdict. Class reserve accounting always applies exactly
once per action request.

**Exhausting the urgent reserve fails closed, not quietly.** The class refuses
new enqueues because urgency is not known until the result exists,
`onUrgentUncovered` fires as an operator alert, and
`health.reserves.urgent = 'saturated'`. While the reserve is saturated, an
authorization request from existing in-flight work whose intent includes
`routeToHumanUrgent` or `routeToUrgent` is denied atomically with
`escalation_budget_exhausted`: it creates no review work, fires
`onUrgentUncovered`, and may be retained in the bounded diagnostic sample. The
denial is that effect intent's immutable terminal receipt. After the accounting
window rolls over or the operator raises the reserve, the consumer presents a
fresh effect intent — a legitimate new request under section 4.3, not gate
evasion, because the denied intent reached a terminal state. An attacker can
still deny urgent capacity, but they cannot do it silently, and they cannot
reach the split, adjudication, or audit reserves at all.

Exhausting the split-and-adjudication reserve leaves affected result disputes
in `pending_result_adjudication` and affected action requests in
`pending_adjudication`, refuses new class enqueues, and fires
`onAdjudicationUncovered`; it never converts a split into agreement. Exhausting
the audit reserve refuses new class enqueues and fires `onAuditUncovered`,
because continuing intake while the declared retrospective audit rate is
unfunded would silently lower the class's worker-drift control. Neither reserve
may borrow from low-cost or urgent capacity.

Escalation is still the safest direction. It is no longer free, and it can no
longer be spent by an attacker on the operator's behalf.

### 6.5 Verification pipeline, cheapest first

1. Authenticate the subject, load the lease, and require that the lease belongs
   to this subject. A revoked token cannot retrieve a receipt.
2. Enforce `maxResultBytes`, canonicalize the submitted JSON, and compute
   `result_hash`. The ceiling comes from the immutable lease contract snapshot,
   not the current class policy, and a transport hard cap applies before parsing.
   This requires no contract validator, so exact retries remain recognizable
   after a draining validator is unloaded. An uncanonicalizable body is
   structurally invalid and has no result hash.
3. Already accepted submission for this lease? The same `input_hash` and
   `result_hash` returns the byte-identical receipt and appends nothing,
   regardless of the lease's current open, expiry, contract, health, or permit
   state. Any different hash returns `submission_conflict`, appends no result,
   and raises suspicion. This lookup precedes every terminal-state check so a
   lost response remains safely retryable.
4. With no accepted submission, require the submitted `input_hash` to equal the
   lease binding. A mismatch is `input_hash_mismatch`, appends nothing, and
   raises suspicion. A server-known incompatible contract is a distinct
   `contract_mismatch` coordinator fault detected before leasing or by explicit
   result-contract metadata.
5. Apply section 6.6's precedence and require the
   lease to remain open.
6. Structural: output schema, size, and enumerations.
7. Validators, deterministic and I/O-free.
8. Oracles and their declared coverage (section 6.7). Derive the achieved
   automatic verification strength; reject a result that misses its class floor.
9. Canary: compared to a known answer, never surfaced to the consumer and never
   raises that result's verification strength.
10. When `replication.target` is met with diversity satisfied, apply unanimous
   equivalence (section 6.2), or use the single accepted result when
   `target === 1`. The resolved output reruns schema, validators, oracles, and
   coverage checks; it never inherits their verdicts from its inputs. A split
   may collect at most `replication.maxSplitEvidenceReroutes` additional diverse
   results as human-review evidence, but remains a split and then creates a
   `ResultAdjudicationRequest` against its reserved budget. No
   `decision_result_hash` or action-authorization request exists yet.
11. A unanimous result, or a human-resolved result dispute, gets
    `decision_result_hash = SHA-256(JCS({ result, evidence,
    result_adjudication_verdict_hash? }))`, where `evidence` is the
    `SubmissionEvidence` set sorted bytewise by `leaseId`. Mark it `verified`;
    verification alone authorizes no action.
12. A conforming consumer calls `authorizeActions(decision_result_hash,
    effect_intent)`. Core canonicalizes and hashes the intent and first applies
    section 4.3's exact-retry/conflict rule. For a new request only, it applies
    section 6.6's precedence and maximum in-flight lifetime, validates every
    action descriptor, rejects actions outside `JobClass.permits`, and evaluates
    the full set atomically, including every automatic action-specific evidence
    and absence requirement. If any automatic gate fails, deny the whole
    request. If any permit is `human_only`, create a bound
    `pending_adjudication` authorization request and issue no authorization.
13. Otherwise return an `ActionAuthorization` for the exact requested set,
    effect intent, evidence, and stamped permit epoch. A human-approved
    authorization additionally binds `action_adjudication_verdict_hash`.

**The submission receipt is immutable acceptance facts, nothing else.**

```ts
interface SubmissionReceipt {
  leaseId: string
  jobId: string
  inputHash: string
  resultHash: string
  contractVersion: string
  permitEpoch: string
  outcome: 'accepted'
  acceptedAt: Timestamp
}
```

Step 3 replays this receipt byte-identically regardless of the lease's later
state, so it may carry only facts fixed at acceptance. It never carries canary
status — that would open the side channel section 5.7 closes — nor verification
strength, replication progress, agreement outcome, or adjudication state, all
of which change after acceptance and would make byte-identical replay a lie.
The result's current state is a separate status read, exactly as an
authorization's immutable initial receipt is separate from its live validity
(section 6.6). Validation failures are a separate typed error path, not
receipts; only the accepted submission replays.

### 6.6 Class health, adjudication, and permit epochs

Class health is a **required surface**, not merely an event — revision 4 emitted
`onAdjudicationStarved` and left it to the consumer to notice, which lets a
stale product look healthy. Saturation is multidimensional because all four
reserves can exhaust independently:

```ts
interface ClassHealth {
  operating:
    | 'ready'
    | 'adjudication_starved'
    | 'admission_halted'
    | 'emergency_halted'
  reserves: {
    lowCost: 'available' | 'saturated'
    urgent: 'available' | 'saturated'
    splitAndAdjudication: 'available' | 'saturated'
    audit: 'available' | 'saturated'
  }
}

type ResultState =
  | 'collecting'
  | 'pending_result_adjudication'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'cancelled'

type ResultAdjudicationRequestState =
  | 'pending_result_adjudication'
  | 'resolved'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'cancelled'

type AuthorizationRequestState =
  | 'pending_adjudication'
  | 'authorized'
  | 'denied'
  | 'expired'
  | 'superseded'
  | 'cancelled'

type AuthorizationInvalidationReason =
  | 'emergency_halted'
  | 'emergency_permit_withdrawal'
  | 'contract_expired'
  | 'max_in_flight_exceeded'
  | 'operator_cancelled'

type AuthorizationDenialReason =
  | 'permit_rejected'               // action outside JobClass.permits
  | 'gate_failed'                   // an automatic evidence or absence gate failed
  | 'escalation_budget_exhausted'   // a budgeted lane was saturated or over quota
  | 'human_rejected'                // an ActionAdjudicationVerdict rejected it

type AuthorizationValidity =
  | { kind: 'valid' }
  | {
      kind: 'invalid'
      reason: AuthorizationInvalidationReason
      invalidatedAt: Timestamp
    }

type AuthorizationStatus =
  | { state: 'authorized'; validity: AuthorizationValidity }
  | { state: 'denied'; reason: AuthorizationDenialReason }
  | {
      state: Exclude<AuthorizationRequestState, 'authorized' | 'denied'>
    }

interface AdjudicationCapacity {
  classId: string
  availableReviewsPerWeek: number
  observedAt: Timestamp
}

interface ResultAdjudicationRequest {
  id: string
  reason: 'split_exhausted' | 'diversity_shortfall'
  jobId: string
  inputHash: string
  candidateResultHashes: string[]
  evidence: SubmissionEvidence[]
  contractVersion: string
  permitEpoch: string
}

interface ResultAdjudicationVerdict {
  kind: 'human'
  resultAdjudicationRequestId: string
  reason: 'split_exhausted' | 'diversity_shortfall'
  jobId: string
  inputHash: string
  candidateResultHashes: string[]
  evidence: SubmissionEvidence[]
  contractVersion: string
  permitEpoch: string
  adjudicatorId: string
  decision:
    | { kind: 'resolve'; result: CanonicalJsonValue }
    | { kind: 'reject' }
  decidedAt: Timestamp
}

interface HumanActionReviewRequirement extends HumanReviewRequirement {
  action: Action
}

interface ActionAdjudicationRequest {
  authorizationRequestId: string
  jobId: string
  effectIntent: EffectIntent
  effectIntentHash: string
  inputHash: string
  decisionResultHash: string
  evidence: SubmissionEvidence[]
  resultAdjudicationVerdictHash?: string
  contractVersion: string
  permitEpoch: string
  humanReviews: NonEmptyArray<HumanActionReviewRequirement>
}

interface ActionAdjudicationVerdict {
  kind: 'human'
  jobId: string
  authorizationRequestId: string
  effectIntentId: string
  effectIntentHash: string
  actions: Action[]
  inputHash: string
  decisionResultHash: string
  evidence: SubmissionEvidence[]
  resultAdjudicationVerdictHash?: string
  contractVersion: string
  permitEpoch: string
  adjudicatorId: string
  decision: 'approve' | 'reject'
  decidedAt: Timestamp
}

interface AdjudicationSource {
  capacity(classId: string): AdjudicationCapacity
  authenticate(
    verdict: ResultAdjudicationVerdict | ActionAdjudicationVerdict
  ): boolean
}
```

`verified` is final for result collection and dispute resolution, but it is not
permanently eligible for new action requests. A higher-precedence expiry,
withdrawal, halt, or cancellation may later move the parent result to
`expired`, `superseded`, or `cancelled` for future intents without changing its
decision hash or the historical state of an authorization already issued from
it.

`getClassHealth(classId)` returns `ClassHealth`. A capacity snapshot older than
`adjudication.capacityMaxAge` counts as zero capacity and fails closed.
Core combines that supply snapshot with its own rolling adjudication demand and
backlog age. The operating dimension becomes `adjudication_starved` when supply
stays below `requiredRatePerWeek` or rolling admitted demand exceeds reported
supply for `starvationDwell`, or when the oldest pending review itself exceeds
`starvationDwell`. A fresh supply assertion cannot hide an aging backlog.

| Dimension | Meaning and intake effect |
|---|---|
| `operating: 'ready'` | Normal for the operating dimension |
| `operating: 'adjudication_starved'` | Capacity or backlog coverage remained unsafe for `starvationDwell`; refuse every new job of this class |
| `operating: 'admission_halted'` | Pool offline or operator paused admission; refuse new jobs and leases, while valid in-flight work may complete |
| `operating: 'emergency_halted'` | Operator kill switch; reject new work and invalidate affected in-flight work under the explicit operator policy |
| `reserves.lowCost: 'saturated'` | Deny excess routine escalations, retain only a bounded diagnostic sample, fire `onLowCostUncovered`; intake continues |
| `reserves.urgent: 'saturated'` | Refuse new class enqueues; urgency may be result-derived and is not safely knowable at enqueue time; fire `onUrgentUncovered` |
| `reserves.splitAndAdjudication: 'saturated'` | Refuse new class enqueues; keep affected in-flight results pending; fire `onAdjudicationUncovered` |
| `reserves.audit: 'saturated'` | Refuse new class enqueues rather than lower the declared audit rate; fire `onAuditUncovered` |

A consumer that does not read every class-health dimension is expected to fail
loudly, so the conformance kit asserts that the consumer surfaces operating
failures and every reserve state.

**Result-dispute adjudication lifecycle.** A split that exhausts its configured
evidence reroutes, or a diversity shortfall that cannot reach the declared
target, moves the result from
`collecting` to `pending_result_adjudication`. Core creates a
`ResultAdjudicationRequest`, emits `onResultAdjudicationRequested`, and creates
neither a verified result nor an action request. An authenticated human verdict
must bind the request ID, reason, job, `input_hash`, complete ordered candidate
result-hash and `SubmissionEvidence` sets, contract version, permit epoch,
adjudicator, decision, and timestamp. A resolution may supply a canonical
result or reject the set. A supplied result reruns schema, validators, and
oracles, derives achieved strength, and must meet the class floor before core
hashes the verdict and decision result; failure rejects the dispute. Candidate
hashes must be unique, sorted canonically, and equal the
result-hash projection of the evidence set. Result adjudication does not satisfy
a later human action gate.

A rejection is terminal for those candidates and never converts into
agreement: the request moves to `rejected` and the parent result to `rejected`
with it. The job is then requeued under the current epoch and re-gated from
scratch, as after a maximum in-flight expiry, so a bad candidate set costs the
work a retry rather than the pipeline an item. Section 6.8 applies any
adjudicated falsehood the verdict established to the contributing workers.

**Rejection requeues are bounded per logical job.** Each dispute cycle spends
the split-and-adjudication reserve, so an unbounded reject-and-requeue loop
would burn the scarcest safety resource on one item forever. A job may be
requeued after a rejected dispute at most
`adjudication.maxRejectedDisputeRequeues` times. A rejection beyond that cap
does not requeue: the job terminates with its result `rejected`, core fires
`onDisputeRequeueExhausted`, and an operator who still wants the work enqueues
a new job under the current epoch. Exhaustion is a job outcome, not a worker
one — attempt classification (section 6.9) is unchanged, and reputation still
moves only through section 6.8's adjudicated-falsehood paths.

The first authenticated verdict atomically resolves or rejects the request and
gets `result_adjudication_verdict_hash = SHA-256(JCS(verdict))`. Replaying that
exact canonical verdict returns the byte-identical receipt and changes nothing;
any different verdict for the request returns `verdict_conflict`. An exact retry
cannot consume capacity twice or move the request through a second terminal
transition.

**Action-adjudication lifecycle.** A verified result stays verified while its
action request is pending unless a higher-precedence condition invalidates it.
When an `authorizeActions` request includes a `human_only` permit, that
authorization request moves to `pending_adjudication`; core emits
`onActionAdjudicationRequested` and returns no `ActionAuthorization`. An
`ActionAdjudicationRequest` uses the same `authorizationRequestId` as the
pending authorization record and retains the full canonical effect intent and
hash, all result/evidence bindings, and the exact review requirement for each
human-only action. The reviewer resolves payload and result bodies through the
bound job and decision records rather than caller-supplied copies, and the
review surface must present every required effect path from the stored
descriptor. An
authenticated `ActionAdjudicationVerdict` must bind the authorization-request
ID, effect-intent ID and hash (whose stored canonical descriptors are shown to
the reviewer), exact action set, job, `input_hash`, `decision_result_hash`,
ordered `SubmissionEvidence` set, optional result-adjudication verdict hash,
contract version, permit epoch, adjudicator identity, verdict, and timestamp.
For an absence-affecting action, the request and review surface also bind the
declared `requiredAbsenceDomain`; reviewing only the worker-returned candidates
does not satisfy it. An accepted
approval evaluates all remaining mapped gates and moves the request to
`authorized`; a rejection moves it to `denied`. One verdict cannot authorize a
different action set. The canonical verdict is hashed as
`action_adjudication_verdict_hash = SHA-256(JCS(verdict))` and the hash enters
the resulting authorization. Its exact retry returns the byte-identical receipt
without spending capacity again; a different verdict for the request returns
`verdict_conflict`.

`resultAdjudicationVerdictHash` is conditionally optional in the wire type: it
must be present and equal the decision result's bound verdict hash when a human
resolved the result dispute, and must be absent otherwise. Core applies that
rule to `ActionAdjudicationRequest`, `ActionAdjudicationVerdict`, and
`ActionAuthorization`; callers cannot strip result-dispute provenance by
omitting the field. Likewise,
`actionAdjudicationVerdictHash` is required on an authorization produced by a
human approval and absent on an automatically authorized action set.

**Invalidation is a state transition, not a timestamp convention.** Contract
expiry or maximum in-flight lifetime moves every affected pending request and
its parent result to `expired`, including a verified result that remained
eligible to support a new intent. Emergency permit withdrawal moves every
affected pending request and verified result from the withdrawn epoch to
`superseded`; explicit operator cancellation moves affected work to
`cancelled`. Existing authorization records retain their historical state and
receive the separate validity transition described below; all pending action
requests for the same affected result transition atomically.
Worker revocation cancels only work still dependent on that worker's open lease;
previously accepted evidence remains valid. The transition and any requeue are
atomic. Every adjudication or authorization request in a terminal state rejects
later verdicts except the byte-identical retry of the verdict that produced it,
and a request can reach only one terminal state. Core emits the transition, so
"stale" never depends on consumer inference.

`AdjudicationSource` also reports a capacity snapshot per class. This is an
operator assertion at the trusted-consumer boundary, not proof that a reviewer
will act. Both verdict interfaces above are human-only, and only an
authenticated human verdict satisfies a `human_adjudicated` action gate.
Deterministic oracles, completeness oracles, held-out canaries, and published
corrections may establish reputation outcomes through section 6.8's separate
evidence paths; they are never action-adjudication verdicts and cannot
impersonate human review. Registration requires
`AdjudicationPolicy` under every condition in section 4.2, so a class that may
need a human cannot silently omit its capacity contract.

Restoration from `adjudication_starved` requires capacity above a **separate,
higher threshold** (hysteresis), rolling demand covered, backlog age below the
dwell threshold, **and an explicit operator action**. The health gate is not
cleared automatically. Flooding ambiguous items therefore stops a class visibly
rather than quietly lowering its bar. Escalation saturation clears only when
its non-borrowable accounting window rolls over or an operator explicitly
increases that reserve; clearing one reserve never clears another.

**Permit epochs.** Permits are versioned; every result stamps the epoch it
resolved under. Work created under epoch `E` — including bounded
split-evidence reroutes and requeues after lease expiry — completes under `E`,
up to a declared maximum in-flight lifetime; past that it is requeued under the
current epoch and
re-gated from scratch. New work always uses the current epoch. An epoch change
never retroactively re-grants or revokes what an earlier epoch stamped.

Higher-precedence invalidation does not rewrite an issued authorization's audit
history. Emergency halt, emergency permit withdrawal, contract expiry, maximum
in-flight expiry, or explicit operator cancellation instead marks its separate
validity `invalid` with the typed reason and timestamp; the historical request
record remains `authorized`. A conforming consumer calls
`getAuthorizationStatus(authorizationRequestId)` at the side-effect boundary
and refuses an authorization invalidated after issue. Core cannot undo an
effect already performed. An ordinary permit-epoch change does not invalidate
an older authorization; emergency withdrawal is the explicit epoch exception.
Exact submission retries still return their original receipts and never create
new evidence.

The validity lookup and consumer effect need a shared transaction or equivalent
permit-generation fence to exclude a concurrent invalidation. Where an external
surface cannot provide that fence, core guarantees that later lookups report the
invalidation but cannot prevent the narrow check-then-effect race; that limit is
part of the trusted-consumer boundary, not an emergency-revocation guarantee.

**Precedence**, because epochs, contract draining, and class health can all
apply at once and the outcome must not depend on evaluation order. Highest
authority first:

| # | Condition | Effect |
|---|---|---|
| 1 | Lease holder becomes `revoked`/`suspended` | Reject that holder's still-open leases and requeue their work; unrelated workers and previously accepted evidence remain valid |
| 2 | Queue or class `emergency_halted` | Reject and atomically cancel every affected result for future intents and all pending adjudications, and invalidate issued authorizations for future use, under the recorded operator policy; nothing new completes |
| 3 | Explicit operator cancellation | Cancel every selected result for future intents and its pending adjudications, invalidate its issued authorizations for future use, and apply the recorded requeue policy atomically |
| 4 | Operator **emergency permit withdrawal** | Supersede pending adjudications and every verified result stamped with the withdrawn epoch for future intents, including a result that already authorized a different intent; invalidate issued authorizations from that epoch for future use; reject and requeue collecting results under the current epoch. This is the one epoch change that reaches in-flight work |
| 5 | Contract `accepted_until` passed | Expire every affected result for future intents and all pending states, and invalidate issued authorizations for future use; `contract_expired`, coordinator fault (section 6.9) |
| 6 | Max in-flight lifetime exceeded, including either pending-adjudication phase | Expire every affected result for future intents and all pending states, invalidate issued authorizations for future use, requeue under the current epoch, and re-gate from scratch |
| 7 | Queue or class `admission_halted` | Refuse new enqueue and lease; valid in-flight submissions and verdicts may complete |
| 8 | `health.operating: 'adjudication_starved'` | Refuse every **new** enqueue for the class; split-evidence reroutes and expiry requeues of existing work proceed |
| 9 | `health.reserves.splitAndAdjudication: 'saturated'` or `health.reserves.audit: 'saturated'` | Refuse every new class enqueue; existing work remains pending or completes without lowering a gate |
| 10 | `health.reserves.urgent: 'saturated'` | Refuse every new class enqueue because urgency may be result-derived; existing-work reroutes proceed; an in-flight authorization request including an urgent-lane action is denied with `escalation_budget_exhausted` (section 6.4) |
| 11 | `health.reserves.lowCost: 'saturated'` | Continue intake; deny overflow routine escalation and fire `onLowCostUncovered` |
| 12 | Permit epoch | Gate under the stamped epoch |

Rule 8 is the one most likely to be got wrong: starving a class must not strand
work already in flight, or an attacker who triggers starvation also destroys
the partially verified work in the queue. Rules 9–11 must not be collapsed into
one generic saturation state.

### 6.7 `OracleSpec`

```ts
interface OracleSpec<Payload, Result> {
  id: string
  kind: 'support' | 'completeness'
  run(payload: Payload, result: Result): OracleVerdict   // deterministic, no I/O
  coversPayloadPaths: JsonPath[]    // payload fields it actually examines
  coversResultPaths: JsonPath[]     // result fields whose claims it checks
  absenceDomain?: AbsenceDomain     // completeness only: the universe it can detect omissions over
  negativeFixtures: NonEmptyArray<Fixture> // cases the oracle MUST fail
}

interface AbsenceDomain {
  id: string                             // label for humans and audit records
  payloadPaths: NonEmptyArray<JsonPath>  // the universe, as payload paths
}

interface EvidenceRequirement {
  predicate: string
  requiredPayloadPaths: JsonPath[]
  requiredResultPaths: JsonPath[]
}

interface ActionEvidenceRequirement extends EvidenceRequirement {
  action: Action
}

interface AbsenceRequirement extends EvidenceRequirement {
  action: Action
  requiredDomain: AbsenceDomain
}
```

A **support** oracle confirms that what a result asserts is grounded in the
payload. A **completeness** oracle answers whether anything material in the
payload is *missing* from the result. Every **automatic** decision about absence
— suppression, `selectCandidateSet` recall — requires the latter; a
`human_only` permit instead binds the exact review requirement and required
absence domain.

Rules that make the distinction machine-checked at registration and runtime:

- **The result or action declares what must be supported, not the oracle.** A
  class-wide `deterministic_oracle` label is not evidence. Registration requires
  one `resultEvidenceRequirement` for a deterministic result floor and one
  `ActionEvidenceRequirement` for each `automatic` permit with a deterministic
  gate. A `human_only` permit has no action evidence requirement. Registration
  refuses the class unless a registered **support** oracle's
  `coversPayloadPaths` and `coversResultPaths` are supersets of the requirement's
  paths. At runtime, that covering support oracle must pass for the particular
  result. A completeness verdict does not establish that asserted claims are
  supported. Requirements are keyed uniquely by action; omissions, duplicates,
  and requirements for absent or human-only permits are registration errors.
- A support oracle **never** satisfies a gate concerning absence.
- **An absence domain is a canonical value with a mechanical coverage rule.**
  Domain identity is canonical (JCS) equality over the closed structure above;
  `id` labels the domain for humans and audit records and carries no matching
  semantics. A completeness oracle's `absenceDomain` covers an
  `AbsenceRequirement.requiredDomain` iff every required payload path equals or
  is a path-extension of one of the oracle domain's paths — plain path
  containment, never semantic inference. The same canonical value is what a
  `human_only` permit binds as `requiredAbsenceDomain` and what the review
  surface presents. Declaring a domain is a claim the oracle code must honour:
  registration checks containment, path existence in the frozen payload schema,
  and negative fixtures, not real-world meaning — the trusted-consumer boundary
  again.
- A human-only `reviewRequirement` is not oracle coverage. Registration checks
  that its payload and result paths exist in the frozen schemas, that its
  `requiredEffectPaths` cover every effect-schema leaf, and that an
  absence-affecting action binds the relevant
  `requiredAbsenceDomain`. Core includes the exact requirement in the
  adjudication request, the review surface presents those paths from the stored
  descriptor, and the authenticated human is trusted to inspect and decide it.
- A completeness oracle satisfies an absence gate only for paths inside
  `coversPayloadPaths ∩ absenceDomain.payloadPaths`, and only when its `coversResultPaths`
  also cover the result fields named by the requirement. Outside that scope the
  gate is unmet, so a "completeness oracle" that only inspects the candidates
  the worker happened to return covers nothing and clears nothing.
- **Absence is an additional requirement, not a stronger label.** Bounding what
  an oracle may clear is not enough on its own: a consumer could register a
  genuine completeness oracle over a trivial domain and then treat "has a
  completeness oracle" as satisfying the gate. Every automatically
  absence-gated action therefore declares both its ordinary
  `ActionEvidenceRequirement` and an `AbsenceRequirement` naming the predicate,
  payload paths, result paths, and required domain. Registration requires a
  covering support oracle for the ordinary requirement and a covering
  completeness oracle for the absence requirement; runtime requires both to
  pass. A human-only adjudicator inspects absence directly and uses neither.
- **Negative fixtures are mandatory**, and must include both out-of-domain
  cases and unsupported-assertion or omitted-material cases for every predicate
  the oracle covers. An oracle registered without cases it is expected to fail
  is presumed to check nothing and is refused. The conformance kit runs them.
- These checks establish executable evidence, not a proof of arbitrary oracle
  code. They cannot establish that a consumer-authored predicate captures the
  intended real-world semantics or that a dishonest consumer did not special
  case fixtures. Oracle correctness remains part of the trusted-consumer
  boundary; independent held-out fixtures and mutation tests are recommended
  whenever the domain supports them.
- Model-derived advice is not an `OracleSpec`. A consumer may run it outside
  Muster and retain its own provenance, but it never changes verification
  strength or satisfies an automatic action gate. A consumer that requests an
  action after such advice still has to satisfy that action's ordinary Muster
  gate from the verified result and declared deterministic evidence.

### 6.8 Reputation

Unadjudicated disagreement never moves reputation. **Adjudicated falsehood
does**, where authenticated human review or core-verified deterministic or
completeness-oracle evidence, a held-out canary, or a published correction
establishes which side was wrong. These reputation evidence paths are distinct
from the human-only verdict types in section 6.6. Structural failures, validator
failures, canary failures, post-payload abandonment, and escalation-quota abuse
move reputation directly.
Drift metrics are tracked from day one and do not affect routing until an
explicit gate turns them on.

These source kinds are sufficient for reputation only. As section 6.6 requires,
only an authenticated human verdict satisfies `human_adjudicated` for an action
authorization.

Reputation is a routing signal, never proof of truth.

### 6.9 Fair-attempt classification

| Outcome | Counts for contribution | Raises suspicion |
|---|---|---|
| `no_work`, any reason | yes | no |
| success | yes | no |
| coordinator error, outage, `contract_expired` | yes | no |
| provider quota or platform failure | yes | no |
| rejected as invalid | no | yes |
| abandoned before payload | no | no |
| abandoned after payload | no | yes |
| lease expired with no coordinator fault | no | yes |

Worker-reported reasons are hints; where the server can corroborate, the
server's view wins. Muster owns the ledger; **eligibility policy is the
consumer's**.

### 6.10 Abuse economics

Lease attempts rate-limited and slot-bound; extensions capped per lease and per
window; post-payload abandonment penalized and pattern-correlated; escalation
quotas per worker; contribution-cap changes rate-limited and effective at the
next slot; repeated `no_work` probing beyond the assigned slot throttled before
it is answered.

### 6.11 Canary and audit sources

Three rates: **probation `q`** (high, small batches, until enrollment clears);
**production `q`** (steady state, chosen against the detection curve and the
class's tolerated bad-output count); **audit `q`** (retrospective
re-verification — the only mechanism catching a worker who was good and became
bad).

| Audit source | May move reputation directly |
|---|---|
| Held-out canary | yes |
| Deterministic or completeness oracle | yes |
| Human audit | yes |
| Independent worker audit | **no** — escalates only, and requires diversity |

Probation counts **checked** successes only.

### 6.12 Capacity and degraded modes

`projectCapacity({ W, B, q, R_avg })` returns effective, not nominal,
throughput: `W` active workers, `B` items per batch, `q` the combined canary
and audit fraction, `R_avg` the mean replication factor derived from configured
targets plus measured split-evidence reroutes. Canary and replicated runs
produce no net output by design.

| Mode | Condition | Behaviour |
|---|---|---|
| `normal` | within SLA against projected capacity | full intake |
| `degraded` | aging beyond SLA, or capacity below threshold | intake throttled, low-priority jobs expire early, urgent prioritized, `onBackpressure` |
| `admission_halted` | pool offline or operator pauses admission | `enqueue` refuses; `lease_job` returns coarse `no_work`; valid in-flight work may complete; `onPoolOffline` when applicable |
| `emergency_halted` | explicit operator kill switch | refuse new work and apply the recorded cancellation policy to in-flight and pending work |

Per-class health (section 6.6) is orthogonal and can apply while the queue is
`normal`. Pool-offline detection is by absence of expected slot arrivals, not a
heartbeat workers pay for.

## 7. Observability, privacy, retention

An append-only event schema — enrollment, lease, extend, submit, verdict, gate
decision, escalation, adjudication, state change, permit epoch change, contract
transition — and metrics dimensioned by worker, provider, job class, and
contract version: lease latency, expiry rate, split rate, canary failure, audit
failure, validator failure, duplicate-lease count, agreement clustering,
diversity shortfall, escalation budget consumption, adjudication backlog,
starvation duration, gate refusals, capacity utilization, provider-outage
signals.

Consumer events: `onSuspicion`, `onSplit`, `onEscalation`,
`onLowCostUncovered`, `onUrgentUncovered`, `onBackpressure`, `onPoolOffline`,
`onContractMismatch`, `onClassHealthChanged`, `onDiversityShortfall`,
`onResultAdjudicationRequested`, `onActionAdjudicationRequested`,
`onAdjudicationUncovered`, `onAuditUncovered`, `onDisputeRequeueExhausted`.

Worker records and human-adjudicator identities are personal data even when
source material is public. Retention classes per data kind; pseudonymized
worker and adjudicator identifiers with severable subject mappings; erasure
that anonymizes a person's ledger and events while preserving aggregate counts;
`PrivacyClass` governing submission-body and effect-descriptor retention and
whether either appears in events. Lawful-basis decisions are the consumer's.

## 8. Trust model as tests

| Threat | Asserted |
|---|---|
| Member edits the skill or calls MCP directly | Tools are the entire surface; scopes enforced independently; `availability` is a closed one-field schema; capabilities server-held |
| Queue probing | Every row of section 5.7's table has a conformance test |
| Post-lease withholding | Not preventable and not detectable for sparse contributors; population-level correlation only |
| Stolen token | Short-lived tokens; revocation invalidates open leases |
| Leaked lease identifier | Submit, abandon, extend rejected from any subject but the holder |
| Fabricated results | Core derives achieved strength, requires action-specific payload and result coverage, and issues no under-strength authorization; canaries affect worker risk only |
| Suppression by omission | Automatic `suppress` requires a completeness oracle with a declared absence domain; human-only suppression binds that domain plus complete effect-review coverage; every `drop` is human-only |
| Consumer bypasses authorization | Explicitly outside the worker threat model; the consumer is trusted, and the conformance kit tests every declared side-effect adapter, effect-schema validation, and descriptor-hash match |
| Ungated internal mutation | A conforming consumer maps every side effect to declared actions; `mutateCanonicalState` and `updateRetrievalIndex` exist for durable state |
| Escalation flooding | Per-class budgets and separate per-worker low-cost/urgent quotas; overflow creates no review work; every reserve is independently visible and non-borrowable; quota abuse raises suspicion |
| Hollow oracles | Negative fixtures mandatory; result- and action-specific payload/result coverage plus absence domains bound what a gate accepts; arbitrary consumer oracle correctness is not claimed |
| Collusion or lazy agreement | Confidence-typed diversity; agreement requires unanimous canonical equivalence and mandatory equivalence/disagreement fixtures; adjudicated falsehood moves reputation; worker audits cannot adjudicate; clustering monitored |
| Split or diversity shortfall | A split is absorbing: extra replicas enrich evidence but cannot vote away dissent. A separate result-adjudication request exists before any decision hash or action request; only a bound human verdict may resolve it, and the resolved result reruns all checks |
| Replay, effect swapping, or conflicting retry | Exact submissions, hashed effect-intent authorization requests, and verdicts return byte-identical prior outcomes without duplicate rows or budget; changed bodies, descriptors or action sets under one intent, or verdicts return their typed conflict and change nothing |
| Authorization used after invalidation | Issued records retain their audit state but get a separate typed invalidation reason; conforming consumers check status at the side-effect boundary |
| Cross-lease result reuse | Not detectable when payload and contract are identical; `input_hash` proves binding, not fresh computation; canaries and retrospective audits address worker behavior statistically |
| Job hoarding | Concurrency cap; bounded extensions; expired leases requeue and count against the holder |
| Correlated model error | Diversity shortfall escalates rather than counting as satisfied |
| Adjudication flooding | Bounded low-cost overflow, visible supply/demand/backlog starvation, hysteresis, and manual restore; intake never auto-restored |
| Pool-offline false halt | `admission_halted` stops intake but accepts valid in-flight work; only an explicit `emergency_halted` operator policy cancels pending work |
| Multi-identity | Per-subject limits, account-cluster diversity, admission hook, plus documentation that this is not solved |
| Prompt injection | Unsanitized `enqueue` throws; skill quotes payload as data; injection corpus fixture |
| Provider drift | Contract lifecycle with dual-read validators; `onContractMismatch` |

### 8.1 Store conformance

Lease atomicity under concurrency, subject binding, idempotent submit, expiry
requeue, absence of double-leasing. `claimLease` must be atomic and submit
idempotency must match `(lease_id, input_hash, result_hash)` exactly, with a
unique accepted submission per lease. A conflicting retry returns
`submission_conflict` without replacing the accepted row. The exact-retry path
is exercised after submission closure, lease expiry, contract expiry, admission
halt, emergency halt, and permit withdrawal; once the subject is authenticated,
none may replace a previously issued receipt with a new result row.
The store also enforces one authorization-request identity per
globally unique `effect_intent_id`; exact canonical retries for the same
decision reuse its immutable initial receipt, and a different decision or
intent hash returns `authorization_conflict`. Each adjudication request has at most one canonical
accepted verdict; exact retries reuse its receipt and a different verdict
returns `verdict_conflict`. Authorization exact retries are exercised after
every invalidation reason and return the immutable historical record rather than
creating a new request; a separate status read returns current validity.

### 8.2 Protocol conformance

Golden `input_hash`, `result_hash`, `effect_intent_hash`, both
adjudication-verdict hashes, and `decision_result_hash` vectors above all. Tool
schemas, error codes, coarse `no_work` shapes, `availability` schema,
canonical action-set, effect-intent,
and every exact-retry/conflicting-retry case, immutable authorization receipts
versus live validity, authorization validity and both
adjudication lifecycles including every invalidation transition, unanimous
agreement and absorbing-split cases, oracle coverage and negative fixtures,
halt distinctions, automatic effect-derivation fixtures, human effect-path and
absence-domain review coverage, absence-domain containment acceptance and
refusal cases, verified-result retirement from future intents,
urgent-saturation denial of an in-flight urgent action request,
rejected-dispute requeue under the current epoch, dispute-requeue cap
exhaustion, typed denial reasons across replay and status reads, immutable
submission receipts, and contract-lifecycle transitions ship as fixtures.

### 8.3 The invariant

`muster-core` has one runtime dependency, and CI asserts it references no
network or filesystem API.

### 8.4 Known limitation: Sybil resistance

Not solved. AI Horde's IP-based answer does not port: workers arrive from
provider clouds and members sit behind mobile carrier NAT. The core offers
per-subject limits, account-cluster diversity, and the admission hook, and
claims nothing further.

## 9. Platform gate

Muster rests on an unproven assumption: that a scheduled task on a
mobile-manageable plan can execute a skill and call a remote MCP connector
unattended. **No implementation beyond a stub is authorized until a real-device
test passes on at least one provider surface.** Hosted scheduled-agent execution
is an adapter capability recorded at enrollment, not a core assumption.

## 10. Packaging

Semver on the npm packages, wire contract versioned independently. Node and
Workers-compatible builds. Documentation leads with sections 1.1, 1.3, 1.4.

Apache-2.0. Because AI Horde is AGPL-3.0-or-later, Muster studies its design and
never copies its code, schemas, or documentation text.

## 11. Planning notes and open questions

### 11.1 Milestone one is a contract freeze, and nothing else

This spec specifies mechanisms in kind. A planner must not begin feature work
until every public type and every state or precedence table is pinned, or the
implementation will encode accidental policy. Milestone one freezes, at
minimum:

**Types.** `Action`, `ActionPermit`, `EffectDerivationInput`, `EffectFixture`,
`EffectIntentItem`, `EffectIntent`, `HumanReviewRequirement`,
`AutomaticVerificationStrength`, `VerificationStrength`,
`JobClass`, `OracleSpec`, `OracleVerdict`, `EvidenceRequirement`,
`ActionEvidenceRequirement`, `AbsenceDomain`, `AbsenceRequirement`, `Fixture`,
`Validator`,
`AgreementPolicy`, `AgreementFixture`, `AgreementOutcome`, `NonEmptyArray`,
`CanonicalJsonValue`, `CanarySource`, `CapabilityRequirement`, `DiversityRule`,
`AxisConfidence`, `PrivacyClass`, `ReplicationPolicy`, `EscalationReserves`,
`AdjudicationPolicy`,
`ResultAdjudicationRequest`, `ResultAdjudicationVerdict`,
`HumanActionReviewRequirement`, `ActionAdjudicationRequest`,
`ActionAdjudicationVerdict`, `AdjudicationCapacity`, `ActionAuthorization`,
`SubmissionEvidence`, `ResultState`, `ResultAdjudicationRequestState`,
`AuthorizationRequestState`, `AuthorizationInvalidationReason`,
`AuthorizationDenialReason`, `AuthorizationValidity`, `AuthorizationStatus`,
`SubmissionReceipt`, `ClassHealth`,
`WorkerSubject`, `Store`, `EventSink`, `AdmissionHook`, `AdjudicationSource`.

**Tables and state machines.** The worker state machine (3.1); the action gate
table (6.3); the precedence table (6.6); the fair-attempt classification table
(6.9); the audit-source table (6.11); the queue mode table (6.12); the contract
lifecycle (5.6); exact-retry and conflict rules for submissions, authorization
requests, and both verdict paths (4.3, 6.5, 6.6); the result-dispute and
action-adjudication lifecycles, their invalidation transitions, authorization
validity, and multidimensional class health (6.6).

**Semantics that are prose here and must become executable.** Action
composition — which side effects map to which actions, that all mapped gates
must pass atomically for the complete descriptor-bound intent, authorization
modes, and effect-intent idempotency (4.3); result, action, and
absence-requirement coverage validation at registration and runtime (6.7);
replication target, unanimous equivalence, diversity, absorbing splits,
split-evidence limit, and the two adjudication accounting paths (6.2–6.6);
escalation reserve accounting and urgent fail-closed behaviour (6.4); permit
epoch assignment across requeue, split-evidence reroute, pending human review,
emergency authorization invalidation, and draining (6.6); `availability`
bucket quantization and every mitigation in the side-channel table (5.7).

**Fixtures.** Golden input, result, both adjudication-verdict, and decision
hashes; MCP tool and error schemas; exact retries after every terminal lease
condition; authorization-request and verdict retry/conflict cases; result- and
action-adjudication transitions including every invalidation state; agreement
equivalence and disagreement fixtures; oracle coverage and negative fixtures;
automatic effect-derivation fixtures; human effect-path and absence-domain
coverage; verified-result retirement before a second intent; the store
concurrency suite; the prompt-injection corpus.

### 11.2 Open

1. **Does standing decay?** AI Horde's non-expiring balances ossified priority
   into permanent early-contributor advantage.
2. **Sybil resistance** (section 8.4).
3. **Audit economics.** Re-verifying resolved work costs allowance producing no
   new output; an affordable audit `q` is unmeasured.
4. **Adjudication supply.** Section 6.6 makes capacity a gate; whether any real
   deployment sustains enough is the open viability question.
5. **Completeness oracles.** Required for every automatic decision about
   absence. Whether a practical one exists for the first consumer's materiality judgement
   is unresolved; if not, suppression stays human-only permanently.
6. **Sparse-contributor withholding.** Section 1.4 says it is undetectable.
   Whether a weekly-cadence pool can carry politically sensitive material at
   all, given that, is a consumer viability question and not only a Muster one.
7. **AI Horde depth**; **SEP-2640 tracking**; **multi-tenancy** — as before.
