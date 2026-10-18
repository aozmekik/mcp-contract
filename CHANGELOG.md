# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, minor
versions may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-10-18

### Added

- `mcp-contract snapshot`: connect over stdio or Streamable HTTP, negotiate the
  protocol revision (2026-07-28 with fallback to the 2025 `initialize`
  handshake), list tools, prompts, resources and resource templates following
  pagination cursors, and write a canonical snapshot that records how the
  revision was negotiated and which revisions the server supports.
- `mcp-contract diff` and `mcp-contract check`: classify every change as
  breaking, non-breaking or unknown, from the client's point of view, with an
  explanation and a stable rule code.
- Direction-aware JSON Schema comparison: types, enum/const, numeric and
  string bounds, arrays and tuples, properties and `required`,
  `additionalProperties`, `unevaluatedProperties`/`unevaluatedItems`,
  `allOf`/`anyOf`/`oneOf`, and same-document references (JSON Pointer, `$id`,
  `$anchor`) including recursion. Analyses cut short by the step budget or
  the nesting limit are reported as `schema-too-complex` and always fail.
- `mcp-contract test`: YAML scenarios of tool calls with subset matching,
  JSONPath-style selectors, operators such as `$regex`, and `isError` or
  protocol-error expectations.
- Output formats: text (colored on a terminal), JSON, and GitHub (workflow
  annotations and a Markdown step summary, with server-provided text kept
  from acting as workflow commands). Exit codes 0 to 4 and 130.
- Library API: `snapshotServer`, `diffSnapshots`, `diffSchemas`,
  `expectNoBreakingChanges`, `runScenarios` and more.
- A composite GitHub Action (`action.yml`), not published on the Marketplace,
  with inputs for the server's environment, working directory and timeouts.
- Example notes server in two versions with a committed baseline and scenarios.

[Unreleased]: https://github.com/aozmekik/mcp-contract/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aozmekik/mcp-contract/releases/tag/v0.1.0
