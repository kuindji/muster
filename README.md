# Muster

Muster coordinates bounded, verified work across volunteer AI agents without
performing model inference itself.

It gives untrusted workers sanitized, schema-bound, one-shot jobs over MCP,
checks what comes back against an explicit verification policy, and issues
evidence-bound authorizations for trusted consumers. It is designed for systems
that need stronger coordination and auditability than “send a prompt and trust
the answer.”

> [!IMPORTANT]
> The implementation and unattended real-provider MCP gate are complete, but
> the packages have not crossed the publication gate. Evaluate Muster from this
> repository. Registry publication remains blocked until a consumer integration
> succeeds.

## What Muster provides

- A frozen contract for job classes, payload and result schemas, worker state,
  verification, adjudication, and action authorization.
- Deterministic coordinator services for registration, routing, leasing,
  submission, verification, disputes, health, and operational evidence.
- A PostgreSQL Store adapter with forward migrations and cross-adapter
  conformance coverage.
- An OAuth-protected, stateless MCP server exposing six worker tools over
  Streamable HTTP.
- Privacy boundaries that keep raw OAuth identity outside the core coordinator
  and durable job history.

Muster does **not** guarantee that an ordinary worker result is correct. It does
not run models, issue OAuth tokens, choose a provider, execute arbitrary side
effects, or make a consumer obey an authorization. Those responsibilities stay
with the deployment and the integrating application.

Read the [trust model](docs/wiki/trust-model.md) before deciding whether Muster
fits a workload.

## How it works

1. A deployment registers a versioned job class with closed payload and result
   schemas plus a verification and action policy.
2. A trusted consumer sanitizes and enqueues a one-shot job.
3. An authenticated worker leases the job through MCP and receives only the
   bounded payload and output schema it needs.
4. Muster validates the submission, applies the class policy, and either
   accepts, requeues, escalates, or rejects it.
5. When the evidence is strong enough, Muster records the result and may issue
   an evidence-bound action authorization for the trusted consumer to enforce.

Workers never choose their own capabilities or job classes at lease time.
Availability affects whether a worker asks for work, not which job is selected
or what payload it receives.

## Packages

| Package | Purpose |
|---|---|
| `@kuindji/muster-contract` | Schemas, canonical hashing, lifecycle tables, skill rendering, and frozen fixtures |
| `@kuindji/muster-core` | Store-parametric coordinator services and the reference in-memory Store |
| `@kuindji/muster-store-postgres` | PostgreSQL 16/18 persistence, migrations, bootstrap, and transaction handling |
| `@kuindji/muster-mcp` | OAuth-protected MCP transport, worker tools, subject mapping, rate state, and conformance |

See the [package guide](docs/wiki/packages.md) for boundaries and selection
advice.

## Evaluate from source

Muster currently requires Node.js 20 or newer and pnpm 10.14.0.

```sh
git clone https://github.com/kuindji/muster.git
cd muster
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Docker is required for the PostgreSQL Testcontainers suites. For a shorter
first pass, run the invariant check and the in-memory contract/core suites:

```sh
pnpm check:invariants
pnpm --filter @kuindji/muster-contract test
pnpm --filter @kuindji/muster-core test
```

Continue with the [getting-started guide](docs/wiki/getting-started.md).

## Integration paths

- **Application integrator:** start with
  [consumer integration](docs/wiki/integration/consumer-integration.md) to map
  your job classes, trust decisions, and authorization enforcement.
- **MCP deployment operator:** use the
  [MCP deployment guide](docs/wiki/integration/mcp-deployment.md) and the
  package's detailed [operations guide](packages/mcp/README.md).
- **Persistence operator:** use the PostgreSQL adapter's
  [construction and operations guide](packages/store-postgres/README.md).
- **Worker or client author:** follow the canonical skill release supplied by
  the deployment; the stable interface is the six-tool MCP surface, not an
  inferred internal API.
- **Contributor or reviewer:** use the
  [documentation map](docs/wiki/README.md) to reach the frozen specification,
  implementation plans, gate protocols, and changelog.

## Project status

The one-shot coordinator, PostgreSQL adapter, and MCP package have completed
their local and remote acceptance gates. The current internal boundary is
revision 29, tagged `contract-freeze-18`; the worker wire remains `1.1.0`.

Publication, a durable production deployment, and a successful consumer
integration are separate from those completed implementation gates. See
[production readiness](docs/wiki/operations/production-readiness.md) for the
current boundary and [CHANGELOG.md](CHANGELOG.md) for implementation history.

## Documentation

The [Muster wiki](docs/wiki/README.md) is the consumer-oriented entry point.
Normative and historical material remains in:

- [the coordinator specification](docs/specs/2026-08-04-muster-coordinator-design.md);
- [the deferred staged/effecting-work design](docs/specs/2026-08-04-muster-staged-and-effecting-design.md);
- [research and prior-art notes](docs/research/);
- [implementation and contract-freeze plans](docs/superpowers/plans/);
- [acceptance protocols and evidence](docs/gate/); and
- [the changelog](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
