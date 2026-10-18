/**
 * `allOf`, `anyOf` and `oneOf`.
 *
 * Alternatives are first paired by semantic equivalence (so reordering is not
 * a change). What remains is classified only when it can be justified:
 *
 * - added `anyOf` alternatives widen, removed ones narrow, unless every
 *   added/removed alternative is contained in one on the other side;
 * - a single remaining old/new pair is compared in detail;
 * - for `oneOf`, any conclusion of "compatible" becomes `unknown`, because
 *   exclusivity (exactly one alternative matches) can flip either way when
 *   alternatives change, and mcp-contract does not compute overlaps;
 * - anything else is `unknown`.
 *
 * Under an `unevaluatedProperties`/`unevaluatedItems` keyword that is not
 * modelled, a subschema also matters for the members it evaluates, not just
 * for the values it accepts. Conclusions that only consider the values
 * (containment, an always-true member) are then `unknown`.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.ts';
import { ANNOTATION_KEYWORDS } from '../../schema/keywords.ts';
import { compareAnnotations } from './annotations.ts';
import {
  compatible,
  derive,
  emit,
  equivalent,
  formatValue,
  formatValues,
  get,
  plural,
  scratch,
  type Context,
} from './context.ts';
import { STRUCTURAL_KEYWORDS } from './refs.ts';
import { declaredTypes, enumValues } from './scalars.ts';
import { sameMeaning } from './stability.ts';

const CLOSING_REASON =
  'unevaluatedProperties or unevaluatedItems applies here, and whether it still accepts a value depends on which subschemas evaluate which members, which mcp-contract does not track';

type UnionKeyword = 'anyOf' | 'oneOf';

function branchesOf(schema: JsonObject, keyword: 'allOf' | UnionKeyword): JsonValue[] | undefined {
  const value = get(schema, keyword);
  return Array.isArray(value) ? value : undefined;
}

function describeBranch(branch: JsonValue): string {
  if (typeof branch === 'boolean') {
    return String(branch);
  }
  if (!isJsonObject(branch)) {
    return 'schema';
  }
  if (typeof branch.$ref === 'string') {
    return `$ref ${branch.$ref}`;
  }
  const values = enumValues(branch);
  if (values !== undefined) {
    const [first] = values;
    return values.length === 1 && first !== undefined
      ? `const ${formatValue(first)}`
      : `enum ${formatValues(values)}`;
  }
  const properties = get(branch, 'properties');
  if (isJsonObject(properties)) {
    // e.g. `object {kind: "url", url}` for a discriminated-union variant.
    const names = Object.keys(properties);
    const shown = names.slice(0, 3).map((name) => {
      const property = properties[name];
      const constant = isJsonObject(property) ? enumValues(property) : undefined;
      const [only] = constant ?? [];
      return constant?.length === 1 && only !== undefined ? `${name}: ${formatValue(only)}` : name;
    });
    return `object {${shown.join(', ')}${names.length > 3 ? ', ...' : ''}}`;
  }
  const types = declaredTypes(branch);
  if (types !== undefined && types.size > 0) {
    return [...types].join('|');
  }
  const keywords = Object.keys(branch);
  return keywords.length === 0
    ? 'any value'
    : `{${keywords.slice(0, 3).join(', ')}${keywords.length > 3 ? ', ...' : ''}}`;
}

function describeBranches(branches: readonly JsonValue[]): string {
  return branches.map(describeBranch).join(', ');
}

function hasCombinator(schema: JsonObject): boolean {
  return ['allOf', 'anyOf', 'oneOf', 'not', 'if'].some((keyword) => Object.hasOwn(schema, keyword));
}

/**
 * Splits `{type: [a, b], ...}` into one alternative per type; exact, because
 * `type` is a disjunction. The split alternatives are created once per run,
 * so recursive comparisons recognise them as already visited.
 */
function expandTypeUnion(ctx: Context, branch: JsonValue): JsonValue[] {
  if (!isJsonObject(branch) || typeof branch.$ref === 'string' || hasCombinator(branch)) {
    return [branch];
  }
  const types = get(branch, 'type');
  if (!Array.isArray(types) || types.length < 2) {
    return [branch];
  }
  return derive(ctx, branch, 'type-alternatives', () =>
    types.map((type): JsonValue => ({ ...branch, type })),
  );
}

