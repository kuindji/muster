---
title: Muster Project Wiki
parents: []
children: [overview, trust-model, getting-started, packages, integration, operations]
related_pages: []
last_updated: 2026-08-09
---

# Muster Project Wiki

This is the quick-understanding knowledge base for Muster consumers,
deployment operators, worker-client authors, and contributors. It explains the
product and its operating boundaries at a high level; the frozen specification,
plans, tests, and package guides remain the source for exact contracts.

## Choose a path

- [Overview](overview.md) — what Muster is, the problem it solves, and the
  one-shot workflow.
- [Trust model](trust-model.md) — what Muster guarantees, what it cannot
  guarantee, and which parties remain trusted.
- [Getting started](getting-started.md) — prerequisites, source installation,
  the first verification pass, and where to go next.
- [Packages](packages.md) — how the four packages divide responsibility.
- [Integration](integration.md) — paths for MCP deployment and trusted consumer
  integration.
- [Operations](operations.md) — security ownership and production-readiness
  gates.

## Exact and historical references

- [Coordinator specification](../specs/2026-08-04-muster-coordinator-design.md)
  — the normative revision-29 coordinator design.
- [MCP implementation plan](../superpowers/plans/2026-08-08-muster-mcp.md)
  — task-by-task implementation and acceptance provenance.
- [MCP real-client protocol](../gate/2026-08-08-mcp-real-client-gate.md) — the
  unattended provider/account acceptance gate.
- [AI Horde research note](../research/2026-08-04-ai-horde-reference.md) — prior
  art, non-transferable assumptions, and the clean-room boundary.
- [Changelog](../../CHANGELOG.md) — chronological contract and implementation
  checkpoints.

## Keeping this wiki current

Each page carries `parents`, `children`, and `related_pages` front matter so
the navigation graph is explicit. Keep pages short, update the relevant page
with the code or operating change, and use repository-relative Markdown links
so the wiki works in GitHub as well as the existing Obsidian vault. Detailed
revision history belongs in the changelog, specs, plans, and gate records—not
in this consumer layer.
