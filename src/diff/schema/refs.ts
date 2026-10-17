/**
 * Local `$ref` resolution. Only same-document references (`#`, `#/...` JSON
 * Pointers per RFC 6901) are followed: the MCP specification forbids
 * dereferencing network URIs by default, so anything else is reported as
 * unresolvable rather than fetched.
 */
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.ts';
import { ANNOTATION_KEYWORDS } from '../../schema/keywords.ts';
import { get } from './context.ts';

/** Result of following a reference. */
export type Lookup =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: string };

/** Keywords that neither constrain nor annotate the instance at their own location. */
export const STRUCTURAL_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  '$schema',
  '$id',
  '$defs',
  'definitions',
]);

const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/** Resolves a same-document reference against `root`. */
export function lookupRef(root: JsonValue, ref: string): Lookup {
  if (!ref.startsWith('#')) {
    return {
      ok: false,
      reason: `non-local $ref "${ref}" is not dereferenced (the MCP specification forbids fetching network references)`,
    };
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return { ok: false, reason: `$ref "${ref}" is not a valid URI fragment` };
  }
  if (pointer === '') {
    return { ok: true, value: root };
  }
  if (!pointer.startsWith('/')) {
    return {
      ok: false,
      reason: `$ref "${ref}" uses a named anchor, which mcp-contract does not resolve`,
    };
  }
  let node: JsonValue | undefined = root;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) {
      node = ARRAY_INDEX.test(token) ? node[Number(token)] : undefined;
    } else if (isJsonObject(node)) {
      node = get(node, token);
    } else {
      node = undefined;
    }
    if (node === undefined) {
      return { ok: false, reason: `$ref "${ref}" does not resolve inside the schema` };
    }
  }
  return { ok: true, value: node };
}

function pickAnnotations(schema: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Follows `$ref` chains. Annotations written next to a `$ref` (typically a
 * `description`) are kept and win over the target's; constraint keywords next
 * to a `$ref` are combined with the target as an implicit `allOf`, which is
 * what JSON Schema 2020-12 specifies.
 */
export function resolve(raw: JsonValue, root: JsonValue): Lookup {
  let current = raw;
  let annotations: JsonObject = {};
  const seen = new Set<string>();
  while (isJsonObject(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (seen.has(ref)) {
      return { ok: false, reason: `$ref "${ref}" only refers to itself` };
    }
    seen.add(ref);
    const target = lookupRef(root, ref);
    if (!target.ok) {
      return target;
    }
    const siblings: JsonObject = {};
    for (const [key, value] of Object.entries(current)) {
      if (!STRUCTURAL_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
        siblings[key] = value;
      }
    }
    annotations = { ...pickAnnotations(current), ...annotations };
    if (Object.keys(siblings).length > 0) {
      return { ok: true, value: { allOf: [target.value, siblings], ...annotations } };
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
}
