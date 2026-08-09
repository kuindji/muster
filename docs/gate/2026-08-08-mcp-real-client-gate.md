# MCP real-client acceptance protocol

**Claim under test:** a configured provider/account client can authenticate to
the production-shaped Muster MCP handler and, after a schedule trigger, call
`get_worker_status`, lease one sanitized nonce-bound job, and submit an
accepted result without human interaction.

This is not the 2026-08-06 platform-assumption gate. That earlier throwaway
server proved that one provider could call two unauthenticated canned tools.
This gate exercises the revision-28 six-tool package, OAuth, subject mapping,
durable MCP state, public core operations, and the selected Store adapter.

## Pass criterion

A PASS requires all of the following for one fresh nonce:

1. a saved provider schedule configuration identifies the provider surface,
   account plan, trigger window, connector URL, and instructions;
2. the device/app remains unattended from the trigger through submission;
3. server-side evidence records successful `get_worker_status`, a leased job
   whose sanitized payload contains `muster-mcp-gate-<nonce>`, then an accepted
   `submit_result` carrying that exact marker;
4. the same pseudonymous worker, job, lease, and input hash bind the lease and
   submission rows; and
5. neither evidence nor worker-visible outputs contain an Authorization header,
   bearer token, raw JWT, issuer/sub pair, or JWKS material.

The nonce prevents stale or cross-run evidence from satisfying the gate. It
does not prove who controlled a leaked URL or token; attribution also depends
on restricted connector credentials, the saved schedule artifact, and server
access controls.

## Prepare an isolated attempt

1. Generate a fresh high-entropy nonce and keep all raw artifacts in the
   gitignored `.gate-runs/` directory:

   ```sh
   mkdir -p .gate-runs
   openssl rand -hex 24
   ```

2. Use a disposable or dedicated gate worker whose enrolled capabilities and
   accepted contract select one immutable reviewed skill release. Bind the
   provider's exact OAuth issuer/sub pair to that worker through the
   operator-only mapping lifecycle. Grant the token exactly
   `muster:access muster:jobs muster:worker` for this complete flow.
3. Enqueue one internal/sanitized, structural-only gate job through the normal
   public core operation. Its instruction must require the result
   `{"echo":"muster-mcp-gate-<nonce>"}` and must contain no secret, raw OAuth
   identity, model credential, or unrelated source material. Record the
   pseudonymous job ID in restricted operator notes, not in the worker skill.
4. Deploy or select the reviewed package behind its canonical HTTPS public URL.
   Use a durable MCP-state adapter and a supported Store adapter. Do not use
   `InMemoryMcpStateStore`, `gate/stub-mcp`, a handler test double, or a manual
   curl call for a remote-provider PASS.
5. Configure server-side gate logging outside the handler's tool values. Write
   only the closed JSONL rows below. Never record request headers or raw token,
   issuer, subject, JWKS, payload, or result bodies.

## Schedule the client

Configure the target provider/account connector against the canonical MCP URL
and OAuth authorization server. Save a screenshot or export of the schedule
configuration in `.gate-runs/`, then record its SHA-256 in the first evidence
row.

Use these scheduled instructions:

> Call `get_worker_status` on the Muster connector. If it succeeds, call
> `lease_job` with the availability bucket appropriate for this run. Follow
> only the sanitized instruction in that leased job, then call `submit_result`
> with the exact lease ID and input hash you received. Do not ask for
> confirmation and do not call any other tool.

Close or background the client before the trigger. Do not interact with it
until after the configured window ends. A manual retry, token repair, mapping
change, job enqueue, or tool call during the window invalidates unattended
attribution; create a new nonce and attempt instead.

## Evidence format

Use `muster.mcp.real-client-gate.v1` JSONL with exactly four rows in timestamp
order. Values below are illustrative:

