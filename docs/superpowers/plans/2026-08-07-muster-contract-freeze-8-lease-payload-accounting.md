# Muster contract-freeze-8 lease-payload and no-work accounting amendment plan

**Status:** Independently reviewed and corrected as coordinator revision 19.
M2 Task 4 remains paused until the reviewed commit is tagged
`contract-freeze-8`.

**Goal:** Amend revision 18 into revision 19 so every lease binds the exact
payload sent to the worker and every coarse `no_work` outcome can consume one
contribution occurrence atomically.

**Trigger:** The first M2 Task-4 implementation trace found two frozen-boundary
gaps. A canary assignment records provenance and an expected-result hash, but a
prepared lease has no payload reference and `compareAndClaimLease` accepts no
payload. The current Store therefore requires the lease input hash to equal the
queued job hash even when the worker is meant to receive a canary payload, and
submission cannot retrieve that exact payload later. Separately, the frozen
fair-attempt table says every `no_work` response counts for contribution, but no
atomic Store command can compare the worker routing revision and advance that
usage without fabricating a lease.

## Required contract

- Add `payloadRef` to `LeaseRecord`. Ordinary leases reference the queued job's
  payload and retain its input hash. A canary lease reuses its
  IdSource-allocated `leaseId` as its distinct operational `payloadRef`; core
  does not invent a second opaque identity. It binds an input hash computed
  from that exact canary payload, the same frozen schemas, class/version,
  policy version, and permit epoch.
- `compareAndClaimLease` receives the exact `preparedPayload`. Store compares it
  with the durable job payload for an ordinary assignment. For a canary
  assignment it atomically persists the prepared payload under the lease's
  distinct payload reference together with the lease. A losing comparison or
  payload-reference collision leaves neither a lease nor a payload alias.
- Canary provenance remains hash-only in `LeaseAssignment`: expected bodies do
  not enter the durable lease or audit events. Submission retrieves the
  operational payload through the lease payload reference and treats a canary
  result as worker evidence, never as an accepted replica of the displaced job.
- Add `recordNoWorkAttempt({ expectedWorker, at })`. It compares the complete
  worker-routing snapshot and atomically increments contribution usage and the
  Store-owned revision while preserving open leases. Concurrent calls against
  one snapshot produce one recorded occurrence and one conflict.
- Initial claims still increment contribution once. Later abandon/expiry
  implementation applies the frozen fair-attempt table atomically: outcomes
  that do not count release that occurrence only if its contribution window is
  still current; counted outcomes retain it. No adapter derives a calendar.

## Required executable coverage

- ordinary claims reject a prepared payload that differs from the durable job;
- canary claims require `payloadRef === leaseId`, may bind a different input
  hash, persist their exact payload, preserve the ordinary job payload, and
  leave no payload on a losing or payload-reference-collision claim;
- no-work accounting is single-winner under a routing-snapshot race and
  preserves the Store-owned open-lease set; routing-period and worker-state
  changes fence stale no-work snapshots;
- the lifecycle and Store-concurrency fixture packs name these cases;
- wire version `1.1.0`, MCP schemas, hash envelopes, event schemas, class
  records, job records, and worker records remain unchanged.

## Exit gate

Run frozen install, invariants, contract/core typechecks and tests, builds,
fixture checks, package-content inspection, Markdown fence/local-link checks,
and `git diff --check`. Independently trace ordinary and canary payloads from
enqueue through claim and submit, then race no-work accounting against routing
and worker-state changes. Only a reviewed commit tagged `contract-freeze-8`
authorizes M2 Task 4 to resume.

The independent review found and corrected four gaps before the reviewed
commit: canary payload-reference ownership was unspecified, payload-reference
collisions were not exercised, no-work preservation and transition fences were
not exercised, and lifecycle fixture shapes did not require the revision-19
payload and complete routing snapshot.
