# Muster platform-gate stub

This is the throwaway remote MCP server used only to test the platform
assumption in coordinator spec §9. It exposes exactly `lease_job` and
`submit_result`, binds each attempt to a fresh nonce, and writes the calls to a
JSONL evidence log.

Follow the complete [real-device gate protocol](../../docs/gate/2026-08-05-platform-gate-protocol.md)
for deployment, scheduling, evidence capture, and the pass criterion.

For a local run:

```sh
export GATE_RUN_NONCE="$(date +%s)-$RANDOM"
export GATE_LOG_PATH="./gate-$GATE_RUN_NONCE.jsonl"
pnpm -F muster-gate-stub start
```

Throwaway. Never import from `@kuindji/muster-*`, never publish, and delete
after the gate passes on a second provider surface.
