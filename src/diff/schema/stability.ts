/**
 * When does equal schema text imply equal meaning? Only when every reference
 * inside it resolves to equal definitions in both documents, transitively.
 */
import { jsonEqual, type JsonValue } from '../../core/json.ts';
import type { Context } from './context.ts';
import { DYNAMIC_REFERENCE, type Lookup } from './refs.ts';

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * True when an unresolvable reference provably means the same on both sides:
 * the whole documents are equal, or the same reference (resolved to the same
 * absolute URI) points outside both documents or at nothing in either.
 */
export function unresolvedUnchanged(ctx: Context, before: Lookup, after: Lookup): boolean {
  if (ctx.rootsEqual()) {
    return true;
  }
  if (before.ok || after.ok) {
    return false;
  }
  return (
    before.direct &&
    after.direct &&
    before.uri !== undefined &&
    before.uri === after.uri &&
    before.failure === after.failure &&
    (before.failure === 'external' || before.failure === 'missing') &&
    !ctx.oldDoc.hasUnindexedIds &&
    !ctx.newDoc.hasUnindexedIds
  );
}

/** Checks one reference target; queues the references the target itself contains. */
function targetStable(ctx: Context, uri: string, pending: string[]): boolean {
  if (uri === DYNAMIC_REFERENCE || uri.startsWith('\u0000')) {
    return ctx.rootsEqual();
  }
  const before = ctx.oldDoc.lookup(uri);
  const after = ctx.newDoc.lookup(uri);
  if (!before.ok || !after.ok) {
    return unresolvedUnchanged(ctx, before, after);
  }
  if (!jsonEqual(before.value, after.value)) {
    return false;
  }
  const next = ctx.oldDoc.references(before.value);
  if (!sameList(next, ctx.newDoc.references(after.value))) {
    return false;
  }
  pending.push(...next);
  return true;
}

/**
 * True when every reference reachable from the two (equal) values resolves to
 * equal definitions in both schemas, so equal text implies equal meaning.
 */
export function refsStable(ctx: Context, oldValue: JsonValue, newValue: JsonValue): boolean {
  const roots = ctx.oldDoc.references(oldValue);
  if (!sameList(roots, ctx.newDoc.references(newValue))) {
    return false;
  }
  const pending = [...roots];
  const visited = new Set<string>();
  for (let uri = pending.pop(); uri !== undefined; uri = pending.pop()) {
    if (visited.has(uri) || ctx.stableRefs.get(uri) === true) {
      continue;
    }
    visited.add(uri);
    if (ctx.stableRefs.get(uri) === false || !targetStable(ctx, uri, pending)) {
      ctx.stableRefs.set(uri, false);
      return false;
    }
  }
  visited.forEach((uri) => ctx.stableRefs.set(uri, true));
  return true;
}

/** True when `a` and `b` are the same text with the same meaning in their documents. */
export function sameMeaning(ctx: Context, a: JsonValue, b: JsonValue): boolean {
  return jsonEqual(a, b) && refsStable(ctx, a, b);
}