interface Matching {
  readonly pairs: readonly (readonly [JsonValue, JsonValue])[];
  readonly oldRest: readonly JsonValue[];
  readonly newRest: readonly JsonValue[];
}

/**
 * Pairs alternatives that accept the same values. Identical alternatives are
 * paired first through a hash map, so reordering a large union costs linear
 * time; only the remaining ones are compared with each other. The key is
 * plain JSON text: snapshots are canonical, and an alternative whose keys are
 * merely in another order still finds its partner in the second pass.
 */
function matchEquivalent(
  ctx: Context,
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  path: string,
): Matching {
  const used = new Set<number>();
  const paired = new Set<number>();
  const pairs: (readonly [JsonValue, JsonValue])[] = [];
  const byText = new Map<string, number[]>();
  after.forEach((branch, position) => {
    const text = JSON.stringify(branch);
    byText.set(text, [...(byText.get(text) ?? []), position]);
  });
  before.forEach((branch, index) => {
    const candidates = byText.get(JSON.stringify(branch)) ?? [];
    const position = candidates.find((candidate) => !used.has(candidate));
    const match = position === undefined ? undefined : after[position];
    if (position !== undefined && match !== undefined && sameMeaning(ctx, branch, match)) {
      used.add(position);
      paired.add(index);
      pairs.push([branch, match]);
    }
  });
  const oldRest: JsonValue[] = [];
  before.forEach((branch, index) => {
    if (paired.has(index)) {
      return;
    }
    const position = after.findIndex(
      (candidate, at) => !used.has(at) && equivalent(ctx, branch, candidate, path),
    );
    const match = after[position];
    if (match === undefined) {
      oldRest.push(branch);
    } else {
      used.add(position);
      pairs.push([branch, match]);
    }
  });
  const newRest = after.filter((_, position) => !used.has(position));
  return { pairs, oldRest, newRest };
}

function isPureUnion(schema: JsonObject, keyword: UnionKeyword | 'allOf'): boolean {
  return Object.keys(schema).every(
    (key) => key === keyword || ANNOTATION_KEYWORDS.has(key) || STRUCTURAL_KEYWORDS.has(key),
  );
}

function unionKeywordOf(schema: JsonObject): UnionKeyword | 'both' | undefined {
  const anyOf = Object.hasOwn(schema, 'anyOf');
  const oneOf = Object.hasOwn(schema, 'oneOf');
  if (anyOf && oneOf) {
    return 'both';
  }
  if (anyOf) {
    return 'anyOf';
  }
  return oneOf ? 'oneOf' : undefined;
}

/** `schema` without annotations and identifiers; created once per node and run. */
function withoutAnnotations(ctx: Context, schema: JsonObject): JsonObject {
  return derive(ctx, schema, 'without-annotations', () =>
    Object.fromEntries(
      Object.entries(schema).filter(
        ([key]) => !ANNOTATION_KEYWORDS.has(key) && !STRUCTURAL_KEYWORDS.has(key),
      ),
    ),
  );
}

