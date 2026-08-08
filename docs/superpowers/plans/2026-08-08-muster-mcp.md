# Muster MCP implementation plan

**Goal:** Implement `@kuindji/muster-mcp` as a production-shaped, mountable
OAuth-protected MCP resource server for the reviewed revision-28 coordinator,
while preserving worker wire version `1.1.0`, keeping raw OAuth identity outside
core, and translating the six frozen tools into the existing public core
operations without adding worker-controlled policy.

**Scope:** The package owns the remote MCP transport boundary, protected-resource
metadata, access-token verification, severable authenticated-subject mapping,
per-call scope and rate enforcement, worker-facing tool handlers, and the
optional experimental skill Resource adapter. It does not issue OAuth tokens,
host an authorization server, schedule provider runs, fetch source material,
implement a worker runtime, change consumer action gates, execute consumer side
effects, add deployment infrastructure, publish packages, or push remotely.
The authorization server owns authorization-code and PKCE processing. A missing
coarse projection, policy value, persistent comparison, or representable worker
outcome stops runtime work and requires a separate normative amendment.

**Planning boundary:** `main` was clean and equal to `origin/main` at
`847c316d92061844fe8ffaf4f15515b55ca4eaab` when this plan was drafted.
Milestone 2 and the PostgreSQL Store adapter are complete. Revision 26 is the
active internal boundary and is tagged locally as `contract-freeze-15`; the
worker wire remains `1.1.0`. Amendment 16 subsequently froze the MCP-owned
semantics at revision 27 and `contract-freeze-16`; no `packages/mcp`
implementation existed at that boundary. The first Task-5 trace later found
unowned long-extension and abandon-refusal projections; amendment 17 freezes
their revision-28 correction at `contract-freeze-17` before job-handler
completion.

**Protocol baseline:** Use the official MCP TypeScript v2 packages and expose a
web-standard Node 20+ handler. Support the current stateless `2026-07-28`
Streamable HTTP shape and the SDK's `2025-11-25` compatibility path needed by
existing remote clients. Do not add deprecated HTTP+SSE. The current transport
uses one POST per request, no protocol session, explicit protocol/method/name
headers, Origin validation, and request-scoped JSON or SSE responses. The MCP
endpoint is an OAuth resource server, not an authorization server.

