# Examples

`notes-server/` is a small MCP server built with the official TypeScript SDK
(`@modelcontextprotocol/server` 2.x). It exists in two versions:

| File                            | Purpose                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `notes-server/v1.ts`            | The baseline contract: five tools, one prompt, one resource, one resource template.                            |
| `notes-server/v2.ts`            | The same server with deliberate changes. Every change carries a comment saying how mcp-contract classifies it. |
| `notes-server/v1.snapshot.json` | The committed baseline, written by `mcp-contract snapshot`.                                                    |
| `notes-server/scenarios.yaml`   | Fixture tool calls with assertions, for `mcp-contract test`.                                                   |
| `notes-server/serve.ts`         | Transport bootstrap: stdio by default, Streamable HTTP with `--http`.                                          |

Both servers run directly with Node's built-in type stripping (Node 22.18 or newer):

```sh
npm install && npm run build

# Classify v2 against the committed v1 baseline: 8 breaking, 3 unknown, 10 non-breaking.
node dist/cli.js check --stdio "node examples/notes-server/v2.ts" \
  --snapshot examples/notes-server/v1.snapshot.json

# Same thing over Streamable HTTP.
node examples/notes-server/v2.ts --http     # prints: listening on http://127.0.0.1:<port>/mcp
node dist/cli.js check --url http://127.0.0.1:<port>/mcp \
  --snapshot examples/notes-server/v1.snapshot.json

# Run the scenarios: all pass on v1, two fail on v2.
node dist/cli.js test examples/notes-server/scenarios.yaml
node dist/cli.js test examples/notes-server/scenarios.yaml --stdio "node examples/notes-server/v2.ts"
```

`npm run examples` runs all of this and checks every exit code; CI runs it on
every push. The end-to-end tests in `test/e2e/` assert the exact list of
changes, over both transports.
