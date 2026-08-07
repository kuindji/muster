# Muster contract-freeze amendment 14: class-health policy set

**Goal:** Amend revision 24 so class-wide adjudication health cannot be derived
from an arbitrarily selected contract version or published across a concurrent
version change.

**Scope:** Internal Store/core boundary and policy aggregation only. The worker
wire remains `1.1.0`. This amendment does not implement Task-8 health runtime.

## Finding: versioned thresholds drive class-wide health

`JobClass.adjudication` belongs to `(classId, contractVersion)`, while
`ClassHealthSnapshot` and `AdjudicationCapacity` are class-wide. Active and
draining versions may coexist. Revision 24 neither lists the complete durable
version set nor defines how Task 8 combines their rate, dwell, freshness, and
restoration thresholds. Accepting a caller-selected version could hide demand
or select the weakest gate.

Add `listClassVersions(classId)` and require `refreshClassHealth` to compare the
complete returned record set with health and adjudication load in the same
transaction. Core loads every durable `active` or `draining` runtime version;
an absent or schema-incompatible runtime fails closed. Policies aggregate as:

- sum `requiredRatePerWeek` across live versions;
- sum `restoreAbovePerWeek` across live versions;
- take the minimum `starvationDwell` and `capacityMaxAge` across live versions;
- versions with no adjudication policy contribute zero and do not weaken a
  version that has one.

If no live version requires adjudication, automatic health refresh clears only
an unstarved unsafe marker; it never restores a previously starved class without
an operator action. Registration or lifecycle change after inspection makes the
atomic refresh conflict.

Executable coverage includes active-plus-draining aggregation, runtime/schema
mismatch refusal, and a version-transition race. The reviewed boundary is
tagged locally as `contract-freeze-14`; Task 8 runtime resumes only after that
checkpoint.
