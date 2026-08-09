# Muster proposed contract-freeze amendment 18: MCP result JSON

**Goal:** Resolve the real-client `submit_result` interoperability finding with
one unambiguous representation for every Muster Schema 1 result root, without
weakening job-class validation or guessing whether a string is data or encoded
JSON.

**Status:** Independently reviewed and corrected proposal for revision 29;
implementation and a local `contract-freeze-18` tag remain separate.

**Scope:** Exact MCP tool schemas, the public lease projection, canonical skill
text, request ordering, stable fixtures, coordinator prose, and focused tests.
This amendment does not implement the MCP parser/handler change, rerun a remote
provider gate, publish, deploy, or push. Core worker wire remains `1.1.0`.

## Finding

The first two production-shaped Task-9 attempts authenticated, returned active
status, and leased their nonce-bound jobs. In both runs the provider encoded the
required nested result object as a JSON string. Core correctly rejected that
value against the class's frozen object output schema and made the invalid
submission terminal.

The MCP catalog currently publishes `submit_result.result` as `{}`. That shape
admits every JSON value but does not distinguish a legitimate string-root
result from JSON text encoding an object, array, scalar, or null. The lease
projection also omits the class's frozen `outputSchema`, so the stable MCP
surface does not machine-publish the exact schema that core will enforce.

## Independent review findings and corrections

The semantic trace found four underspecified edges in the initial proposal:

1. Calling the disclosed value merely a schema object was weaker than the
   existing Muster Schema 1 registration boundary. The corrected decision
   requires the projected value to pass `validateMusterSchema()` and to be the
   exact selected class-version schema, not an independently reconstructed
   MCP approximation.
2. `CanonicalJsonValue` is a TypeScript type, not a runtime validator. Parsing
   alone would admit a string containing an unpaired Unicode surrogate, and a
   conventional JSON parser would silently collapse duplicate object member
   names. The corrected boundary rejects both before MCP-state authorization
   and confirms the parsed value by successful JCS canonicalization.
3. The original acceptance row said “trailing JSON texts” were invalid while a
   later row deliberately accepted insignificant whitespace. The corrected
   rule permits RFC 8259 JSON whitespace around the one value and rejects only
   trailing non-whitespace data.
4. Transport body limiting and outer JSON-RPC parsing already precede the
   authenticated tool-dispatch order. The corrected ordering retains that
   preflight and inserts only the nested `result_json` validation before the
   existing atomic MCP-state command. Core still applies the canonical parsed
   result's lease-snapshotted `maxResultBytes`; the nested text is not a second
   core result identity.

## Decision

### Lease the exact output schema

A successful `lease_job` result adds `output_schema`. Its value is a detached
copy of the exact validated Muster Schema 1 `JobClass.outputSchema` selected by
`LeaseService` for that lease. `LeaseService.leaseJob()` owns the projection
because it already resolves the compatible class entry before the atomic
claim. The MCP package only renames `outputSchema` to `output_schema` and
validates the complete frozen output shape. The successful core outcome carries
the detached schema alongside the durable lease and payload; no mutable
`RuntimeClassEntry` or registry handle crosses the service boundary. Before
returning it, MCP requires `validateMusterSchema(outputSchema).ok`, clones it
again, and validates the complete closed lease output.

The schema is worker-visible by necessity and already enters `input_hash`.
Exposing it changes neither candidate selection, the claimed payload, the
input hash, nor core validation. It remains inside the complete padded lease
response, so the existing response-size side-channel rule still applies.

### Submit explicit JSON text

`submit_result` replaces the ambiguous `result` property with exactly one
required string property named `result_json`. The string contains one complete
JSON text representing the result value. Examples:

```json
{"result_json":"{\"answer\":\"ok\"}"}
{"result_json":"[1,2,3]"}
{"result_json":"\"a legitimate string result\""}
{"result_json":"null"}
```

After closed MCP input-schema validation and before `McpStateStore.authorizeCall`,
the MCP boundary parses the nested `result_json` exactly once with a
duplicate-member-detecting JSON parser. It permits RFC 8259 whitespace around
the single value, rejects duplicate names at every object depth, and rejects
any trailing non-whitespace data. Duplicate-name comparison uses the decoded
member strings, so `"answer"` and `"\u0061nswer"` are the same name. The parsed
value must then successfully JCS canonicalize, which makes its runtime domain
exactly null, boolean, well-formed string, finite JavaScript number, dense
array, or plain object with recursively valid values. Invalid JSON, duplicate
names, non-finite parsed numbers, ill-formed Unicode strings, or any other
uncanonicalizable value is an invalid tool input and invokes neither MCP state
nor core.

