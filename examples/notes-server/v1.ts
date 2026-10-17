/**
 * Example MCP server, version 1: a small notes service built with the official
 * TypeScript SDK. Version 2 (v2.ts) changes this contract on purpose.
 *
 *   node examples/notes-server/v1.ts            # stdio
 *   node examples/notes-server/v1.ts --http     # Streamable HTTP on a free port
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
    { name: 'notes', version: '1.0.0' },
    { instructions: 'Search before creating a note to avoid duplicates.' },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description: 'Full-text search over all notes.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to look for'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results'),
        sort: z.enum(['relevance', 'recent']).optional(),
      }),
      outputSchema: z.object({
        total: z.number().int(),
        results: z.array(z.object({ id: z.string(), title: z.string(), score: z.number() })),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, sort }) => {
      const hits = store.search(query, limit ?? 10, sort ?? 'relevance');
      return result({ total: hits.length, results: hits });
    },
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description: 'Stores a new note and returns its id.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        body: z.string(),
        tags: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ title, body, tags }) => {
      const note = store.create({ title, body, tags: tags ?? [], folder: 'inbox' });
      return result({ id: note.id });
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get note',
      description: 'Returns one note by id.',
      inputSchema: z.object({ id: z.string().regex(/^n_[0-9]+$/) }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
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

  server.registerTool(
    'delete_note',
    {
      title: 'Delete note',
      description: 'Deletes a note permanently.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ id }) =>
      store.delete(id)
        ? { content: [{ type: 'text', text: `Deleted ${id}.` }] }
        : failure(`Note ${id} not found.`),
  );

  server.registerTool(
    'export_notes',
    {
      title: 'Export notes',
      description: 'Exports every note in the requested format.',
      inputSchema: z.object({
        format: z.enum(['markdown', 'json']),
        destination: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('inline') }),
          z.object({ kind: z.literal('file'), path: z.string() }),
        ]),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ format }) => {
      const notes = store.list();
      const text =
        format === 'json'
          ? JSON.stringify(notes)
          : notes.map((note) => `# ${note.title}\n\n${note.body}`).join('\n\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerPrompt(
    'summarize_note',
    {
      title: 'Summarize a note',
      description: 'Asks the model to summarize one note.',
      argsSchema: z.object({ id: z.string(), style: z.string().optional() }),
    },
    ({ id, style }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize note ${id}${style === undefined ? '' : ` in a ${style} style`}: ${store.get(id)?.body ?? '(missing)'}`,
          },
        },
      ],
    }),
  );

  server.registerResource(
    'index',
    'notes://index',
    {
      title: 'Note index',
      description: 'Ids and titles of all notes.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(store.list().map(({ id, title }) => ({ id, title }))),
        },
      ],
    }),
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
