/**
 * Same-document `$ref` resolution, following JSON Schema 2020-12 (core,
 * section 8.2).
 *
 * Each document is indexed once: every schema object is assigned the base URI
 * of the schema resource it belongs to (`$id`, resolved against the enclosing
 * base), and every `$id`, `$anchor` and `$dynamicAnchor` is recorded. A
 * reference is resolved against the base URI of the schema object it is
 * written in, and its target must lie inside the same document. Nothing is
 * ever fetched: the MCP specification forbids dereferencing network
 * references by default, so a reference to another document is reported as
 * unresolvable.
 *
 * Resolution is memoised per document, so resolving the same raw node twice
 * returns the same object. The comparison's cycle detection depends on this:
 * `{$ref, ...siblings}` resolves to a synthesised object, and a fresh object
 * on every visit would never be recognised as already being compared.
 */
import {
  compareCodeUnits,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../core/json.ts';
import { ANNOTATION_KEYWORDS, subschemasOf } from '../../schema/keywords.ts';
import { get } from './context.ts';

/** Why a reference has no target. */
export type LookupFailure =
  /** The target is in another document, which is never fetched. */
  | 'external'
  /** The target document is this one, but nothing in it has that pointer or anchor. */
  | 'missing'
  /** The reference cannot be interpreted (not a URI reference, bad escape, a loop). */
  | 'invalid';

/** Result of following a reference. */
export type Lookup =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly failure: LookupFailure;
      /** Absolute URI of the reference that failed, when it could be computed. */
      readonly uri?: string;
      /** True when the failing reference is the first one followed (not part of a chain). */
      readonly direct: boolean;
    };

/** Keywords that neither constrain nor annotate the instance at their own location. */
export const STRUCTURAL_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  '$schema',
  '$id',
  '$anchor',
  '$defs',
  'definitions',
]);

/**
 * Base URI for documents that declare none. The `.invalid` top-level domain is
 * reserved (RFC 2606), so it can never collide with a real schema's `$id`.
 */
const DEFAULT_BASE = 'https://mcp-contract.invalid/schema.json';

/** Marker returned by {@link SchemaDocument.references} for `$dynamicRef`/`$recursiveRef`. */
export const DYNAMIC_REFERENCE = '\u0000dynamic';

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/** An indexed schema document. */
export interface SchemaDocument {
  /** The document's root schema. */
  readonly root: JsonValue;
  /**
   * True when the document contains draft-04 style `id` keywords, which are
   * not indexed: a reference that looks external might point inside it.
   */
  readonly hasUnindexedIds: boolean;
  /**
   * Follows the `$ref` chain starting at `raw`. Memoised: the same raw node
   * always yields the same result object.
   */
  resolve(raw: JsonValue): Lookup;
  /** Looks up an absolute URI (resource plus optional fragment) inside the document. */
  lookup(uri: string): Lookup;
  /**
   * The absolute targets of every `$ref` inside `value`, sorted; a
   * `$dynamicRef` or `$recursiveRef` contributes {@link DYNAMIC_REFERENCE}.
   */
  references(value: JsonValue): readonly string[];
}

function withoutFragment(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

function parseUri(reference: string, base: string): URL | undefined {
  try {
    return new URL(reference, base);
  } catch {
    return undefined;
  }
}

function pickAnnotations(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => ANNOTATION_KEYWORDS.has(key)));
}

/** Keywords that only have their meaning together, inside one schema object. */
const INTERACTING_GROUPS: readonly (readonly string[])[] = [
  ['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties'],
  [
    'items',
    'prefixItems',
    'additionalItems',
    'unevaluatedItems',
    'contains',
    'minContains',
    'maxContains',
  ],
  ['if', 'then', 'else'],
  ['minimum', 'exclusiveMinimum'],
  ['maximum', 'exclusiveMaximum'],
];

/** Keywords whose results `unevaluatedProperties`/`unevaluatedItems` see. */
const IN_PLACE_APPLICATORS = [
  'allOf',
  'anyOf',
  'oneOf',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependencies',
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
] as const;

function hasUnevaluated(schema: JsonObject): boolean {
  return (
    Object.hasOwn(schema, 'unevaluatedProperties') || Object.hasOwn(schema, 'unevaluatedItems')
  );
}

/**
 * `{$ref: X, ...siblings}` means X and siblings both apply. When they share no
 * keyword and split no interacting keyword group, a single object with both
 * keyword sets means exactly the same, and gives far more precise diffs than
 * an `allOf`. An `unevaluated*` keyword in X must not end up next to sibling
 * applicators, whose results it would then see.
 */