Primary implementation references are the current MCP specifications for
[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
and [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
the official TypeScript SDK guides for
[server authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
and [server examples](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/README.md),
[RFC 9728 protected-resource metadata](https://www.rfc-editor.org/rfc/rfc9728),
[RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707),
[RFC 8414 authorization-server metadata](https://www.rfc-editor.org/rfc/rfc8414),
[RFC 9068 JWT access tokens](https://www.rfc-editor.org/rfc/rfc9068), and
[RFC 9700 OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700).

## Entry gate: freeze the remaining MCP-owned semantics (complete 2026-08-08)

The first repository trace found facts that the frozen schemas require but no
current port or table can compute safely:

- `get_worker_status.cap_usage_bucket` has a closed `0..3` shape but no frozen
  numerator, thresholds, edge behavior, or meaning;
- `get_worker_status.next_slot_bucket` has no unit, bucket table, next-occurrence
  projection, or owner in `WorkerControlPolicy`;
- the canonical skill hash has no deployment-owned release registry binding a
  worker's accepted contract and enrolled class set to one immutable skill;
- `lease_job.availability` is frozen and described as affecting quantized batch
  shape only after job selection, but `LeaseService.leaseJob(workerId)` neither
  receives availability nor exposes a post-selection batch-sizing command;
- payload padding is frozen as a side-channel mitigation, but the transport has
  no defined padding representation that leaves `payload` and `input_hash`
  unchanged;
- rate limits and monotonic availability require durable atomic comparison per
  mapped worker and assigned-slot occurrence, but no MCP state port or policy
  owns the limits, replay, or conflict outcomes;
- token revocation, mapping severance, worker revocation, and a call already in
  flight have no explicit request-boundary ordering rule;
- the exact OAuth scope vocabulary is ambiguous between the prose's `jobs:*` /
  `worker:*` families and `TOOL_SCHEMAS`' `jobs` / `worker` values; and
- `get_worker_status` and `set_availability` have success-only output schemas,
  but missing/revoked workers and invalid state transitions need one uniform,
  non-probing failure path.

These are not adapter conveniences. Task 1 must trace each fact through the
spec, schemas, core services, Store, generated fixtures, and every worker-facing
consumer. It then creates the smallest revision-27 amendment needed to give each
fact one deterministic owner. Prefer internal ports, policy inputs, tables, and
tool-error rules that preserve wire `1.1.0`; if the existing wire cannot express
a required outcome, stop and make the compatibility/version decision explicit
instead of silently widening a schema.

No package or transport implementation may begin until that amendment is
independently reviewed, corrected, and tagged at the next contract-freeze
boundary. The tag is a review boundary, not permission to publish or push.

Revision 27 and amendment 16 resolve the gate with exact status buckets,
deployment-owned next-slot projection, complete-class skill selection, singular
availability-invariant v1 leasing, transport-body padding, exact scopes,
MCP-state atomic outcomes, ordered revocation checks, and per-tool result/error
projection. The reviewed boundary is tagged `contract-freeze-16`.

## Fixed architecture decisions

- Export a framework-neutral `createMusterMcpHandler()` that accepts and returns
  web-standard `Request`/`Response`. A deployment may adapt it to Express, Hono,
  or a serverless host outside this package; the core package does not own a
  listener, port, TLS termination, proxy trust, or process shutdown.
- Use `@modelcontextprotocol/server` v2 and its AJV validation provider. Serve
  the exact frozen `TOOL_SCHEMAS[name].inputSchema` and `outputSchema` objects;
  do not regenerate them from Zod or maintain a second schema source.
- Target the current sessionless MCP protocol and the SDK's one-revision legacy
  compatibility layer. Request-local server/transport objects must carry no
  worker state. Availability, rate limits, mapping, replay, and revocation live
  in explicit durable ports, never in an MCP session or process-local map.
- The package is an OAuth protected resource only. It publishes RFC 9728
  metadata and bearer challenges that name the configured authorization server
  and canonical HTTPS resource URI. Authorization code, PKCE, consent, client
  registration, refresh tokens, and token issuance remain authorization-server
  responsibilities.
- Ship a JWT/JWKS verifier for explicitly configured issuers. Pin allowed
  algorithms; validate signature, issuer, resource/audience, expiry, not-before,
  subject, token type, scopes, and configured clock skew. A caller cannot
  disable individual checks. Revocation is a mandatory per-call source rather
  than an optional best-effort cache.
- Normalize an authenticated identity only as
  `{ issuer: canonicalIssuerUrl, subject: stableSub }` at the MCP boundary.
  Resolve it through `McpStateStore`; pass only the returned opaque `WorkerId`
  to core. Raw issuer/sub, bearer tokens, authorization headers, and JWKS data
  never enter core, Store, hashes, receipts, event sinks, or worker tool bodies.
- Make `McpStateStore` an atomic domain-command port, not row-level CRUD. It owns
  one-to-one subject binding/severance, exact bind replay/conflict, rate-window
  consumption, and availability monotonicity for the complete slot snapshot.
  Export an in-memory reference implementation and a reusable conformance suite;
  production deployments supply a durable adapter outside core persistence.
- Inject already-constructed `LeaseService`, `SubmissionService`, and
  `ControlPlaneService` instances plus only the additional reviewed status,
  skill-release, clock, and MCP-state boundaries. Handlers do not instantiate
  policy, registries, Stores, IDs, or clocks and never call Store commands that
  bypass a public core operation unless the reviewed amendment explicitly
  creates that public read boundary.
- Validate authentication, revocation, scope, mapping, worker eligibility,
  rate allowance, and complete tool input before invoking a core mutation.
  Failed preconditions do not allocate core IDs or consume a lease. A rate or
  availability comparison that is defined to count an attempt commits exactly
  once through its atomic MCP-state command.
- Require `muster:access` plus exactly `muster:jobs` or `muster:worker` for the
  selected tool. Use OAuth insufficient-scope step-up without wildcard scopes.
- Keep v1 leases singular. Availability never enters core or changes selection,
  batch size, payload, or input hash; bucket zero dispatches no core lease call.
  Pad only the complete encoded response outside the parsed MCP value.
- Return successful tool values in `structuredContent` and mirror the same
  canonical JSON value in one text content item for compatible clients. Apply
  output-schema validation before returning. Authentication/protocol failures
  remain HTTP/MCP errors; worker-domain errors use only the reviewed frozen
  coarse shapes. Never expose precise queue, validation, lease, scope, mapping,
  rate, or revocation reasons to a worker.
- Enforce a package-owned maximum HTTP body size before JSON parsing and the
  lease-snapshotted `maxResultBytes` inside core. Validate allowed Origins from
  immutable configuration, reject Host/resource confusion, ignore forwarded
  headers unless the deployment passes an already canonical public URL, and
  emit `Cache-Control: no-store` on authentication and worker-specific results.
- Treat the canonical skill text as immutable release data. The stable base
  tool surface exposes only `skill_sha256`. Hand installation remains
  normative. Any Skills-over-MCP support is disabled by default, versioned,
  uses only the same rendered bytes, and may be removed without changing the
  six base tools.

## Task 1: Revision-27 MCP boundary amendment (complete 2026-08-08)

Create a separate contract-freeze amendment before runtime code:

- settle the status bucket meanings, tables, units, boundaries, and overflow;
- extend the deployment-owned worker scheduling/status policy with the minimum
  deterministic next-slot projection, without accepting worker-supplied slots;
- define immutable skill-release selection and hash ownership for workers with
  multiple enrolled classes;
- define whether availability changes batch size in v1, the exact post-selection
  core boundary that applies it, and how batch/payload padding is represented
  without changing the input hash or leaking an unpadded length;
- freeze the MCP rate-limit policy inputs and the atomic mapping/rate/
  availability state command outcomes;
- settle exact token-scope names and scope-step-up behavior;
- settle successful-output versus tool-error behavior for all six tools,
  especially status and availability;
- define the request-start linearization point for token revocation, subject
  severance, and worker revocation; and
- add stable fixture IDs covering every row of spec section 5.7 plus direct
  calls, exact retries, mapping severance, scope refusal, rate races, and
  monotonic-bucket races.

Update the coordinator spec, contract exports, core ports/services, fixture
generators, lifecycle/conformance required-ID matrices, README, and this plan as
one narrow amendment. Rebuild `@kuindji/muster-contract` before dependent core
tests. Run the full contract/core gate, perform independent semantic review,
apply corrections, and tag the reviewed boundary before Task 2.

Checkpoint: every MCP-visible fact and failure has one reviewed owner; no MCP
runtime package exists yet.

## Task 2: Package boundary and protocol harness (complete 2026-08-08)

Create the package skeleton:

- add `packages/mcp/package.json`, TypeScript/build configuration,
  `src/index.ts`, `src/config.ts`, `src/handler.ts`, `src/server.ts`,
  `src/results.ts`, `src/errors.ts`, and `src/testing.ts`;
- depend at runtime only on `@kuindji/muster-contract`,
  `@kuindji/muster-core`, `@modelcontextprotocol/server`, and the reviewed JWT
  library; keep HTTP-framework adapters out of the runtime dependency set;
- extend workspace invariants to require Node 20+, ESM/CJS/types output, the
  exact runtime dependency boundary, absence of raw OAuth fields from core
  imports/outputs, and no imports from the throwaway `gate/stub-mcp` package;
- validate immutable configuration: canonical HTTPS resource and issuer URLs,
  endpoint path, allowed Origins, audience/resource, JWKS URI relationship,
  algorithms, body cap, clock skew, and closed tool descriptions;
- expose a stateless handler for POST plus the exact required metadata routes;
  reject unsupported methods, Origins, protocol/header mismatches, oversized
  bodies, invalid content types, and unknown JSON-RPC methods without invoking
  auth, state, or core; and
- add a real SDK client harness covering `2026-07-28` and `2025-11-25`, JSON
  and request-scoped SSE responses, concurrent requests, cancellation, schema
  listing, unsupported-version negotiation, and absence of protocol sessions.

Checkpoint: the package builds and its unauthenticated transport/protocol suite
passes; tools are listed from frozen schemas but no authenticated handler calls
core yet.

Implementation checkpoint: `@kuindji/muster-mcp` now exposes the immutable
configuration and framework-neutral web handler, serves both canonical RFC 9728
protected-resource metadata paths, and lists the six frozen tools through the
official v2 SDK. The package pins the supported eras to `2026-07-28` and
`2025-11-25`, keeps protocol sessions absent, validates request size before JSON
parsing, and rejects invalid resource/Host/Origin, method, media type, Accept,
protocol/header, and version boundaries before any future authentication,
MCP-state, or core dispatch. The real SDK client harness covers JSON,
request-scoped SSE, legacy compatibility, concurrency, cancellation, and exact
modern schema identity. The SDK's specified legacy projection wraps only
non-object-root output schemas in `{ result }`; it does not change the modern
frozen catalog. Authentication and identity resolution remain Task 3.

## Task 3: OAuth resource server, JWKS, and per-call identity (complete 2026-08-08)

Implement the authentication boundary:

- serve RFC 9728 protected-resource metadata at both the endpoint-qualified and
  root discovery locations required by the configured mount, with at least one
  authorization server and the reviewed scope set;
- return standards-compliant `WWW-Authenticate` challenges containing
  `resource_metadata` and least-privilege scope guidance;
- fetch and cache JWKS according to response metadata while failing closed on
  unknown key IDs, algorithm confusion, issuer/resource mismatch, stale keys,
  network failure, malformed claims, missing stable subject, and clock claims;
- call the mandatory revocation source on every protected request after
  cryptographic verification and before mapping or tool dispatch;
- enforce the endpoint access scope and the exact per-tool scope before
  invoking its handler, including the reviewed insufficient-scope behavior;
- resolve issuer/sub through `McpStateStore`, reject missing/severed/conflicting
  mappings, then load the pseudonymous worker through the reviewed core status
  boundary so revoked workers fail before dispatch; and
- scrub bearer tokens and raw subjects from errors, logs, metrics, traces,
  tool results, core spies, and thrown-error serialization.

Use a disposable local authorization/JWKS fixture with rotating keys, explicit
resource indicators, short-lived tokens, revocation, wrong issuers/audiences,
malformed scope claims, and concurrent key refresh. Do not depend on a live
third-party identity provider for the package gate.

Checkpoint: protected-resource discovery and authenticated identity resolution
pass over real HTTP; no raw identity reaches a core spy.

Implementation checkpoint: every accepted MCP protocol request now verifies a
pinned-algorithm `at+jwt` access token, issuer, resource audience, stable
subject, scope and clock claims against a response-metadata-aware JWKS cache.
Unknown key IDs trigger one coalesced refresh; stale, unavailable, malformed,
or mismatched keys fail closed. The handler performs mandatory fingerprint-only
revocation, exact endpoint/tool scope checks, severable subject resolution, and
pseudonymous worker-status validation in the frozen order. Uniform bearer
challenges expose only the endpoint scope or one required step-up scope.
Disposable local HTTP fixtures cover discovery, short-lived tokens, rotation,
concurrent refresh, revocation, claim failures, mapping and worker refusal, and
raw bearer/subject scrubbing. Tool dispatch remains the generic pending result;
MCP-state mutation, rate/slot accounting, and availability begin in Task 4.

## Task 4: MCP state port, subject lifecycle, rate limits, and availability (complete 2026-08-08)

Implement and export the reviewed `McpStateStore` plus its reference adapter:

- bind one normalized issuer/sub pair to exactly one `WorkerId`, replay exact
  bindings, conflict on either-side reuse, and sever the raw link without
  deleting pseudonymous core history;
- expose operator-only bind/sever services as library calls, never MCP tools;
- compare the complete mapping revision, worker/slot identity, tool, rate
  policy, time window, and optional availability bucket in one atomic command;
- enforce rate windows and assigned-slot attempt rules without using MCP
  sessions, process clocks, or worker-provided occurrence identifiers;
- accept an availability bucket only when it is equal to or lower than the
  durable bucket already seen for that mapped worker and slot occurrence;
  a new reviewed occurrence starts a new monotonic record;
- distinguish exact replay, rate refusal, stale mapping/slot conflict, and
  monotonicity refusal internally while projecting only the reviewed coarse
  worker behavior; and
- detach/freeze inputs, return detached records, and require stable ordering for
  every list used by conformance.

The exported conformance suite must run unchanged against the reference store
and future durable adapters. Add same-key and cross-key races for bind, sever,
rate consumption, slot rollover, and competing availability values. Prove a
severed subject cannot authenticate even while pseudonymous rate and core
history remain non-identifying.

Checkpoint: identity and side-channel state have deterministic, adapter-
parametric concurrency semantics; tool handlers still use spies.

Implementation checkpoint: `InMemoryMcpStateStore` now serializes the frozen
four-command MCP-state port, keeps raw OAuth identity only in active severable
bindings, advances per-worker mapping revisions across rebinding, and retains
only pseudonymous rate, slot, availability, and severance history. Complete
policy versions and derived UTC windows are compared before mutation; per-tool
rate calls, per-slot lease attempts, and equal-or-lower availability updates
commit atomically, while every refusal is mutation-free. Operator-only mapping
lifecycle is exported as a library service. The reusable
`runMcpStateStoreConformance` suite covers exact replay/conflict, input and
output detachment, stable ordering, policy/window mismatch, window and slot
rollover, and same-key/cross-key bind, sever, rate, and availability races. The
authenticated handler integration proves severance fails closed while
pseudonymous usage survives without retaining the raw subject. Job tool
dispatch and core mutations remain Task 5.

## Task 5: Job tool handlers (complete 2026-08-08)

Freeze interruption: the first runtime trace proved that core can successfully
extend a lease beyond the fixed 7,200-second TTL table, while revision 27 had no
post-mutation overflow projection. It also allowed multiple frozen wire errors
for core's deliberately uniform abandon refusal. Revision 28 /
`contract-freeze-17` now continues long TTL buckets by doubling and assigns
`lease_not_held` as the sole abandon-refusal code. Task-5 runtime completion
resumes only against that reviewed boundary.

Implement `lease_job`, `submit_result`, `abandon_job`, and `extend_lease`:

- validate each input against the exact frozen input schema before MCP-state or
  core mutation and reject additional properties;
- for `lease_job`, authorize the attempt and monotonic availability atomically,
  call core only for a nonzero bucket, preserve singular selection and payload
  invariance, pad the complete encoded response outside its parsed value, and
  return either the exact lease shape or the content-free
  `{ outcome: "no_work" }`;
- derive `ttl_bucket_seconds` from the durable lease snapshot through the
  frozen bucket function, never from payload type, queue depth, or response
  latency;
- pass `submit_result` only the mapped `WorkerId`, lease ID, input hash, and raw
  result. Preserve core's exact accepted receipt on replay and map failures only
  to `WORKER_WIRE_ERROR_CODES` with no validation detail;
- map the three abandon reasons exactly onto core's fair-attempt
  classifications and map holder/state refusal to the reviewed uniform shape;
- derive extension output from core's durable new expiry using the reviewed
  clock/bucket rule; every refusal has the same shape and comparable handler
  work; and
- validate every successful structured result against the frozen output schema
  before serializing the canonical text mirror.

Tests cover direct MCP calls, other-worker lease IDs, malformed and oversized
results, accepted replay after terminal lease conditions, conflicting replay,
contract expiry, admission/emergency halt, extension refusal classes, abandon
classifications, rate and availability races, output-schema identity, padding
buckets, timing-work equivalence hooks, and zero leakage of precise causes.

Checkpoint: all four job tools pass over the reference in-memory Store and the
PostgreSQL Store through the same authenticated MCP suite.

Implementation checkpoint: `MusterMcpJobToolDispatcher` validates the four
closed inputs before durable state, atomically authorizes mapping, rate, slot,
and availability policy, invokes the public lease/submission services, and
validates every exact result before emitting its canonical JSON mirror. The
request handler pads the complete JSON or SSE `lease_job` response outside the
parsed result. Focused tests cover zero-budget behavior, monotonic availability,
last-unit rate races, precise-cause suppression, exact submission replay,
abandon classifications and refusal, fixed and overflow expiry buckets, and
both transport modes. One authenticated real-core suite passes unchanged over
the reference in-memory Store and the PostgreSQL Store.

## Task 6: Worker tools and canonical skill releases (complete 2026-08-08)

Implement `get_worker_status` and `set_availability`:

- add an immutable `SkillReleaseRegistry` populated from canonical
  `renderSkill()` bytes, verified SHA-256, contract version, and the reviewed
  enrolled-class selection key; reject duplicate or ambiguous releases at
  construction;
- obtain status, contribution usage, assigned-slot projection, and contract
  acceptance only through the reviewed core status operation;
- return exactly `status`, `contract_version`, `skill_sha256`,
  `cap_usage_bucket`, and `next_slot_bucket`; never a resource URI, exact cap,
  exact next time, raw identity, provider account, queue state, or open leases;
- treat revoked workers as unauthenticated/unmapped according to the reviewed
  revocation order, because `revoked` is deliberately absent from the output
  schema; and
- route `set_availability` only through
  `ControlPlaneService.setWorkerAvailability`, allowing the frozen
  active/maintenance transition and projecting every other state through one
  reviewed non-probing failure path.

Tests exercise every visible worker state, probation, exact replay, invalid
transitions, worker revocation, mapping severance, concurrent state change,
all cap/slot bucket edges, skill-release ambiguity, and schema-exact results.

Checkpoint: all six frozen tools pass the authenticated protocol suite without
raw identity or precise operational leakage.

Implementation checkpoint: `SkillReleaseRegistry` now captures detached
deployment release definitions, renders them only through canonical
`renderSkill()` bytes, verifies their SHA-256 values, rejects duplicate or
ambiguous selection keys, and returns detached immutable releases selected by
accepted contract plus the complete enrolled class set. The two worker handlers
validate closed input, apply the same atomic mapping/rate/slot preflight as job
tools, project only the frozen coarse status fields, and invoke only
`ControlPlaneService.setWorkerAvailability` for active/maintenance changes.
Missing releases and every state or concurrency refusal share the generic
non-probing error. Focused tests cover all visible states, probation, every cap
and next-slot bucket edge, exact replay, invalid and concurrent transitions,
mapping severance, token revocation, release mismatch/ambiguity, schema-exact
results, and leakage. One authenticated six-tool suite passes unchanged over
the reference in-memory and PostgreSQL Stores.

## Task 7: Experimental skill Resource adapter (external gate recorded pending 2026-08-08)

External-gate checkpoint: [SEP-2640] remains open and unmerged, and the pinned
official TypeScript SDK v2 release exposes generic MCP Resources but no accepted
Skills Extension implementation. The repository therefore keeps this adapter
disabled and adds no experimental capability, resource index, resource URI, or
stable-schema field. This is the plan's required explicit pending outcome; it
does not authorize implementing the current draft shape. Re-evaluate the SEP,
the selected SDK, and a real target client's discovery support before resuming
this optional adapter.

[SEP-2640]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640

Keep hand installation normative and implement the optional adapter separately:

- expose no skill Resource or extension capability unless an explicit
  versioned experimental option is enabled;
- serve immutable canonical bytes already registered in
  `SkillReleaseRegistry`, with the same SHA-256 exposed by worker status;
- keep the resource URI and extension metadata out of all six stable tool
  schemas and results;
- expose only the worker's reviewed release after authentication and mapping;
- provide an index and resource reads in the then-current SEP-2640 shape only
  if the proposal is accepted and supported by the selected SDK at
  implementation time; otherwise leave the adapter disabled and record the
  external gate rather than freezing a draft; and
- reject path traversal, arbitrary URI fetch, mutable content, unregistered
  versions, cross-worker release discovery, and cache mixing.

Run experimental tests separately from the stable package gate. At least one
real target client must prove discovery and byte-identical resource reads
before README may describe the adapter as usable; failure does not block the
normative hand-install path or six base tools.

Checkpoint: stable wire is unchanged; experimental support is either evidenced
behind its version flag or explicitly recorded as pending.

## Task 8: Cross-adapter conformance and side-channel review

Export `runMusterMcpConformance` and execute it against both
`InMemoryStore` and `PostgresStore` with the same MCP-state conformance adapter:

- diff `tools/list` input/output schemas structurally against `TOOL_SCHEMAS`;
- run every frozen MCP fixture ID and every section-5.7 mitigation case;
- assert the reviewed availability rule: job selection is invariant to the
  bucket and precedes any permitted sizing; if Task 1 retains singular v1 jobs,
  prove availability changes neither selected job nor payload;
- assert coarse `no_work`, extension refusal, validation errors, status, and
  rate behavior reveal no forbidden discriminants;
- run mapping, token, scope, rate, slot, lease-holder, exact-retry, process-
  restart, and two-client races;
- prove raw OAuth identity and bearer material are absent from core/PostgreSQL
  queries, ledger, events, snapshots, errors, and package exports;
- compare successful results byte-for-byte across source and packed ESM/CJS
  imports; and
- rerun the prompt-injection corpus through the remote MCP layer, proving leased
  payload text remains data and cannot redirect tool registration or dispatch.

The old `gate/stub-mcp` remains a throwaway platform-assumption fixture and is
not imported or treated as runtime conformance evidence.

Checkpoint: one exported suite passes over both Store adapters and after
adapter/process restart.

## Task 9: Operations guide, real-client gate, and final review

- document handler mounting, canonical public URL configuration, authorization
  server requirements, RFC 9728 discovery, JWT/JWKS and revocation operations,
  scope grants, mapping bind/sever lifecycle, durable MCP-state responsibility,
  rate policy, key rotation, proxy/Origin rules, body limits, retention, and
  graceful shutdown ownership;
- document that OAuth subjects are personal data held only in the severable MCP
  mapping and that severance does not erase pseudonymous core audit history;
- add a fresh nonce-bound real-client gate that authenticates, calls
  `get_worker_status`, leases one sanitized job, and submits an accepted result
  without manual intervention after scheduling;
- preserve raw gate evidence outside worker-visible outputs and distinguish
  local protocol conformance from remote provider/account acceptance;
- run the full workspace gate, PostgreSQL 16 and 18 suites, packed-package MCP
  conformance, Markdown links/fences, package-content inspection, audit scans,
  and `git diff --check`; and
- independently review from OAuth metadata/token claims through mapping,
  scopes, MCP-state atomicity, all six handlers, core calls, Store effects,
  schemas, fixtures, error projections, and side-channel rows. Correct every
  finding before declaring the package complete.

No checkpoint authorizes npm publication, production deployment, provider
scheduling, a remote push, or consumer integration without an explicit
follow-up.

## Complete validation command

The final command is expected to include, at minimum:

```sh
pnpm install --frozen-lockfile
pnpm check:invariants
pnpm -r --if-present typecheck
pnpm build
pnpm test
pnpm -F @kuindji/muster-contract fixtures:check
pnpm -F @kuindji/muster-store-postgres test
pnpm -F @kuindji/muster-store-postgres test:packed
pnpm -F @kuindji/muster-mcp test:packed
(cd packages/mcp && npm pack --dry-run --json)
git diff --check
```

Run the PostgreSQL package gates again with the supported current-major image.
Markdown fence/local-link validation and explicit packed-tarball inspection
remain separate commands if they are not part of a workspace script.

## Stop boundaries

1. Task 1 is reviewed and tagged at `contract-freeze-16`; the Task-5 projection
   correction is reviewed and tagged at `contract-freeze-17`; stop after each
   later task at its own checkpoint.
2. Stop any runtime task that needs a new worker-visible field, caller-chosen
   policy value, non-atomic state comparison, or raw identity in core.
3. Keep stable tools independent of SEP-2640 and of any specific provider.
4. Treat local HTTP/JWKS tests, exported conformance, PostgreSQL persistence,
   packed-package tests, and real-provider scheduling as distinct gates.
5. Stop after the selected plan task and record the exact clean/ahead/tag/gate
   state. Do not begin the next task, publish, or push implicitly.
