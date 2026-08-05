# AI Horde as a design reference for Muster

**Date:** 2026-08-04

**Status:** Research. Open subject — this is a first pass over public material,
not a settled reading.

**Sources read:** the [AI Horde repository README][repo], [FAQ][faq],
[CHANGELOG][changelog], [kudos.md][kudos], and the [worker contribution
docs][contribute]. **Source code was not read.** That distinction is
deliberate: Muster is Apache-2.0 and AI Horde is AGPL-3.0-or-later, so Muster
studies AI Horde's design and never copies its code, schemas, or documentation
text. Architecture ideas are not copyrightable; expression is.

[repo]: https://github.com/Haidra-Org/AI-Horde
[faq]: https://github.com/Haidra-Org/AI-Horde/blob/main/FAQ.md
[changelog]: https://github.com/db0/AI-Horde/blob/main/CHANGELOG.md
[kudos]: https://github.com/Haidra-Org/haidra-assets/blob/main/docs/kudos.md
[contribute]: https://aihorde.net/contribute/workers/

## 1. Why it is the closest prior art, and why it is only half of one

AI Horde coordinates volunteer GPUs that generate images and text. The workers
are untrusted, the capacity is donated, the coordinator owns a queue, leases,
reputation, and an incentive economy. That is the same shape as Muster's
distribution half.

The verification half has no counterpart. AI Horde's output is an image; there
is no ground truth to check it against, so the system has no output schema, no
input binding, and no cross-worker adjudication. The FAQ is candid that a
worker can read the prompts it processes ("Technically, yes").

Two further divergences run deep enough to invalidate straight ports:

- **Worker economics.** AI Horde volunteers contribute hardware they own and
  control. Muster workers contribute allowance inside a provider's cloud that
  they do not control, on a schedule the provider executes. Cadence, caps, and
  capacity math all differ from that root.
- **Unit of work.** AI Horde prices a job in GPU-seconds, estimated by a neural
  model. Muster's unit is one agent turn against an opaque allowance the
  coordinator cannot measure and must not try to.

## 2. Mechanics worth adopting

| # | AI Horde mechanic | Evidence | Muster adaptation |
|---|---|---|---|
| 1 | Credit for availability, not only completion — kudos accrue for being online in 10-minute increments | kudos.md | An authenticated `no_work` attempt counts for contribution. Convergent with what the first consumer's design reached independently; treat that convergence as support for the rule |
| 2 | Escrow for new workers — uptime earnings held until trusted, requiring "at least a week of wait-time" plus completed jobs | changelog v4.9.0, kudos.md | Probation state: smaller batches, lower concurrency, elevated canary rate until N successes over at least T days |
| 3 | Trust gates privileges, never truth — trusted status raises the workers-per-IP cap from 3 to 20 and permits VPN use; it never asserts output correctness | changelog v4.9.0, v4.11.0 | Reputation is a routing signal only. Already Muster's rule; AI Horde is the existence proof that it holds up in production |
| 4 | Suspicion counters with automatic pause and human notification — workers accrue suspicion when they lose too many jobs in an hour; high suspicion auto-pauses; moderators are notified | changelog v2.1, v4.14.0, v4.16.3 | Core owns rolling-window suspicion counters and the auto-pause transition, and emits `onSuspicion`. The human queue is the consumer's |
| 5 | Poison-job ceiling — "Uncompleted jobs will now be restarted. A request which ends up with 3 restarted jobs will abort" | changelog v2.1 | Requeue is capped; a job exceeding the cap moves to `aborted` and escalates. Without this, a malformed job burns volunteer allowance indefinitely |
| 6 | Algorithmic TTL with a post-pickup floor — TTL scales with request complexity, and "Ensure jobs don't expire soon after being picked up" | changelog v4.43.0, v4.40.3 | `TaskType.leaseTtl(payload)` plus a floor applied after handoff |
| 7 | Capability filtering at pop time — "Prevent workers without flux support picking up flux jobs" | changelog v4.43.0 | Filter on surface and plan capability, above all whether the member's plan actually executes unattended scheduled tasks |
| 8 | Worker-declared maintenance — a worker sets maintenance and receives no new jobs without losing standing | Horde SDK worker docs, contribute docs | A first-class `maintenance` worker state. Softer and better than a binary grace window for travel or a plan change |
| 9 | Worker-reported terminal state — a `state` key reporting `faulted` or `censored` | changelog v3.6.0 | A worker-reported reason on abandon and submit, consumed as a **hint** to fair-attempt classification, never as truth |

