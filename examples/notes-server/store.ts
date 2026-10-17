/** In-memory note storage shared by both versions of the example server. */

/** A stored note. */
export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly folder: string;
}

/** A search hit. */
export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly score: number;
}

const SEED: readonly Omit<Note, 'id'>[] = [
  {
    title: 'Model Context Protocol',
    body: 'MCP lets agents call tools exposed by servers. The protocol uses JSON-RPC.',
    tags: ['mcp', 'reading'],
    folder: 'inbox',
  },
  {
    title: 'Contract testing',
    body: 'A contract test checks that a provider still satisfies what its consumers rely on.',
    tags: ['testing'],
    folder: 'inbox',
  },
  {
    title: 'Release checklist',
    body: 'Bump the version, update the changelog, run the protocol contract check.',
    tags: ['process'],
    folder: 'work',
  },
];

/** Deterministic in-memory store: ids are sequential and searches are stable. */
export class NoteStore {
  readonly #notes = new Map<string, Note>();
  #nextId = 1;

  constructor(seed: readonly Omit<Note, 'id'>[] = SEED) {
    for (const note of seed) {
      this.create(note);
    }
  }

  /** Stores a note and returns it with its new id. */
  create(note: Omit<Note, 'id'>): Note {
    const stored = { ...note, id: `n_${this.#nextId}` };
    this.#nextId += 1;
    this.#notes.set(stored.id, stored);
    return stored;
  }

  /** Returns the note with `id`, if any. */
  get(id: string): Note | undefined {
    return this.#notes.get(id);
  }

  /** Deletes a note; returns whether it existed. */
  delete(id: string): boolean {
    return this.#notes.delete(id);
  }

  /** All notes in creation order. */
  list(): Note[] {
    return [...this.#notes.values()];
  }

  /** Case-insensitive term-frequency search. */
  search(query: string, limit: number, sort: 'relevance' | 'recent' | 'title'): SearchHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = this.list()
      .map((note, index) => {
        const text = `${note.title} ${note.body}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + text.split(term).length - 1, 0);
        return { id: note.id, title: note.title, score, index };
      })
      .filter((hit) => hit.score > 0);
    hits.sort((a, b) => {
      if (sort === 'recent') {
        return b.index - a.index;
      }
      if (sort === 'title') {
        return a.title.localeCompare(b.title);
      }
      return b.score - a.score || a.index - b.index;
    });
    return hits.slice(0, limit).map(({ id, title, score }) => ({ id, title, score }));
  }
}
