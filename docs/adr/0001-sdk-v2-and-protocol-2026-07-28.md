# ADR 0001: Build on the v2 TypeScript SDK and target MCP 2026-07-28

- Status: accepted
- Date: 2026-10-18

## Context

mcp-contract has to talk to arbitrary MCP servers: connect, negotiate a
protocol revision, page through `tools/list`, `prompts/list`,
`resources/list` and `resources/templates/list`, and call tools.

When this project started (October 2026):

- The current MCP specification revision is
  [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28). It
  removes the `initialize` handshake: requests carry their protocol version in
  `_meta`, and clients may call `server/discover` to learn what a server
  supports. Revisions up to 2025-11-25 are handshake-based.
- `@modelcontextprotocol/sdk` 1.32.1 is the v1 line. Its README calls it the
  maintenance line: it implements the specification up to 2025-11-25 and
  support for 2026-07-28 is not planned.
- The official SDK's stable line is v2, published as separate packages:
  `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.3.1. It
  implements 2026-07-28 and can still negotiate the 2025 handshake.
- Most servers in the wild are still 2025-era, and will be for a while.

A contract tester must work with both kinds of server, or it is useless
during the transition.

## Options considered

1. **v1 SDK (`@modelcontextprotocol/sdk`).** Mature and widely used, but it
   cannot speak 2026-07-28. A server that only accepts the modern revision
   could not be tested at all, and we would have to migrate soon anyway.
2. **Our own JSON-RPC client.** Full control over negotiation and pagination,
   but it duplicates transports, Streamable HTTP session handling, SSE
   resumption and auth plumbing that the SDK already maintains, and it would
   drift from the specification.
3. **v2 SDK (`@modelcontextprotocol/client`).** Implements 2026-07-28 and
   falls back to the `initialize` handshake. Negotiation is a client option:
   `auto` probes with `server/discover`, `legacy` runs the 2025 handshake, and
   `{ pin }` requires a revision.

## Decision

Use the v2 client (option 3) with negotiation `auto` by default, exposed as
`--protocol auto|legacy|<revision>`. The example servers use the v2 server
package (`serveStdio`, `createMcpHandler`) so both eras are exercised in tests.

mcp-contract still implements two things itself, because they are part of
what it promises:

- pagination is walked explicitly (`client.request({ method, params: { cursor } })`)
  so that a repeated cursor and a page cap are reported as server errors with
  a clear message;
- the negotiated era and revision are recorded in every snapshot.

## Consequences

- Both eras work over stdio and Streamable HTTP; the end-to-end tests cover
  `auto`, `legacy` and a pinned revision against the same server.
- With `auto`, the SDK probes a stdio server on a short-lived sibling process
  before starting the real one, because some 2025-era servers exit on any
  request before `initialize`. Every `snapshot`/`check` therefore starts the
  server twice; measured cost on the example server: about 210 ms per run (see
  the README benchmarks). `--protocol legacy` avoids it for servers known to
  be 2025-era.
- On stdio, a probe that times out is taken as a legacy server. A slow-starting
  modern server is therefore not misclassified only if the timeout is long
  enough; the probe uses the same timeout as every request (30 s by default)
  rather than a short one for that reason.
- The SDK does not watch the abort signal during the stdio probe; closing the
  transport does abort it. `connectServer` closes the transport when the
  signal fires, so Ctrl-C works in every phase (covered by a test).
- The negotiated revision is part of the snapshot, so moving a server from the
  2025 SDK to the v2 SDK shows up as an `unknown` `protocol-changed` change
  that has to be acknowledged by re-taking the baseline.
- We depend on a young major version. The SDK's typings and behaviour are
  isolated in `src/connect/` and `src/snapshot/capture.ts`, so an API change is
  contained there.