## 3. Mechanics to deliberately avoid

1. **Priority set by balance rather than by spend, with balances that never
   expire.** Queue position follows the kudos a user *holds*, and kudos "never
   expire" (kudos.md). Standing therefore ossifies: early contributors keep
   permanent advantage. The project is left asserting that "Kudos is merely a
   prioritization mechanism, not a currency" (FAQ) and banning sale in its
   terms — policing an incentive its own design created. **Muster must decide
   explicitly whether standing decays.** See the spec's open questions.
2. **Punishment routed through the economy** — "Flagged users with 0 kudos will
   have lower priority than anon" (changelog v4.23.0). Anti-abuse and
   incentives should stay separate mechanisms; merging them makes both harder
   to reason about.
3. **Transferable credit without rate limits** — transfers had to be capped at
   1/sec "to prevent race condition abuse" (changelog v4.12.1). If Muster ever
   gains transferable standing, it inherits this problem on day one.

## 4. What does not port at all

- **IP-based Sybil resistance.** `TooManySameIPs`, IPv6 /64 range blocks,
  week-long IP bans that also block new registrations, and VPN gating for
  untrusted workers (changelog v4.9.0, v4.20.0) are reasonable against home
  GPUs. Muster's workers arrive from provider clouds, and its members sit
  behind mobile carrier NAT. **This leaves Sybil resistance unsolved in
  Muster, and the documentation must say so rather than imply otherwise.**
- **Compute-priced work units.** See section 1.
- **A model marketplace.** AI Horde workers self-select which models they
  serve. Muster workers must never select their own content; that constraint
  is load-bearing for the operator-exposure argument.
- **Capacity modelling.** Always-on hardware versus scheduled provider-cloud
  runs.

## 5. Adjacent finding: skills served over MCP

Not from AI Horde, but surfaced by the same sweep and load-bearing for Muster's
distribution story.

The [Skills Over MCP Working Group][wg] standardizes how agent skills are
discovered and served **from an MCP server**. Its current direction is
[SEP-2640 — Skills Extension][sep], Resources-based, on the Extensions Track,
**in review** as of the charter's 2026-04-25 changelog entry. The group formed
as an interest group in February 2026 and became a working group in April, and
coordinates with the [agentskills.io][as] content-format and well-known-URI
discovery spec.

Consequence adopted into the spec: the coordinator serves the worker skill as
an MCP Resource from v1. The skill and the wire contract cannot drift, and a
contract bump does not require every member to reinstall by hand. Because
client support is unproven on the ChatGPT and Claude mobile apps, the served
Resource and the hand-install packages are both renderings of one generated
source, and hand-install remains the v1 fallback path.

[wg]: https://modelcontextprotocol.io/community/working-groups/skills-over-mcp
[sep]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
[as]: https://agentskills.io/

## 6. Open threads

- Lease and priority internals were not established from public documentation;
  the changelog gives behaviour, not thresholds. Reading the source would
  settle them, and is permissible for understanding, but raises the
  clean-room bar for anyone who then writes Muster's equivalent code.
- No evidence was found of prior art for verified, schema-bound distributed
  work over MCP. This matches the conclusion of the first consumer's market
  research and should be re-checked before Muster's first public release.
- Whether AI Horde's escrow and probation thresholds (roughly a week plus a
  volume gate) are tuned or arbitrary is unknown, and Muster should measure its
  own rather than inherit the numbers.
