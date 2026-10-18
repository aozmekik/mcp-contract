# ADR 0004: Same-document references, and `unevaluated*` without annotation tracking

- Status: accepted
- Date: 2026-10-18

## Context

Two parts of JSON Schema 2020-12 make a keyword's meaning depend on more than
the schema object it is written in:

1. **References.** `$ref` is resolved against the base URI of the schema that
   contains it (core, section 8.2). Targets can be named by JSON Pointer, by
   an `$anchor` or `$dynamicAnchor`, or by the `$id` of an embedded resource.
   The first version of mcp-contract only followed `#` and `#/...` pointers
   against the document root. Every other reference was "unresolvable", and
   when its text was the same on both sides it was treated as unchanged, so a
   breaking change behind `{"$ref": "#item"}` passed as "no changes".
2. **`unevaluatedProperties` and `unevaluatedItems`** (core, section 11) apply
   to the members that no adjacent keyword, and no successful in-place
   subschema (`allOf`, `anyOf`, `oneOf`, `$ref`, `if`/`then`/`else`,
   `dependentSchemas`, and `contains` for items), has evaluated. Treating them
   as opaque keywords meant that removing a property under an unchanged
   `unevaluatedProperties: false` was reported as non-breaking, although it
   now rejects requests that were valid. This is the usual way to close a
   composed object (TypeBox's `Composite` and `Intersect` emit it).

A review found both problems, and differential fuzzing against Ajv confirmed
them. The MCP specification forbids dereferencing network references by
default, and asks implementations to bound the work they do on schemas.

## Options considered

1. **Resolve references and track annotations exactly**, like a validator
   does. A validator knows the instance; a schema comparison does not. Which
   members a subschema evaluates depends on whether it validates, so an exact
   treatment needs a symbolic evaluator over sets of instances. That is a
   research project, not a contract checker.
2. **Keep them opaque**, and document it. Simple, but the verdicts it gives
   are wrong, not merely imprecise.
3. **Index identifiers, and model `unevaluated*` where it is exact.**

## Decision

Option 3.

- Each document is indexed once: every schema object gets the base URI of its
  resource, and every `$id`, `$anchor`, `$dynamicAnchor` (as a plain anchor
  for `$ref`) and draft-07 plain-name `$id` is recorded. References are
  resolved against the base of the schema that contains them, inside the
  document only. Nothing is ever fetched.
- A reference that still cannot be followed is unchanged only when it
  provably means the same on both sides: the two documents are equal, or the
  same reference, resolved to the same absolute URI, points outside both
  documents (or at nothing in either). Otherwise it is `unknown`. The same
  holds for `$dynamicRef` and `$recursiveRef`, which are not resolved.
- Resolution is memoised per document, so the synthesised object for
  `{"$ref": ..., ...siblings}` has a stable identity. The coinductive cycle
  check depends on it; without it, recursive definitions with constraint
  siblings overflowed the stack.
- Where no in-place applicator sits next to an `unevaluated*` keyword (and,
  for properties, no `additionalProperties`; for items, no `items`), it
  validates exactly the members `additionalProperties` or `items` would, and
  is compared as if it were that keyword. This covers the common
  `prefixItems` plus `unevaluatedItems: false` tuple.
- Elsewhere the keyword is said to be "closing" at its instance location. The
  comparison then reports as `unknown` every structural conclusion that only
  considered accepted values: a removed property or prefix item that falls
  back to "anything goes", an `allOf` member added or removed, containment
  between union alternatives, an always-true alternative. Conclusions that
  only add evaluated members (an added optional property, a widened bound)
  stay as they are. For A1 a schema-valued `unevaluatedProperties` accepts
  undeclared keys, and A2 does not apply to output fields it typed.

## Consequences

- Changes behind anchors and embedded resources are found; the regression
  tests in `test/unit/schema-refs.test.ts` cover each form.
- Schemas closed by `unevaluatedProperties` next to `allOf` or `$ref` produce
  more `unknown` verdicts than a perfect analysis would. That is the
  conservative direction, and it fails CI under the default `--fail-on
unknown`.
- Changes inside documents referenced by another URI remain invisible: the
  snapshot does not contain them. The README lists this as a limitation.
- Draft-04 `id` is not indexed. When a document contains one, a reference
  that looks external is treated as possibly internal, so it is `unknown` if
  the documents differ.
- The property test generates `$ref` with siblings, recursion through
  `oneOf`, objects closed through `allOf`, and tuples with `unevaluatedItems`,
  so these rules are checked against Ajv rather than only by hand.