function mergeable(target: JsonValue, siblings: JsonObject): target is JsonObject | true {
  if (target === true) {
    return true;
  }
  if (!isJsonObject(target) || typeof target.$ref === 'string') {
    return false;
  }
  if (Object.keys(siblings).some((key) => Object.hasOwn(target, key))) {
    return false;
  }
  if (hasUnevaluated(target) && IN_PLACE_APPLICATORS.some((key) => Object.hasOwn(siblings, key))) {
    return false;
  }
  return INTERACTING_GROUPS.every(
    (group) =>
      !group.some((key) => Object.hasOwn(target, key)) ||
      !group.some((key) => Object.hasOwn(siblings, key)),
  );
}

/**
 * The exact equivalent of `{$ref: X, ...siblings}` when the two cannot be
 * merged. `allOf: [X, siblings]` is exact unless the siblings contain an
 * `unevaluated*` keyword: that keyword sees the results of `$ref` (an
 * in-place applicator), so X has to stay next to it, as an `allOf` member.
 */
function conjunction(target: JsonValue, siblings: JsonObject, annotations: JsonObject): JsonObject {
  if (!hasUnevaluated(siblings)) {
    return { allOf: [target, siblings], ...annotations };
  }
  const own = get(siblings, 'allOf');
  return { ...siblings, allOf: [target, ...(Array.isArray(own) ? own : [])], ...annotations };
}

/** Indexes `root` for reference resolution. */
export function indexDocument(root: JsonValue): SchemaDocument {
  const bases = new WeakMap<object, string>();
  const resources = new Map<string, JsonValue>();
  const anchors = new Map<string, JsonValue>();
  let hasUnindexedIds = false;

  const register = (map: Map<string, JsonValue>, key: string, node: JsonValue): void => {
    if (!map.has(key)) {
      map.set(key, node);
    }
  };

  const walk = (node: JsonValue, base: string): void => {
    if (!isJsonObject(node) || bases.has(node)) {
      return; // Booleans carry no identifiers; a shared object keeps its first base.
    }
    let here = base;
    const id = get(node, '$id');
    if (typeof id === 'string') {
      if (id.startsWith('#')) {
        register(anchors, `${base}${id}`, node); // draft-06/07 plain-name fragment
      } else {
        const url = parseUri(id, base);
        if (url !== undefined) {
          here = withoutFragment(url);
          register(resources, here, node);
        }
      }
    } else if (typeof get(node, 'id') === 'string') {
      hasUnindexedIds = true;
    }
    bases.set(node, here);
    for (const keyword of ['$anchor', '$dynamicAnchor'] as const) {
      const anchor = get(node, keyword);
      if (typeof anchor === 'string') {
        register(anchors, `${here}#${anchor}`, node);
      }
    }
    for (const subschema of subschemasOf(node)) {
      walk(subschema, here);
    }
  };

  walk(root, DEFAULT_BASE);
  const rootBase = isJsonObject(root) ? (bases.get(root) ?? DEFAULT_BASE) : DEFAULT_BASE;
  register(resources, rootBase, root);

  const lookup = (uri: string): Lookup => {
    const hash = uri.indexOf('#');
    const resourceUri = hash === -1 ? uri : uri.slice(0, hash);
    const fragment = hash === -1 ? '' : uri.slice(hash + 1);
    const resource = resources.get(resourceUri);
    const fail = (failure: LookupFailure, reason: string): Lookup => ({
      ok: false,
      failure,
      reason,
      uri,
      direct: true,
    });
    if (resource === undefined) {
      return fail('external', 'it points to another document');
    }
    if (fragment === '') {
      return { ok: true, value: resource };
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      return fail('invalid', 'its fragment is not validly percent-encoded');
    }
    if (!decoded.startsWith('/')) {
      const anchored = anchors.get(`${resourceUri}#${decoded}`);
      return anchored === undefined
        ? fail('missing', `no $anchor "${decoded}" exists in the schema`)
        : { ok: true, value: anchored };
    }
    let node: JsonValue | undefined = resource;
    for (const rawToken of decoded.slice(1).split('/')) {
      const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
      if (Array.isArray(node)) {
        node = ARRAY_INDEX.test(token) ? node[Number(token)] : undefined;
      } else if (isJsonObject(node)) {
        node = get(node, token);
      } else {
        node = undefined;
      }
      if (node === undefined) {
        return fail('missing', 'it does not resolve inside the schema');
      }
    }
    return { ok: true, value: node };
  };

  /** Follows one reference written in `node`. */
  const follow = (node: JsonObject, ref: string): Lookup => {
    const url = parseUri(ref, bases.get(node) ?? rootBase);
    const lookedUp: Lookup =
      url === undefined
        ? { ok: false, failure: 'invalid', reason: 'it is not a valid URI reference', direct: true }
        : lookup(url.href);
    if (lookedUp.ok) {
      return lookedUp;
    }
    const reason =
      lookedUp.failure === 'external'
        ? `$ref "${ref}" points to another document, which is not dereferenced (the MCP specification forbids fetching network references)`
        : `$ref "${ref}" cannot be followed: ${lookedUp.reason}`;
    return { ...lookedUp, reason };
  };

  const resolveChain = (raw: JsonObject): Lookup => {
    let current: JsonValue = raw;
    let annotations: JsonObject = {};
    const seen = new Set<string>();
    let hops = 0;
    while (isJsonObject(current) && typeof current.$ref === 'string') {
      const ref = current.$ref;
      const target = follow(current, ref);
      if (!target.ok) {
        return { ...target, direct: hops === 0 };
      }
      const key = parseUri(ref, bases.get(current) ?? rootBase)?.href ?? ref;
      if (seen.has(key)) {
        return {
          ok: false,
          failure: 'invalid',
          reason: `$ref "${ref}" only refers to itself`,
          uri: key,
          direct: hops === 0,
        };
      }
      seen.add(key);
      hops += 1;
      const siblings = Object.fromEntries(
        Object.entries(current).filter(
          ([keyword]) => !STRUCTURAL_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword),
        ),
      );
      annotations = { ...pickAnnotations(current), ...annotations };
      if (Object.keys(siblings).length > 0) {
        const value: JsonObject = mergeable(target.value, siblings)
          ? { ...(target.value === true ? {} : target.value), ...siblings, ...annotations }
          : conjunction(target.value, siblings, annotations);
        return { ok: true, value };
      }
      current = target.value;
    }
    if (Object.keys(annotations).length === 0) {
      return { ok: true, value: current };
    }
    if (current === true) {
      return { ok: true, value: annotations };
    }
    return { ok: true, value: isJsonObject(current) ? { ...current, ...annotations } : current };
  };

  const resolved = new WeakMap<object, Lookup>();
  const resolve = (raw: JsonValue): Lookup => {
    if (!isJsonObject(raw) || typeof raw.$ref !== 'string') {
      return { ok: true, value: raw };
    }
    let result = resolved.get(raw);
    if (result === undefined) {
      result = resolveChain(raw);
      resolved.set(raw, result);
    }
    return result;
  };

  const referenceMemo = new WeakMap<object, readonly string[]>();
  const references = (value: JsonValue): readonly string[] => {
    if (typeof value !== 'object' || value === null) {
      return [];
    }
    const cached = referenceMemo.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const found = new Set<string>();
    if (isJsonObject(value)) {
      const ref = get(value, '$ref');
      if (typeof ref === 'string') {
        found.add(parseUri(ref, bases.get(value) ?? rootBase)?.href ?? `\u0000invalid ${ref}`);
      }
      if (get(value, '$dynamicRef') !== undefined || get(value, '$recursiveRef') !== undefined) {
        found.add(DYNAMIC_REFERENCE);
      }
    }
    for (const item of Object.values(value)) {
      references(item).forEach((ref) => found.add(ref));
    }
    const result = [...found].sort(compareCodeUnits);
    referenceMemo.set(value, result);
    return result;
  };

  return {
    root,
    get hasUnindexedIds() {
      return hasUnindexedIds;
    },
    resolve,
    lookup,
    references,
  };
}