function compareUnion(
  ctx: Context,
  keyword: UnionKeyword,
  beforeBranches: readonly JsonValue[],
  afterBranches: readonly JsonValue[],
  path: string,
): void {
  // Splitting `type: [a, b]` into alternatives is exact for anyOf. For oneOf it
  // is not (integer and number overlap), so oneOf alternatives are kept whole.
  const expand = (branches: readonly JsonValue[]): JsonValue[] =>
    keyword === 'anyOf'
      ? branches.flatMap((branch) => expandTypeUnion(ctx, branch))
      : [...branches];
  const before = expand(beforeBranches);
  const after = expand(afterBranches);
  const { pairs, oldRest, newRest } = matchEquivalent(ctx, before, after, path);
  for (const [left, right] of pairs) {
    ctx.compare(left, right, path); // surfaces annotation-only differences
  }
  const exclusivity = `${keyword} requires exactly one alternative to match, and mcp-contract does not check overlaps between alternatives`;
  const [onlyOld] = oldRest;
  const [onlyNew] = newRest;

  if (onlyOld === undefined && onlyNew === undefined) {
    return;
  }
  if (
    oldRest.length === 1 &&
    newRest.length === 1 &&
    onlyOld !== undefined &&
    onlyNew !== undefined
  ) {
    const findings = scratch(ctx, () => {
      ctx.compare(onlyOld, onlyNew, path);
    });
    const prefix = `${keyword} alternative ${describeBranch(onlyOld)}: `;
    for (const finding of findings) {
      if (
        keyword === 'oneOf' &&
        finding.severity === 'non-breaking' &&
        finding.effect !== 'annotation'
      ) {
        ctx.out.push({
          ...finding,
          severity: 'unknown',
          effect: 'unknown',
          message: `${prefix}${finding.message} (${exclusivity})`,
        });
      } else {
        ctx.out.push({ ...finding, message: `${prefix}${finding.message}` });
      }
    }
    // The pair is known not to be equivalent. When the detailed comparison
    // still finds nothing, the difference lies in a recursive definition that
    // is reported where it is first reached; inside a oneOf that report is not
    // enough, because the change can flip which alternative matches.
    if (keyword === 'oneOf' && findings.every((finding) => finding.effect === 'annotation')) {
      emit(
        ctx,
        'unknown',
        'alternatives-changed',
        path,
        `oneOf alternative ${describeBranch(onlyOld)} changed through a recursive reference`,
        { reason: exclusivity },
      );
    }
    return;
  }

  // Input: every removed alternative must be contained in some new one.
  // Output: every added alternative must be contained in some old one.
  // Containment says nothing about which members an alternative evaluates,
  // so it proves nothing under a closing unevaluated* keyword.
  const closing = ctx.closing !== 0;
  const coveredInput = (): boolean =>
    !closing && oldRest.every((left) => after.some((right) => compatible(ctx, left, right, path)));
  const coveredOutput = (): boolean =>
    !closing && newRest.every((right) => before.some((left) => compatible(ctx, left, right, path)));

  if (oldRest.length === 0) {
    const what = `${keyword} ${plural(newRest.length, 'alternative')} added (${describeBranches(newRest)})`;
    if (ctx.direction === 'input') {
      if (keyword === 'anyOf') {
        emit(ctx, 'widen', 'alternatives-added', path, what);
      } else {
        emit(ctx, 'unknown', 'alternatives-added', path, what, { reason: exclusivity });
      }
    } else if (closing) {
      emit(ctx, 'unknown', 'alternatives-added', path, what, { reason: CLOSING_REASON });
    } else if (!coveredOutput()) {
      emit(ctx, 'widen', 'alternatives-added', path, what);
    } else if (keyword === 'anyOf') {
      emit(ctx, 'narrow', 'alternatives-added', path, what, {
        reason: 'every new alternative is contained in an existing one',
      });
    } else {
      emit(ctx, 'unknown', 'alternatives-added', path, what, { reason: exclusivity });
    }
    return;
  }
  if (newRest.length === 0) {
    const what = `${keyword} ${plural(oldRest.length, 'alternative')} removed (${describeBranches(oldRest)})`;
    if (ctx.direction === 'output') {
      if (keyword === 'anyOf') {
        emit(ctx, 'narrow', 'alternatives-removed', path, what);
      } else {
        emit(ctx, 'unknown', 'alternatives-removed', path, what, { reason: exclusivity });
      }
    } else if (closing) {
      emit(ctx, 'unknown', 'alternatives-removed', path, what, { reason: CLOSING_REASON });
    } else if (!coveredInput()) {
      emit(ctx, 'narrow', 'alternatives-removed', path, what);
    } else if (keyword === 'anyOf') {
      emit(ctx, 'widen', 'alternatives-removed', path, what, {
        reason: 'every removed alternative is contained in a remaining one',
      });
    } else {
      emit(ctx, 'unknown', 'alternatives-removed', path, what, { reason: exclusivity });
    }
    return;
  }

  const what = `${keyword} alternatives changed (removed: ${describeBranches(oldRest)}; added: ${describeBranches(newRest)})`;
  const covered = ctx.direction === 'input' ? coveredInput() : coveredOutput();
  if (covered && keyword === 'anyOf') {
    emit(ctx, ctx.direction === 'input' ? 'widen' : 'narrow', 'alternatives-changed', path, what, {
      reason:
        ctx.direction === 'input'
          ? 'every removed alternative is contained in a new one'
          : 'every new alternative is contained in an old one',
    });
  } else {
    emit(ctx, 'unknown', 'alternatives-changed', path, what, {
      reason:
        keyword === 'oneOf'
          ? exclusivity
          : closing
            ? CLOSING_REASON
            : 'mcp-contract cannot prove the new alternatives are compatible',
    });
  }
}

