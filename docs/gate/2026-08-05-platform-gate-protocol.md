# Platform gate protocol (spec §9)

**Claim under test:** a scheduled task on a mobile-manageable AI provider plan
can execute a skill and call a remote MCP connector unattended.

**Pass criterion:** the run's fresh `gate-log.jsonl` contains a `lease_job`
call followed by a `submit_result` call whose outcome is `accepted` (that is,
the result echoed `muster-gate-<nonce>` for this run's nonce), both produced by
a provider-scheduled run with **no human interaction between schedule trigger
and submit**—screen locked or app backgrounded for the entire window. The nonce
binding is the anti-forgery control: the stub is public and unauthenticated, so
a stale log, a manual call, or a third party hitting the URL must not be
mistakable for the scheduled run. A wrong-nonce or nonce-free submission is a
FAIL for attribution purposes even if tools were called.

## Procedure

1. Deploy the stub where the provider can reach it, with a **fresh nonce and a
   fresh log file for every attempt**. Export the nonce first—a same-command
   assignment would expand `$GATE_RUN_NONCE` before it is set and silently
   reuse one log file for every run:

   ```sh
   export GATE_RUN_NONCE="$(date +%s)-$RANDOM"
   export GATE_LOG_PATH="./gate-$GATE_RUN_NONCE.jsonl"
   pnpm -F muster-gate-stub start
   ```

   The stub refuses to start if `GATE_LOG_PATH` already exists. Expose it via a
   public HTTPS tunnel (for example,
   `cloudflared tunnel --url http://localhost:8787`); the tunnel's random
   subdomain doubles as an unguessable per-run URL. Do not post it anywhere,
   and tear it down after each session. The stub holds no secrets and accepts
   no auth. **Scope of the nonce claim:** the nonce rules out stale logs and
   cross-run confusion; a third party who obtained this run's tunnel URL could
   still call the tools, so attribution ultimately rests on the URL staying
   private and the operator's schedule evidence.
2. On the provider app (first target: Claude mobile/desktop with a scheduled
   task), add the tunnel URL plus `/mcp` as a custom connector with no auth.
3. Create a scheduled task whose instructions are, verbatim:

   > Call the muster-gate-stub connector tool lease_job. Follow the instruction
   > in the payload it returns, then call submit_result with the lease_id and
   > input_hash you received and your result. Do not ask for confirmation.

4. Lock the device or close the app before the scheduled time. Do not touch it
   until after the window.
5. After the window, inspect `gate-log.jsonl`.

## Result log

| Date | Provider surface | Plan | Nonce | Scheduled? | Unattended? | Accepted echo? | Verdict |
|------|------------------|------|-------|------------|-------------|----------------|---------|
| 2026-08-06 | Claude Cowork scheduled task (mobile-managed) | Paid Cowork plan | `20260806T085811Z-eac66456bb2215ec` | Yes | Yes | Yes | **PASS** |

The provider UI advanced from the approximately 15:00 occurrence to the next
approximately 16:00 occurrence after the run. The committed raw evidence records
`lease_job` at 15:10:38 Asia/Yerevan followed by an accepted nonce-bound
`submit_result` at 15:10:43; no manual tool call was made against this nonce.

For every PASS row, commit the raw `gate-<nonce>.jsonl` next to this document
and keep a screenshot or export of the provider's schedule configuration. The
row is a claim; the log and schedule evidence are what make it checkable.

A `PASS` verdict on at least one provider surface unblocks Milestone 1
(contract freeze). Record failures too: a failed surface is enrollment
capability data (§3.2, §9—“Hosted scheduled-agent execution is an adapter
capability recorded at enrollment”).
