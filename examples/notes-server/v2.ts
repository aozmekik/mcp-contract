/**
 * Example MCP server, version 2. Compared with v1.ts it deliberately makes
 * breaking, non-breaking and undecidable changes, so that `mcp-contract diff`
 * has something to classify. Each change is marked with a comment saying how
 * mcp-contract classifies it.
 *
 *   node examples/notes-server/v2.ts            # stdio
 *   node examples/notes-server/v2.ts --http     # Streamable HTTP on a free port
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { serve } from './serve.ts';
import { NoteStore } from './store.ts';

const store = new NoteStore();

function result<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function createServer(): McpServer {
  const server = new McpServer(
    // NON-BREAKING: server version changed.
    { name: 'notes', version: '2.0.0' },
    { instructions: 'Search before creating a note to avoid duplicates.' },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      // NON-BREAKING: description changed.
      description: 'Full-text search over all notes, newest index first.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to look for'),
        // BREAKING: maximum lowered from 100 to 50.
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results'),
        // NON-BREAKING: new enum value "title".
        sort: z.enum(['relevance', 'recent', 'title']).optional(),
        // NON-BREAKING: new optional property.
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        // BREAKING (output): field `score` removed from results.
        results: z.array(z.object({ id: z.string(), title: z.string() })),
        // NON-BREAKING (output): new optional field.
        nextCursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, sort }) => {
      const hits = store.search(query, limit ?? 10, sort ?? 'relevance');
      return result({ total: hits.length, results: hits.map(({ id, title }) => ({ id, title })) });
    },
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description: 'Stores a new note and returns its id.',
      inputSchema: z.object({
        // NON-BREAKING: maxLength raised from 200 to 500.
        title: z.string().min(1).max(500),
        body: z.string(),
        tags: z.array(z.string()).optional(),
        // BREAKING: new required property.
        folder: z.string(),
      }),
      outputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ title, body, tags, folder }) => {
      const note = store.create({ title, body, tags: tags ?? [], folder });
      return result({ id: note.id });
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get note',
      description: 'Returns one note by id.',
      // UNKNOWN: pattern changed; regular-expression inclusion is not decidable here.
      inputSchema: z.object({ id: z.string().regex(/^note_[0-9a-f]+$/) }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        // BREAKING (output): body may now be null.
        body: z.string().nullable(),
        tags: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const note = store.get(id);
      if (note === undefined) {
        return failure(`Note ${id} not found.`);
      }
      return result({ id: note.id, title: note.title, body: note.body, tags: [...note.tags] });
    },
  );

  // BREAKING: delete_note removed.

  server.registerTool(
    'export_notes',
    {
      title: 'Export notes',
      description: 'Exports every note in the requested format.',
      inputSchema: z.object({
        // BREAKING: "json" removed. NON-BREAKING: "html" added.
        format: z.enum(['markdown', 'html']),
        // UNKNOWN: a new oneOf alternative can make previously valid input ambiguous.
        destination: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('inline') }),
          z.object({ kind: z.literal('file'), path: z.string() }),
          z.object({ kind: z.literal('url'), url: z.string() }),
        ]),
      }),
      // UNKNOWN: openWorldHint dropped, so it defaults to true (may reach external systems).
      annotations: { readOnlyHint: true },
    },
    ({ format }) => {
      const notes = store.list();
      const text =
        format === 'html'
          ? notes.map((note) => `<h1>${note.title}</h1><p>${note.body}</p>`).join('')
          : notes.map((note) => `# ${note.title}\n\n${note.body}`).join('\n\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  // NON-BREAKING: new tool.
  server.registerTool(
    'archive_note',
    {
      title: 'Archive note',
      description: 'Moves a note to the archive folder.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { idempotentHint: true },
    },
    ({ id }) => {
      const note = store.get(id);
      if (note === undefined) {
        return failure(`Note ${id} not found.`);
      }
      store.delete(id);
      store.create({ ...note, folder: 'archive' });
      return { content: [{ type: 'text', text: `Archived ${id}.` }] };
    },
  );

  server.registerPrompt(
    'summarize_note',
    {
      title: 'Summarize a note',
      description: 'Asks the model to summarize one note.',
      argsSchema: z.object({
        id: z.string(),
        // BREAKING: argument became required.
        style: z.string(),
        // NON-BREAKING: new optional argument.
        language: z.string().optional(),
      }),
    },
    ({ id, style, language }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize note ${id} in a ${style} style${language === undefined ? '' : ` in ${language}`}: ${store.get(id)?.body ?? '(missing)'}`,
          },
        },
      ],
    }),
  );

  server.registerResource(
    'index',
    'notes://index',
    // BREAKING: MIME type changed from application/json to text/markdown.
    { title: 'Note index', description: 'Ids and titles of all notes.', mimeType: 'text/markdown' },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: store
            .list()
            .map(({ id, title }) => `- ${id}: ${title}`)
            .join('\n'),
        },
      ],
    }),
  );

  // NON-BREAKING: new resource.
  server.registerResource(
    'stats',
    'notes://stats',
    {
      title: 'Statistics',
      description: 'Number of notes per folder.',
      mimeType: 'application/json',
    },
    (uri) => {
      const counts: Record<string, number> = {};
      for (const note of store.list()) {
        counts[note.folder] = (counts[note.folder] ?? 0) + 1;
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(counts) }] };
    },
  );

  server.registerResource(
    'note',
    new ResourceTemplate('notes://note/{id}', { list: undefined }),
    { title: 'Note', description: 'One note as Markdown.', mimeType: 'text/markdown' },
    (uri, { id }) => ({
      contents: [{ uri: uri.href, text: store.get(String(id))?.body ?? '' }],
    }),
  );

  return server;
}

serve(createServer);