/**
 * The role an `unevaluatedProperties` (`kind: 'properties'`) or
 * `unevaluatedItems` (`kind: 'items'`) keyword plays in `schema`:
 *
 * - `none`: absent, accepts everything, or has nothing left to evaluate
 *   because `additionalProperties` (or `items`) already evaluates every member;
 * - `rest`: no in-place applicator contributes evaluations, so it validates
 *   exactly the members `additionalProperties` (or `items`) would, and is
 *   compared as if it were that keyword;
 * - `closing`: its effect depends on which subschemas evaluate which members,
 *   which mcp-contract does not track, so structural changes nearby are
 *   reported as `unknown`.
 */
export function unevaluatedRole(
  schema: JsonObject,
  kind: 'properties' | 'items',
): 'none' | 'rest' | 'closing' {
  const value = get(schema, kind === 'properties' ? 'unevaluatedProperties' : 'unevaluatedItems');
  if (
    value === undefined ||
    value === true ||
    (isJsonObject(value) && Object.keys(value).length === 0)
  ) {
    return 'none';
  }
  if (kind === 'properties' && Object.hasOwn(schema, 'additionalProperties')) {
    return 'none';
  }
  if (kind === 'items') {
    const items = get(schema, 'items');
    if (
      items !== undefined &&
      (!Array.isArray(items) || Object.hasOwn(schema, 'additionalItems'))
    ) {
      return 'none';
    }
  }
  const applicators: readonly string[] =
    kind === 'items' ? [...IN_PLACE_APPLICATORS, 'contains'] : IN_PLACE_APPLICATORS;
  return applicators.some((keyword) => Object.hasOwn(schema, keyword)) ? 'closing' : 'rest';
}
