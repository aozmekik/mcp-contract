/**
 * Direction-aware JSON Schema compatibility analysis.
 *
 * The question asked is never "are these schemas equal?" but "can a client that
 * was written against the old schema keep working?":
 *
 * - For an `input` schema (tool arguments) the client produces the data, so the
 *   new schema must accept everything the old one accepted. Narrowing is
 *   breaking; widening is not.
 * - For an `output` schema (structured tool results) the server produces the
 *   data, so everything the new schema allows must still be something the
 *   client handles. Widening is breaking; narrowing is not.
 *
 * Keywords are compared one at a time. Because a schema is the conjunction of
 * its keywords, a change that narrows one keyword narrows the whole schema, so
 * per-keyword reasoning is sound as long as interacting keywords
 * (`properties`/`additionalProperties`, `items`/`prefixItems`, ...) are
 * analysed together, which they are. Anything that cannot be decided
 * (regular-expression changes, `not`, `if`/`then`/`else`, reshaped `oneOf`
 * alternatives, unresolvable `$ref`s, unknown keywords) is reported as
 * `unknown` instead of being guessed.
 *
 * Two documented assumptions make the analysis useful for real servers
 * (see docs/adr/0002-compatibility-rules.md):
 *
 * - A1: clients only send properties the input schema declares, so adding an
 *   optional input property is non-breaking even when `additionalProperties`
 *   was open.
 * - A2: clients ignore result fields they do not know, so new output fields
 *   are non-breaking even under `additionalProperties: false`.
 *
 * Recursive schemas (`$ref` cycles) are handled coinductively: a pair of
 * subschemas that is already being compared further up the stack is assumed
 * compatible, the standard greatest-fixed-point treatment of recursive types.
 *
 * @module
 */
export { DEFAULT_MAX_STEPS, diffSchemas, type DiffSchemasOptions } from './schema/compare.ts';
export type { SchemaChange } from './schema/context.ts';
