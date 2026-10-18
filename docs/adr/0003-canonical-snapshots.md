# ADR 0003: Canonical, deterministic snapshot files

- Status: accepted
- Date: 2026-10-18

## Context

The snapshot is committed next to the server's code and compared in CI. If
two snapshots of an unchanged server can differ, every pull request carries
noise, reviewers learn to ignore the file, and the check loses its value.
Sources of accidental difference:

- object key order (servers and SDKs serialise in insertion order);
- list order (tools are usually returned in registration order, but pages and
  refactors can reorder them);
- set-valued schema keywords (`required`, array-form `type`) written in a
  different order after a refactor;
- volatile data such as timestamps or the time a snapshot was taken.

## Options considered

1. **Store the raw `list` responses.** Faithful, but every reordering is a
   textual diff, even though `diff` would classify it as no change.
2. **A custom format** (for example YAML with hand-chosen ordering). Readable,
   but it invents a second representation of MCP data that must be kept in
   sync with the specification.
3. **The MCP JSON itself, canonicalised.**

## Decision

Option 3:

- object keys sorted by UTF-16 code units, the ordering of RFC 8785 (JSON
  Canonicalization Scheme); non-JSON values (NaN, functions, cycles, class
  instances) are rejected rather than silently dropped;
- tools and prompts sorted by name, resources by URI, resource templates by
  URI template (ties broken by canonical JSON);
- `required` and array-form `type` sorted and de-duplicated; `enum` order is
  kept because servers often order values for display;
- no timestamps, no host names, nothing that changes between runs;
- two-space indentation and a trailing newline, so diffs in code review are
  line-oriented;
- a top-level `formatVersion` (currently 1), checked on read;
- atomic writes (temporary file, then rename).

The negotiated protocol revision (with the negotiation mode and, for modern
servers, the revisions `server/discover` lists) and the server's
self-reported name and version are part of the snapshot: they are part of
what clients observe. The supported revisions are a set, so they are sorted.
Fields added later are optional, so older snapshots keep parsing without a
`formatVersion` change.

## Consequences

- An unchanged server produces byte-identical snapshots; the end-to-end test
  asserts that a live snapshot of the example server equals the committed file.
- Unknown fields are preserved, so new specification fields are captured
  (and reported as `unknown` changes) before mcp-contract has rules for them.
- The server version is recorded, so every release shows one non-breaking
  `server-info-changed` change. That is accurate, but it means a baseline that
  is never refreshed accumulates expected noise.
- Servers whose resource list is dynamic (for example one resource per file)
  produce snapshots that change with their data. There is no filter for that
  yet; it is on the roadmap.