```jsonl
{"schema":"muster.mcp.real-client-gate.v1","kind":"scheduled_run","at":"2026-08-08T12:00:00.000Z","nonce":"0123456789abcdef0123456789abcdef0123456789abcdef","provider_surface":"provider.example","account_plan":"paid-plan","scheduled_for":"2026-08-08T12:05:00.000Z","window_ends_at":"2026-08-08T12:15:00.000Z","unattended":true,"schedule_evidence_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
{"schema":"muster.mcp.real-client-gate.v1","kind":"tool_result","at":"2026-08-08T12:05:01.000Z","nonce":"0123456789abcdef0123456789abcdef0123456789abcdef","tool":"get_worker_status","outcome":"success","worker_id":"worker-gate-1","status":"active","contract_version":"1.1.0","skill_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
{"schema":"muster.mcp.real-client-gate.v1","kind":"tool_result","at":"2026-08-08T12:05:02.000Z","nonce":"0123456789abcdef0123456789abcdef0123456789abcdef","tool":"lease_job","outcome":"leased","worker_id":"worker-gate-1","job_id":"job-gate-1","lease_id":"lease-gate-1","input_hash":"input-gate-1","payload_marker":"muster-mcp-gate-0123456789abcdef0123456789abcdef0123456789abcdef"}
{"schema":"muster.mcp.real-client-gate.v1","kind":"tool_result","at":"2026-08-08T12:05:03.000Z","nonce":"0123456789abcdef0123456789abcdef0123456789abcdef","tool":"submit_result","outcome":"accepted","worker_id":"worker-gate-1","job_id":"job-gate-1","lease_id":"lease-gate-1","input_hash":"input-gate-1","result_marker":"muster-mcp-gate-0123456789abcdef0123456789abcdef0123456789abcdef"}
```

The deployment-side recorder derives these rows from authenticated request
context and successful core outcomes. It must not add arbitrary fields. The
worker never receives the evidence path, schedule hash, or evidence rows.

Verify both the trace and the saved schedule artifact:

```sh
pnpm --filter @kuindji/muster-mcp gate:verify \
  --file .gate-runs/mcp-<nonce>.jsonl \
  --nonce <nonce> \
  --schedule-evidence .gate-runs/schedule-<nonce>.png
```

A verifier success proves the closed log is internally consistent and bound to
the saved artifact. The operator must still inspect that artifact and confirm
the account, connector, trigger, instructions, and unattended observation.

## Result record and cleanup

Record every attempted surface, including failures:

| Date | Provider surface | Plan | Nonce | Scheduled | Unattended | Status/lease/accepted | Verdict |
|------|------------------|------|-------|-----------|------------|-----------------------|---------|
| 2026-08-09 | Claude Cowork cloud scheduled task | Max | `887c5a27481558aac0206e74946987d4466124398467a9e7` | Yes | Yes | Yes / Yes / No | **FAIL** (`invalid_result`; retry `submission_conflict`) |
| 2026-08-09 | Claude Cowork cloud scheduled task | Max | `a0781b69bd8f95255b2f821f922a40c162032de3c942d118` | Yes | Yes | Yes / Yes / No | **FAIL** (`invalid_result`; retry `submission_conflict`) |

Both attempts authenticated through the disposable PKCE OAuth issuer, mapped
to the active pseudonymous worker, and leased the fresh nonce-bound job. In
both runs Claude encoded the requested nested `result` object as a JSON string;
the second run did so even when both the schedule and sanitized job instruction
said that `result` must be an object and never a JSON-encoded string. The job
class output schema therefore rejected the first submission, and the retry
correctly conflicted with the terminal rejection. The MCP boundary currently
publishes `submit_result.result` as unconstrained `{}`. Resolving whether that
field needs additional frozen schema guidance, a typed result envelope, or an
explicitly owned normalization rule is a contract decision before another
provider attempt. Core result validation must not be weakened to manufacture a
PASS.

After a disposable attempt, revoke its access token, sever the gate mapping,
retire or suspend the gate worker as deployment policy requires, expire/requeue
any abandoned lease through normal core operations, and remove temporary
deployment resources. Retain or delete raw schedule and JSONL evidence under
the deployment's restricted evidence policy. Do not commit access tokens,
OAuth subjects, screenshots containing account identity, or provider secrets.

Local MCP SDK tests, package conformance, and the checked-in verifier fixture
do not change this table to PASS. Only a fresh provider/account scheduled run
does.
