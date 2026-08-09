# @kuindji/muster-mcp

Mountable OAuth-protected MCP resource server for Muster's revision-29
coordinator boundary. The package supports Node.js 20 or newer, the stateless
`2026-07-28` Streamable HTTP protocol, and the SDK's `2025-11-25`
compatibility path. It exposes the six frozen worker tools; it does not issue
tokens, open a listener, terminate TLS, schedule workers, or own core policy.

## Construct and mount the handler

Construct the core services, the deployment's durable MCP-state adapter, and
the authorization boundaries before creating the handler. The in-memory
`McpStateStore` is a reference and conformance implementation, not production
durability.

```ts
import {
  DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS,
  createMusterMcpConfig,
  createMusterMcpHandler,
} from "@kuindji/muster-mcp";

const config = createMusterMcpConfig({
  resourceUrl: "https://muster.example/mcp",
  endpointPath: "/mcp",
  audience: "https://muster.example/mcp",
  authorizationServers: [{
    issuerUrl: "https://login.example/",
    jwksUrl: "https://login.example/.well-known/jwks.json",
    algorithms: ["RS256"],
  }],
  allowedOrigins: ["https://client.example/"],
  bodyLimitBytes: 1_048_576,
  clockSkewSeconds: 30,
  toolDescriptions: DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS,
});

const handler = createMusterMcpHandler(config, {
  authentication: {
    clock,
    revocationSource,
    stateStore: durableMcpStateStore,
    workerStatus,
  },
  jobTools: {
    stateStore: durableMcpStateStore,
    rateLimitPolicy,
    leaseService,
    submissionService,
  },
  workerTools: {
    stateStore: durableMcpStateStore,
    rateLimitPolicy,
    controlPlaneService,
    skillReleaseRegistry,
  },
});

// Adapt the platform request to a web-standard Request, preserve its public
// URL, and return the web-standard Response without rewriting the body.
const response = await handler.fetch(request);
```

