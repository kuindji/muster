# Muster - staged and effecting work (deferred)

**Date:** 2026-08-04

**Status:** **Deferred. Authorizes nothing.** This document records a design
direction, three unsolved staged-work problems, and the effecting-work
trust/execution contract that must be frozen before either shape may be planned
or built.

**Parent:** `2026-08-04-muster-coordinator-design.md` (revision 12, `oneshot`
scope).

## Why this is separate

Muster revision 2 introduced staged and effecting work. Two consecutive gpt-5.5
review rounds concluded they were not ready to plan against — the second after
a revision written specifically to fix the first round's findings. Each pass
found a new way the mechanism could be circumvented rather than a residual
detail. The one-shot half of the design converged over the same four rounds.

Rather than hold a converged design hostage to an unconverged one, they are
split. This document exists so the reasoning is not lost and so nobody
reintroduces these features believing them solved.

## 1. Staged work

### 1.1 The shape

A `staged` job class declares a DAG of one-shot stages. The coordinator leases
each stage separately; each carries its own lease, `input_hash`, validators,
and verification strength. A worker never loops, never chooses the next step,
and never holds state between stages.

That much is sound. What is not sound is the assumption that per-stage
verification composes into end-to-end verification.

### 1.2 Why per-stage verification does not compose

If stage 1's output selects candidates, narrows context, creates labels, or
determines stage 2's payload, a worker who poisons stage 1 produces a stage 2
that verifies cleanly against contaminated input. The first consumer's design
is the worked example: cooperative extraction feeds candidate retrieval feeds cooperative
topic comparison, and the comparison stage's span checks run against the
poisoned extraction rather than the original source.

### 1.3 What was tried, and how each attempt failed

**Attempt 1 (revision 2)** — assert that per-stage guarantees compose. Simply
false.

**Attempt 2 (revision 3)** — require that either every controlling stage output
is verified, or the final stage carries an end-to-end oracle. Both conditions
were bypassable: a graph could declare only explicit selector fields as
"controlling" while passing a tainted summary into later context, and a
positive-support oracle passes cleanly when a poisoned stage 1 *omits* a
material claim.

**Attempt 3 (revision 4)** — remove the discretion. Every field of a stage's
payload declares provenance by JSON path; registration refuses any unenumerated
field; **any** inter-stage edge is controlling; taint propagates field-level by
weakest link and gates read `taint.minUpstreamStrength` rather than the final
stage's own strength.

That closed the declared-influence hole and was defeated by an undeclared one:

> `StageSpec.inputs` permits `{ from: 'coordinator' }` for deterministic
> server-derived fields, and never requires provenance for what the coordinator
> derived *them* from. Stage A omits a claim; the coordinator deterministically
> computes candidate IDs, summaries, labels, or scores from A's output; stage B
> declares those as `from: 'coordinator'`; **no inter-stage edge is recorded and
> the taint disappears.** Every declaration is truthful. Transitive provenance
> is not.

An earlier revision of the first consumer's design was exactly this shape:
candidate retrieval was server-derived from worker extraction output. Its current consumer contract
forbids that dependency and derives retrieval from the sanitized original
source and trusted topic state instead; the example remains the reason for that
restriction.

### 1.4 Unsolved problem 1: transitive provenance

Coordinator-derived fields need their own derivation graph. Any coordinator
field computed from worker output must carry transitive taint and create an
inter-stage dependency; only fields derived solely from the original payload,
static policy, or trusted consumer state may be untainted.

That is easy to state and hard to make sound, because it requires
transform-level path mapping through arbitrary consumer code. A design that
cannot express "this server-side function read worker output" cannot enforce
it, and a design that requires consumers to declare it correctly has merely
relocated the trust.

### 1.5 Unsolved problem 2: oracle coverage

Muster revision 10 defines `OracleSpec` with `coversPayloadPaths`,
`coversResultPaths`, `absenceDomain`, action-specific evidence requirements,
and mandatory negative fixtures, which bounds what an oracle may clear. Whether
that is sufficient for *staged* clearing — where an oracle must vouch for the
original payload across a chain of transformations it never saw — is
unestablished. A completeness oracle that examines only what the final stage
returned covers nothing.

### 1.6 Unsolved problem 3: epoch and retry semantics

Permit epochs, split-evidence reroutes, expired-lease requeues, and retries
interact differently once a job spans multiple leases over a longer wall-clock
window. A stage graph half-completed under epoch `E` when permits change has no
obviously correct behaviour: completing under `E` may apply a bar the operator
has since rejected, and re-gating mid-graph may strand work that cannot be
redone.

## 2. Effecting work

### 2.1 The shape

The worker returns a *proposed* effect inside its schema-validated result.
Muster verifies it, applies the action gate, and emits it. The consumer
executes it, outside the library. Muster holds no executor and grants the worker
no credential.

This is distinct from parent revision 10's `EffectIntent`: there the consumer
proposes a descriptor, an automatic permit must derive the identical descriptor
from restricted verified inputs, and a human-only permit shows the descriptor
to the adjudicator. The worker never proposes the effect descriptor. Allowing it
to do so is the deferred shape discussed here.

Constraints established and worth keeping: irreversible effects require
`human_adjudicated`, always, with no deterministic-oracle exception. A class
must declare an idempotency key and duplicate suppression, an authorization
policy, a dry-run validation, and rollback or compensation — or an explicit
statement that there is none.

### 2.2 Deferred problem 4: receipts are audit records, not enforcement

The consumer appends an `EffectReceipt` recording preflight, authorization,
approval, execution, and compensation. A class whose receipts are missing,
malformed, or overdue is automatically suspended.

This catches absence and lateness. **It cannot catch dishonesty.** A consumer
that is buggy or lying can file a timely receipt claiming preflight ran, claim
human approval that never happened, execute a different effect than the one
approved, or execute after reporting refusal. Muster cannot verify a receipt is
truthful, so the trust that "propose, don't act" removed from the worker has
been relocated to the consumer rather than eliminated.

Two directions were identified:

1. **Declare the consumer trusted.** Revision 7 of the parent now does this for
   one-shot action authorizations. That resolves the parent spec's overclaim; it
   does not by itself define or authorize worker-proposed external effects.
2. **Specify a consumer conformance adapter** that commits execution and
   receipt through one auditable transaction with hooks Muster can verify. This
   is a real design, and it is a different project from a coordinator library.

## 3. Preconditions for revisiting

Staged work may be specified when transitive provenance through
coordinator-derived fields is enforceable rather than declarative, when oracle
coverage across a stage chain is defined, and when epoch semantics across
multi-lease jobs are settled.

Effecting work may be specified when the parent trust assumption is explicitly
extended to worker-proposed effects and the execution, idempotency, approval,
rollback, and receipt contract is frozen — or when an adapter contract makes
receipts verifiable.

Until then, consumers needing multi-step or side-effecting behaviour should
compose it themselves from independently-gated one-shot classes, accepting that
Muster makes no end-to-end claim about the composition. That is the honest
position, and it is what the parent spec's sections 4.3-4.4 already say.
