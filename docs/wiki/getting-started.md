---
title: Getting Started
parents: [README]
children: []
related_pages: [packages, integration/consumer-integration]
last_updated: 2026-08-09
---

# Getting started

Muster has not crossed its registry publication gate. Use a repository checkout
for evaluation and integration work; do not assume the package names currently
resolve to supported public releases.

## Prerequisites

- Node.js 20 or newer.
- Corepack with pnpm 10.14.0, as pinned by the workspace.
- Docker when running PostgreSQL/Testcontainers suites.
- PostgreSQL 16 or 18 for a durable deployment.

## Install and build from source

```sh
git clone https://github.com/kuindji/muster.git
cd muster
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Run the fast, database-free gate first:

```sh
pnpm check:invariants
pnpm --filter @kuindji/muster-contract typecheck
pnpm --filter @kuindji/muster-contract test
pnpm --filter @kuindji/muster-core typecheck
pnpm --filter @kuindji/muster-core test
```

Then exercise the deployable boundaries:

```sh
pnpm --filter @kuindji/muster-store-postgres test
pnpm --filter @kuindji/muster-mcp test
pnpm --filter @kuindji/muster-mcp test:packed
```

The PostgreSQL tests use disposable PostgreSQL 16 containers by default. See
the adapter [operations guide](../../packages/store-postgres/README.md) for
PostgreSQL 18 and managed-test-database options.

## Pick the next guide

- To evaluate boundaries and exports, read [packages](packages.md).
- To embed Muster into an application, follow
  [consumer integration](integration/consumer-integration.md).
- To expose authenticated worker tools, follow
  [MCP deployment](integration/mcp-deployment.md).
- Before using real workloads, review the [trust model](trust-model.md) and
  [production-readiness gate](operations/production-readiness.md).

The checked-in tests and conformance kits are executable examples of exact
construction. Treat them as examples, not as deployment policy: production
identities, clocks, job classes, rate limits, and verification policies must be
owned explicitly by the integrating system.