Route both `POST /mcp` and these read-only RFC 9728 metadata paths to the same
handler:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`

The configured `resourceUrl`, `audience`, request URL, and external Host must
all be the same canonical HTTPS resource. Configure the reverse proxy to pass
that public URL into the application. Do not derive it from
`Forwarded`/`X-Forwarded-*` headers inside the handler, and do not mount the
same handler under aliases, query-bearing URLs, or an internal origin.

Origin checks apply when a client sends `Origin`. List only exact HTTPS
origins that are permitted to call the endpoint; an absent Origin is valid for
non-browser clients. The deployment owns TLS, trusted-proxy configuration,
connection and header limits, request timeouts, and denial-of-service controls.
The package enforces its configured request-body byte limit before JSON parsing.

## Authorization server and tokens

Muster is an OAuth protected resource, not an authorization server. The
authorization server owns authorization code plus PKCE, client registration,
consent, refresh tokens, access-token issuance, and its RFC 8414 metadata. It
must issue short-lived RFC 9068 JWT access tokens with:

- protected type `at+jwt`, an allowed pinned algorithm, and a non-empty `kid`;
- exact `iss`, exact resource `aud`, stable `sub`, `iat`, and `exp` claims;
- `muster:access` plus `muster:jobs` for job tools or `muster:worker` for worker
  tools; and
- no wildcard substitute for the three frozen scopes.

Publish the configured JWKS URL over HTTPS with normal HTTP cache headers.
During key rotation, publish the new verification key before issuing tokens
that name its `kid`, retain old keys until every token plus clock-skew window
has expired, and then remove them. An unknown `kid` causes one forced refresh;
a missing `kid` or malformed key fails closed.

Every protected request performs a mandatory revocation read using only the
canonical issuer, SHA-256 fingerprint of the bearer bytes, and request time.
The revocation source must be highly available and must not log the bearer.
Outage or ambiguity fails authentication. Token validation, revocation,
scopes, mapping, worker status, and closed input are checked in that order.
For `submit_result`, the duplicate-safe `result_json` parse and JCS-domain
check then run before atomic rate/slot state authorization.

Successful leases disclose the selected class's exact validated
`output_schema`. Serialize one value matching that schema once as JSON text and
send the text in `submit_result.result_json`. A string-root result includes its
JSON quote characters. Never send the old `result` field or encode an object or
array as a JSON string value.

## Subject mapping and privacy

OAuth issuer/subject pairs are personal data. They may exist only in the
deployment's severable MCP mapping. Bind and sever them through the
operator-only `McpSubjectLifecycleService`; those methods are intentionally not
worker tools. Use opaque command IDs, exact expected revisions, and audited
operator authorization around every lifecycle command.

Core, PostgreSQL Store rows, events, receipts, hashes, tool values, and gate
evidence receive only the opaque `WorkerId`. Severance removes the live raw
subject mapping and blocks later authentication. It does not delete or rewrite
pseudonymous core audit history, rate history, lease history, or aggregate
counts. Retention and erasure for active mappings, severance receipts,
revocation records, access logs, and gate artifacts remain deployment-owned;
set durations from the applicable lawful basis and incident requirements.

Do not log Authorization headers, access tokens, raw JWT claims, issuer/sub
pairs, JWKS bodies, request bodies, leased payloads, submitted result bodies,
or worker-visible tool responses. Operational logs may use pseudonymous worker,
binding-command, policy, and request correlation IDs where needed.

## Durable state and policy

A production `McpStateStore` must durably and atomically implement the exported
conformance suite. It owns one-to-one subject mapping, severance, complete rate
policy snapshots, UTC rate windows, per-slot lease-attempt counters, and
equal-or-lower availability. Do not put those comparisons in process memory,
an MCP session, or independent row updates.

Treat the complete `McpRateLimitPolicy` as versioned deployment configuration.
A change gets a new wire-safe version; do not rewrite a live version in place.
Set per-tool window limits and the per-slot lease-attempt limit from observed
capacity and abuse controls. These limits must not encode job content,
priority, or payload size. Availability remains worker-reported coarse state
and never changes v1 job selection or payload.

The deployment also owns the immutable `SkillReleaseRegistry`. Install a
release only after verifying its rendered bytes and SHA-256 against the exact
accepted contract plus complete enrolled class set. The experimental Skills
Resource adapter remains disabled while its external protocol gate is pending;
hand installation is the stable path.

## Operations and shutdown

Monitor authentication failures without precise worker-visible causes, JWKS
refresh failures, revocation-source availability, mapping conflicts,
rate/slot refusals, handler latency, core outcomes, and Store health. Keep
OAuth identity dimensions out of core metrics and logs. Alerts may correlate
pseudonymous IDs through restricted operator tooling only.

For a graceful stop:

1. remove the instance from readiness and stop accepting new HTTP requests;
2. allow in-flight handler promises to settle within the deployment deadline;
3. call `await handler.close()` to close the MCP SDK boundary;
4. close deployment-owned HTTP listeners and background revocation/JWKS
   resources; and
5. after all Store traffic has stopped, close deployment-owned database pools.

The handler does not close injected services, state adapters, or pools. A
forced process stop may interrupt an HTTP response, but durable Store and
MCP-state commands retain their own atomic replay semantics.

## Real-client acceptance

Local SDK tests, cross-adapter conformance, packed-package parity, and a
provider/account scheduled run are separate gates. Follow the
[nonce-bound real-client protocol](https://github.com/kuindji/muster/blob/main/docs/gate/2026-08-08-mcp-real-client-gate.md)
for the remote acceptance gate. Before the unattended trigger, pre-authorize
exactly `get_worker_status`, `lease_job`, and `submit_result` through the
provider's durable scheduled-run permission control; prompt text does not grant
tool permission. For the isolated gate job, call `lease_job` with `availability`
set exactly to `{"budget_bucket":1}`; bucket zero truthfully returns `no_work`
without a core lease call. Server-side evidence stays outside worker outputs
and is checked from a repository checkout with:

```sh
pnpm --filter @kuindji/muster-mcp gate:verify \
  --file .gate-runs/mcp-<nonce>.jsonl \
  --nonce <nonce> \
  --schedule-evidence .gate-runs/schedule-<nonce>.png
```

## Verification

```sh
pnpm --filter @kuindji/muster-mcp typecheck
pnpm --filter @kuindji/muster-mcp test
pnpm --filter @kuindji/muster-mcp test:packed
pnpm --filter @kuindji/muster-mcp test:gate-verifier
(cd packages/mcp && npm pack --dry-run --json)
```
