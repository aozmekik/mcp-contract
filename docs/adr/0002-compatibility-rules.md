# ADR 0002: Direction-aware compatibility with explicit assumptions and an `unknown` verdict

- Status: accepted
- Date: 2026-10-18

## Context

The core question is whether an existing client keeps working after a server
changes. Agents are written (or prompted) against a tool's schemas, so the
interesting changes are inside JSON Schema: types, bounds, enums, required
properties, nested objects, unions, references.

Two observations shape the design:

1. **Direction matters.** For a tool's `inputSchema` the client produces the
   data and the server validates it: the new schema must accept everything the
   old one did. For `outputSchema` the server produces the data and the client
   consumes it: everything the new schema allows must be something the client
   already handles. The same edit (say, adding an enum value) is safe in one
   direction and breaking in the other.
2. **Exact answers are often impossible.** Schema inclusion is undecidable in
   general once regular expressions, `not`, `if`/`then`/`else`, `oneOf`
   exclusivity and recursion are involved. A tool that guesses will either
   cry wolf or, worse, wave through a breaking change.

## Options considered

1. **Structural diff only** (report every changed keyword, let humans judge).
   Simple and honest, but it does not answer the question, so CI cannot gate
   on it.
2. **Pure set inclusion** (new ⊇ old for inputs, new ⊆ old for outputs). Sound,
   but it flags the most common safe evolution, adding an optional property,
   as breaking whenever `additionalProperties` is not `false`, because the
   old schema technically accepted any value for that key.
3. **Set inclusion with documented assumptions and a third verdict.**

## Decision

Option 3. Every change gets one of three severities, with an explanation:

- `breaking`: a client written against the old contract can fail;
- `non-breaking`: existing clients keep working;
- `unknown`: compatibility cannot be proven either way.

The analysis is set inclusion per keyword (a schema is a conjunction of its
keywords, so narrowing one keyword narrows the schema), with interacting
keywords analysed together (`properties`/`required`/`additionalProperties`,
`items`/`prefixItems`, bounds with their exclusive forms). Everything that
cannot be decided is `unknown`: pattern and format changes, `not`,
`if`/`then`/`else`, unknown keywords, `$dynamicRef` and references that
cannot be followed unless they provably mean the same on both sides,
structural changes next to an `unevaluated*` keyword whose effect is not
modelled (both in ADR 0004),
and any `oneOf` change that would otherwise be judged compatible (exclusivity
can flip in either direction).

Two assumptions, stated in the code and here, keep the verdicts useful:

- **A1 (inputs):** clients only send properties that the old schema declares
  at that instance location. Adding an optional input property is therefore
  non-breaking. "Declares" is judged against every old subschema that applies
  at the location, not just the node being compared: if a sibling `anyOf`
  alternative or `allOf` member declares the property, or a map-like
  `additionalProperties` (or `unevaluatedProperties`) schema accepts arbitrary
  keys, the change is `unknown`.
- **A2 (outputs):** clients ignore result fields they do not know. Adding an
  optional output field is non-breaking even under `additionalProperties:
false`. A field that a schema-valued `unevaluatedProperties` used to type is
  not unknown to clients, so A2 does not apply to it.

Where the pragmatic view is stricter than set inclusion, the stricter view
wins: removing a declared output field is always breaking (clients may read
it), even though the new results technically still satisfy the old schema.

Other rules follow the same logic: removed tools, prompts, resources and
templates are breaking, additions are not; description and title changes are
reported as non-breaking; behaviour hints that become riskier (for example
`readOnlyHint` true to false) are `unknown` so that someone reviews approval
policies; MIME type changes on resources are breaking; capability removals are
breaking.

Recursive schemas are handled coinductively: a pair of subschemas already
being compared further up the stack is assumed to contribute no further
change, the standard greatest-fixed-point treatment of recursive types. The
engine asks three kinds of question: it reports changes, and, to pair union
alternatives and check coverage, it asks whether two subschemas are
equivalent or compatible. A hypothesis made while answering one kind of
question is never used for another: "this pair is being reported" says
nothing about whether it is equivalent. One case needs more: when a `oneOf`
alternative is known not to be equivalent but its comparison finds nothing,
because the difference is reported where the recursion was first entered, the
alternative is still `unknown` (exclusivity can flip). A step budget and a
nesting limit bound pathological schemas, as the MCP specification asks
implementations to do; exceeding either adds a `schema-too-complex` change,
which fails the check at every `--fail-on` level because the part that was not
analysed may hide breaking changes. Identical union alternatives are paired
through a hash map before any pairwise comparison, so reordering a large union
does not spend the budget.

The CLI and the test assertion fail on `breaking` and `unknown` by default
(`--fail-on unknown`): a change that cannot be proven safe should be looked
at once, then accepted by re-taking the baseline.

## Verification

`test/property/schema-soundness.test.ts` checks the `non-breaking` verdict
against an independent validator (Ajv, JSON Schema 2020-12). Random schemas,
including guarded recursive `$ref` definitions, are mutated; whenever the
engine reports no breaking and no unknown change, Ajv must confirm that every
sampled instance valid under the old schema (and using only declared
properties, A1) is valid under the new one for inputs, and that every instance
valid under the new schema is valid under the old one with
`additionalProperties: false` relaxed (A2) for outputs. A guard asserts that
the generators produce both verdicts often, so the property is not vacuous.

Long runs of this test found four real defects before release: A1 judged
against the compared node only instead of the whole instance location, an
`oneOf: [{}, X]` treated as unconstrained, a reference that stopped resolving
treated as unchanged, and a property whose "schema" is not a schema accepted
silently. Reviewing the engine while writing the test exposed two more:
splitting `type` arrays into alternatives is not exact under `oneOf`, and
`enum` values excluded by `type` were still counted.

An external review of that version then found defects in constructs the
generators did not produce: a stack overflow on recursive `$ref`s with
constraint siblings, `unevaluatedProperties`/`unevaluatedItems` ignored when
the keywords around them changed, unresolvable anchors and embedded `$id`s
treated as unchanged, and cycle hypotheses leaking into equivalence checks
(through a recursive `oneOf` alternative). The generators now produce `$ref`
with siblings, recursion through `oneOf`, objects closed by
`unevaluatedProperties` (also through `allOf`) and tuples with
`unevaluatedItems`; run against the old engine they hit the stack overflow
within a few hundred cases. A long search with them found one more defect in
the new rules (A2 applied to fields a schema-valued `unevaluatedProperties`
had typed). All are fixed and have unit tests.

## Consequences

- Verdicts are explainable: each change names the rule (`code`), the location
  (`inputSchema $.filters[*].tag`) and the consequence.
- The `non-breaking` verdict is checked against Ajv under A1 and A2 for the
  keywords the property test generates (types, bounds, enums, objects,
  arrays and tuples, unions, `allOf`, `unevaluated*`, local references with
  and without siblings); keywords outside that set are compared opaquely and
  changes to them are `unknown`. This is evidence, not a proof: the first
  version passed the same kind of test while defects remained in constructs
  its generators did not produce.
- `breaking` can be a false positive: for example narrowing one `anyOf`
  alternative is reported as breaking even if another alternative still covers
  the removed values. This is the conservative direction.
- Teams whose clients do send undeclared properties (violating A1) get false
  negatives for added optional inputs. The assumption is documented in the
  README so the trade-off is visible.