/**
 * Handles a schema turning into (or out of) a union, the shape of
 * `string` -> `anyOf: [string, null]`, by treating the plain side as a
 * single-alternative union, and `anyOf` <-> `oneOf` swaps over the same
 * alternatives. Returns false when the shapes do not allow it, in which case
 * the keywords are compared one by one.
 */
export function liftUnion(ctx: Context, o: JsonObject, n: JsonObject, path: string): boolean {
  const oldKeyword = unionKeywordOf(o);
  const newKeyword = unionKeywordOf(n);
  if (oldKeyword === newKeyword || oldKeyword === 'both' || newKeyword === 'both') {
    return false;
  }
  if (oldKeyword !== undefined && newKeyword !== undefined) {
    if (!isPureUnion(o, oldKeyword) || !isPureUnion(n, newKeyword)) {
      return false;
    }
    compareAnnotations(ctx, o, n, path);
    const matching = matchEquivalent(
      ctx,
      branchesOf(o, oldKeyword) ?? [],
      branchesOf(n, newKeyword) ?? [],
      path,
    );
    if (matching.oldRest.length > 0 || matching.newRest.length > 0) {
      emit(
        ctx,
        'unknown',
        'composition-changed',
        path,
        `${oldKeyword} changed to ${newKeyword} with different alternatives`,
        { reason: 'mcp-contract cannot prove the new alternatives are compatible' },
      );
    } else if (newKeyword === 'oneOf') {
      emit(ctx, 'narrow', 'composition-changed', path, 'anyOf changed to oneOf', {
        reason:
          ctx.direction === 'input'
            ? 'values matching several alternatives are now rejected'
            : 'results now match exactly one alternative',
      });
    } else {
      emit(ctx, 'widen', 'composition-changed', path, 'oneOf changed to anyOf', {
        reason:
          ctx.direction === 'input'
            ? 'values matching several alternatives are now accepted'
            : 'results may now match several alternatives',
      });
    }
    return true;
  }
  const keyword = oldKeyword ?? newKeyword;
  if (keyword === undefined) {
    return false;
  }
  const unionSide = oldKeyword === undefined ? n : o;
  const plainSide = oldKeyword === undefined ? o : n;
  if (!isPureUnion(unionSide, keyword) || hasCombinator(plainSide)) {
    return false;
  }
  compareAnnotations(ctx, o, n, path);
  const plain = [withoutAnnotations(ctx, plainSide)];
  const before = oldKeyword === undefined ? plain : (branchesOf(o, keyword) ?? []);
  const after = newKeyword === undefined ? plain : (branchesOf(n, keyword) ?? []);
  compareUnion(ctx, keyword, before, after, path);
  return true;
}