The boundary passes only the parsed value to `SubmissionService.submitResult`.
Core retains exclusive ownership of the lease-snapshotted byte limit, the
class output schema, validators, oracles, settlement, terminal invalid-result
receipt, result hash, and exact replay. Two lexically different JSON texts that
parse to the same canonical value therefore have one core result identity.
The package-level HTTP body cap still applies to the complete outer JSON-RPC
request before either JSON parse; it is not reinterpreted as `maxResultBytes`.

The canonical skill tells the worker to serialize the value matching the
leased `output_schema` once into `result_json`. It explicitly distinguishes a
string-root result, whose JSON text includes JSON quote characters, from an
object accidentally encoded as a string value.

## Rejected alternatives

- Requiring an object root would contradict Muster Schema 1, which deliberately
  supports object, array, string, number, integer, boolean, and null roots.
- Parsing any raw `result` string that looks like JSON would make legitimate
  string-root results ambiguous and would make retry identity depend on a
  heuristic.
- Accepting both raw values and JSON text would preserve the same ambiguity and
  create two public encodings for one result.
- Description-only guidance is not a sufficient contract after the provider
  repeated the string encoding despite explicit schedule and job instructions.
- Weakening or bypassing the class output schema would manufacture acceptance
  and invalidate the coordinator's verification claim.

## Compatibility and ordering

This is a breaking change to the pre-completion MCP tool catalog, not to core
worker wire `1.1.0`. No production package-complete or publication claim exists,
and the two rejected gate attempts create no accepted-result compatibility
obligation. Existing operator-issued skill releases must be regenerated because
their canonical text and `skill_sha256` change.

After the existing bounded-body and outer JSON-RPC protocol preflight, the
authenticated request-start order becomes: token validation; mandatory
revocation read; scopes; subject mapping; coarse worker status; closed
tool-schema validation; duplicate-safe `result_json` parse and JCS-domain
validation for `submit_result`; atomic MCP call-state authorization; then the
existing public core operation. Job-class validation remains after
authorization inside core, exactly as today.

## Executable acceptance matrix

- the frozen lease output schema requires `output_schema`; the projected value
  is detached, byte-identical under JCS to the selected registered
  `JobClass.outputSchema`, and passes `validateMusterSchema()`;
- the frozen submit input requires `result_json: string`, rejects `result`, and
  remains closed;
- object, array, string, numeric, boolean, and null JSON texts reach core as the
  corresponding values;
- surrounding JSON whitespace is accepted, while invalid syntax, duplicate
  object names at any depth (including escape-equivalent names), trailing
  non-whitespace data, number overflow to a non-finite value, and escaped lone
  surrogates invoke neither MCP state nor core;
- a valid JSON value that fails the leased class output schema still reaches
  core and returns the frozen coarse `invalid_result` outcome;
- exact accepted replay remains byte-identical when the JSON text has different
  insignificant whitespace or object-key order but the parsed value is equal;
- lease padding covers the added output schema without changing parsed content;
- the canonical skill golden vector and release hash change deterministically;
- stable lifecycle fixtures named `mcp-lease-output-schema-disclosed`,
  `mcp-submit-result-json-parse-refusal`,
  `mcp-submit-result-json-duplicate-name-refusal`,
  `mcp-submit-result-json-string-root`, and
  `mcp-submit-result-json-canonical-replay` own disclosure, pre-state refusal,
  disambiguation, and replay; and
- the authenticated six-tool conformance suite passes unchanged over both Store
  adapters after its calls use `result_json`.

## Stop boundary

The independent review traced this proposal through Muster Schema 1,
`input_hash`, class registration, `LeaseService`, MCP validation and request
ordering, `SubmissionService`, canonical result hashing, exact replay, skill
release selection, padding, fixtures, and both Store-adapter conformance paths.
It corrected the four gaps above without activating a contract or runtime
change. The next bounded unit may implement this corrected proposal as revision
29 and, only after its own validation and review, create the local
`contract-freeze-18` tag. The provider gate remains a later, disposable Task-9
unit.
