# Changelog

## contract-freeze-1 — 2026-08-06

Milestone 1 of
`docs/specs/2026-08-04-muster-coordinator-design.md` revision 12 (§11.1).
Freezes: all public types (§11.1 list) in `@kuindji/muster-contract` and the
`@kuindji/muster-core` port/event skeleton (atomic-domain-command `Store`,
audit and notification event schemas); the action-gate, precedence,
fair-attempt, audit-source, queue-mode, quantization, and privacy-class tables;
pseudonymous core worker identity and severable MCP mapping boundary;
collection-cycle-scoped result lifecycle and requeue isolation; the worker and
contract lifecycle state machines; `input_hash` over the exact sanitized
payload and both schemas, `result_hash`, `decision_result_hash`,
`effect_intent_hash`, and verdict-hash envelopes with cross-checked golden
vectors; the declarative lifecycle/retry/invalidation fixture pack,
store-concurrency case list, and prompt-injection corpus; MCP tool,
availability, `no_work`, and uniform-error schemas; the skill source shape and
`skill_sha256`. Wire contract version: `1.0.0`.

Any change to these from now on is a freeze amendment: spec revision first.