/** Compares `anyOf` or `oneOf` when they appear on both sides, or appear/disappear next to other keywords. */
export function compareUnionKeyword(
  ctx: Context,
  keyword: UnionKeyword,
  o: JsonObject,
  n: JsonObject,
  path: string,
): void {
  const before = branchesOf(o, keyword);
  const after = branchesOf(n, keyword);
  if (before !== undefined && after !== undefined) {
    compareUnion(ctx, keyword, before, after, path);
    return;
  }
  const branches = before ?? after;
  if (branches === undefined) {
    return;
  }
  if (ctx.closing !== 0) {
    emit(
      ctx,
      'unknown',
      before === undefined ? 'subschema-added' : 'subschema-removed',
      path,
      `${keyword} ${before === undefined ? 'added' : 'removed'} (${describeBranches(branches)})`,
      {
        reason: CLOSING_REASON,
      },
    );
    return;
  }
  // An anyOf with an alternative that accepts everything constrains nothing.
  // The same is not true of oneOf: `oneOf: [{}, X]` means "not X".
  if (keyword === 'anyOf' && branches.some((branch) => equivalent(ctx, true, branch, path))) {
    return;
  }
  if (before === undefined) {
    emit(
      ctx,
      'narrow',
      'subschema-added',
      path,
      `${keyword} constraint added (${describeBranches(branches)})`,
    );
  } else {
    emit(
      ctx,
      'widen',
      'subschema-removed',
      path,
      `${keyword} constraint removed (${describeBranches(branches)})`,
    );
  }
}

/** Compares `allOf`: added subschemas narrow, removed ones widen, a single changed one is compared in detail. */
export function compareAllOf(ctx: Context, o: JsonObject, n: JsonObject, path: string): void {
  compareConjunction(ctx, branchesOf(o, 'allOf') ?? [], branchesOf(n, 'allOf') ?? [], path);
}

/**
 * Handles a schema turning into (or out of) a pure `allOf`, for example when a
 * `$ref` gains constraint keywords beside it, by treating the plain side as a
 * one-member `allOf`.
 */
export function liftAllOf(ctx: Context, o: JsonObject, n: JsonObject, path: string): boolean {
  const oldHas = Object.hasOwn(o, 'allOf');
  const newHas = Object.hasOwn(n, 'allOf');
  if (oldHas === newHas) {
    return false;
  }
  const composite = oldHas ? o : n;
  const plain = oldHas ? n : o;
  if (!isPureUnion(composite, 'allOf') || hasCombinator(plain)) {
    return false;
  }
  compareAnnotations(ctx, o, n, path);
  const lifted = [withoutAnnotations(ctx, plain)];
  compareConjunction(
    ctx,
    oldHas ? (branchesOf(o, 'allOf') ?? []) : lifted,
    newHas ? (branchesOf(n, 'allOf') ?? []) : lifted,
    path,
  );
  return true;
}

function compareConjunction(
  ctx: Context,
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  path: string,
): void {
  if (before.length === 0 && after.length === 0) {
    return;
  }
  const { pairs, oldRest, newRest } = matchEquivalent(ctx, before, after, path);
  for (const [left, right] of pairs) {
    ctx.compare(left, right, path);
  }
  // A member that accepts everything changes nothing, unless an unevaluated*
  // keyword sees the members it evaluates.
  const closing = ctx.closing !== 0;
  const removed = oldRest.filter((branch) => closing || !equivalent(ctx, true, branch, path));
  const added = newRest.filter((branch) => closing || !equivalent(ctx, true, branch, path));
  const [onlyRemoved] = removed;
  const [onlyAdded] = added;
  if (
    removed.length === 1 &&
    added.length === 1 &&
    onlyRemoved !== undefined &&
    onlyAdded !== undefined
  ) {
    ctx.compare(onlyRemoved, onlyAdded, path);
  } else if (closing && (removed.length > 0 || added.length > 0)) {
    emit(ctx, 'unknown', 'composition-changed', path, 'allOf subschemas changed', {
      reason: CLOSING_REASON,
    });
  } else if (removed.length === 0 && added.length > 0) {
    emit(
      ctx,
      'narrow',
      'subschema-added',
      path,
      `allOf gained ${added.length} ${plural(added.length, 'subschema')} (${describeBranches(added)})`,
    );
  } else if (added.length === 0 && removed.length > 0) {
    emit(
      ctx,
      'widen',
      'subschema-removed',
      path,
      `allOf lost ${removed.length} ${plural(removed.length, 'subschema')} (${describeBranches(removed)})`,
    );
  } else if (added.length > 0 && removed.length > 0) {
    emit(ctx, 'unknown', 'composition-changed', path, 'allOf subschemas changed', {
      reason: 'mcp-contract cannot pair the old and new subschemas unambiguously',
    });
  }
}
