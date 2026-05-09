import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Embedder from '../embedder';
import Reranker from '../reranker';
import CodingWrapper from '../wrappers/coding';
import DB from '../db';

const EMBEDDING_MODEL = { name: 'Xenova/all-MiniLM-L6-v2', numDimensions: 384 };
const RERANKER = { tokenizer: 'Xenova/bge-reranker-base', model: 'Xenova/bge-reranker-base' };
const DB_PATH = path.join(import.meta.dirname, '..', '..', '..', 'test.db');

let embedder: Embedder;
let reranker: Reranker;
let cw: CodingWrapper;
let db: DB;

// ── Setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  deleteDb();
  embedder = new Embedder(EMBEDDING_MODEL.name, EMBEDDING_MODEL.numDimensions);
  reranker = new Reranker(RERANKER.tokenizer, RERANKER.model);
  cw = new CodingWrapper(embedder, reranker, { dbPath: DB_PATH });
  db = cw;
  // Trigger DB initialization so the file exists
  db.db;
}, 180_000);

afterAll(() => {
  db.db.close();
  deleteDb();
});

function deleteDb() {
  try { fs.unlinkSync(DB_PATH); } catch { /* ok */ }
}

function getDbPath(): string {
  return DB_PATH;
}

// ── Phase 1: DB Location ───────────────────────────────────────

describe('Phase 1: DB Location', () => {
  it('1.1 creates DB at default path', () => {
    expect(fs.existsSync(getDbPath())).toBe(true);
  });

  it('1.2 DB file is a valid SQLite file', () => {
    const header = fs.readFileSync(getDbPath()).slice(0, 16).toString();
    expect(header).toContain('SQLite format 3');
  });
});

// ── Phase 2: Seed & Schema ─────────────────────────────────────

describe('Phase 2: Schema & Counts', () => {
  it('2.1 has all required tables', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('chunks');
    expect(names).toContain('chunks_fts');
    expect(names).toContain('concepts');
    expect(names).toContain('concepts_fts');
    expect(names).toContain('edges');
    expect(names).toContain('properties');
    expect(names).toContain('chunk_properties');
    expect(names).not.toContain('vec_chunks');
    expect(names).not.toContain('vec_concepts');
  });

  it('2.2 chunks have native columns', () => {
    const info = db.db.prepare("PRAGMA table_info('chunks')").all() as { name: string; type: string }[];
    const created = info.find(c => c.name === 'created_at');
    const access = info.find(c => c.name === 'access_count');
    expect(created).toBeDefined();
    expect(created!.type).toMatch(/text/i);
    expect(access).toBeDefined();
    expect(access!.type).toMatch(/int/i);
  });
});

// ── Phase 3: Store ─────────────────────────────────────────────

describe('Phase 3: Store', () => {
  let chunkId: number;

  it('3.1 stores plain text', async () => {
    const result = await cw.store('Crawl4AI is an open-source LLM-friendly web crawler.');
    expect(result.chunk.id).toBeDefined();
    expect(result.chunk.text).toBe('Crawl4AI is an open-source LLM-friendly web crawler.');
    expect(result.concepts).toEqual([]);
    chunkId = Number(result.chunk.id);
  });

  it('3.2 store auto-sets created_at', () => {
    const row = db.db.prepare('SELECT created_at FROM chunks WHERE id = ?').get(chunkId) as any;
    expect(row.created_at).toBeTruthy();
    expect(() => new Date(row.created_at)).not.toThrow();
  });

  it('3.3 store auto-sets access_count = 0', () => {
    const row = db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(chunkId) as any;
    expect(row.access_count).toBe(0);
  });

  it('3.4 stores with concepts', async () => {
    const result = await cw.store('Memory with tags', [{ name: 'test-concept' }]);
    expect(result.concepts.length).toBe(1);
    expect(result.concepts[0].name).toBe('test-concept');
  });

  it('3.5 stores with existing concept IDs', async () => {
    // Find the concept we just created
    const found = await cw.findConcept('test-concept');
    expect(found.length).toBeGreaterThan(0);
    const conceptId = Number(found[0].concept.id);

    const result = await cw.store('Linked memory', [], [conceptId]);
    expect(Number(result.chunk.id)).toBeGreaterThan(0);

    // Verify edge exists
    const edge = db.db.prepare('SELECT * FROM edges WHERE chunk_id = ? AND concept_id = ?').get(Number(result.chunk.id), conceptId);
    expect(edge).toBeDefined();
  });

  it('3.6 stores with sources', async () => {
    const result = await cw.store('Sourced memory', [], [], ['https://example.com']);
    const props = await cw.getProps(Number(result.chunk.id));
    expect(props.sources).toBe('["https://example.com"]');
  });
});

// ── Phase 4: Search ────────────────────────────────────────────

describe('Phase 4: Search', () => {
  it('4.1 basic search returns results', async () => {
    const results = await cw.search('web crawler', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('text');
    expect(results[0]).toHaveProperty('rerankerScore');
  });

  it('4.2 search respects limit', async () => {
    const results = await cw.search('memory', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('4.3 search with scope filter', async () => {
    // Tag a chunk with scope
    const stored = await cw.store('Backend specific knowledge');
    const id = Number(stored.chunk.id);
    await cw.setProps(id, { scope: 'backend' });

    const results = await cw.search('knowledge', 5, { scope: 'backend' });
    expect(results.some(r => r.id === id)).toBe(true);

    // Search with different scope should NOT return it
    const filtered = await cw.search('knowledge', 5, { scope: 'frontend' });
    expect(filtered.some(r => r.id === id)).toBe(false);
  });

  it('4.4 search without scope includes all', async () => {
    const results = await cw.search('knowledge', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('4.5 access count incremented on search', async () => {
    const results = await cw.search('Crawl4AI', 5);
    expect(results.length).toBeGreaterThan(0);
    const idToCheck = results[0].id;

    const before = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(idToCheck) as any).access_count;
    await cw.search('Crawl4AI', 5);
    const after = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(idToCheck) as any).access_count;
    expect(after).toBeGreaterThan(before);
  });
});

// ── Phase 5: Retrieval ─────────────────────────────────────────

describe('Phase 5: Retrieval', () => {
  it('5.1 getChunks by IDs', async () => {
    const results = await cw.getChunks([1, 2]);
    expect(results.length).toBe(2);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('text');
  });

  it('5.2 getChunks with non-existent ID returns empty', async () => {
    const results = await cw.getChunks([99999]);
    expect(results).toEqual([]);
  });

  it('5.3 getChunks mixed IDs', async () => {
    const results = await cw.getChunks([1, 99999]);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(1);
  });

  it('5.4 getPreviews returns truncated text', async () => {
    // Store a chunk with a concept
    const stored = await cw.store('A'.repeat(500), [{ name: 'preview-concept' }]);
    const conceptId = Number(stored.concepts[0].id);

    const previews = await cw.getPreviews(conceptId);
    expect(previews.length).toBeGreaterThan(0);
    expect(previews[0].text.length).toBeLessThanOrEqual(100);
  });

  it('5.5 getPreviews with custom maxLen', async () => {
    const stored = await cw.store('B'.repeat(500), [{ name: 'preview-concept2' }]);
    const conceptId = Number(stored.concepts[0].id);

    const previews = await cw.getPreviews(conceptId, 200);
    expect(previews[0].text.length).toBeLessThanOrEqual(200);
    expect(previews[0].text.length).toBeGreaterThan(100);
  });

  it('5.6 findConcept by name', async () => {
    await cw.store('Concept test chunk', [{ name: 'TestConcept', description: 'A test concept' }]);
    const results = await cw.findConcept('TestConcept');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].concept.name).toBe('TestConcept');
  });

  it('5.7 findConcept returns score', async () => {
    const results = await cw.findConcept('TestConcept');
    expect(results[0].score).toBeGreaterThan(0);
  });
});

// ── Phase 6: EAV Properties ────────────────────────────────────

describe('Phase 6: EAV Properties', () => {
  const chunkId = 1;

  it('6.1 setProps + getProps round-trip', async () => {
    await cw.setProps(chunkId, { key1: 'val1' });
    const props = await cw.getProps(chunkId);
    expect(props.key1).toBe('val1');
  });

  it('6.2 multiple properties', async () => {
    await cw.setProps(chunkId, { a: '1', b: '2' });
    const props = await cw.getProps(chunkId);
    expect(props.a).toBe('1');
    expect(props.b).toBe('2');
  });

  it('6.3 overwrite property', async () => {
    await cw.setProps(chunkId, { a: 'X' });
    const props = await cw.getProps(chunkId);
    expect(props.a).toBe('X');
    expect(props.b).toBe('2'); // unchanged
  });

  it('6.4 delete property', async () => {
    await cw.delProp(chunkId, 'a');
    const props = await cw.getProps(chunkId);
    expect(props.a).toBeUndefined();
    expect(props.b).toBe('2');
  });

  it('6.5 properties table registered names', () => {
    const props = db.db.prepare('SELECT name FROM properties').all() as { name: string }[];
    const names = props.map(p => p.name);
    // Properties that should exist from our tests
    expect(names).toContain('key1');
    expect(names).toContain('b');
  });
});

// ── Phase 7: Outdated ──────────────────────────────────────────

describe('Phase 7: Outdated', () => {
  let chunkId: number;

  it('7.1 setOutdated marks chunk', async () => {
    const stored = await cw.store('This chunk will be outdated');
    chunkId = Number(stored.chunk.id);
    await cw.setOutdated(chunkId);

    const row = db.db.prepare('SELECT outdated FROM chunks WHERE id = ?').get(chunkId) as any;
    expect(row.outdated).toBe(1);
  });

  it('7.2 outdated chunk excluded from search', async () => {
    const results = await cw.search('will be outdated', 5);
    expect(results.some(r => r.id === chunkId)).toBe(false);
  });

  it('7.3 outdated chunk excluded from getChunks', async () => {
    const results = await cw.getChunks([chunkId]);
    expect(results).toEqual([]);
  });
});

// ── Phase 8: Edit Concept ──────────────────────────────────────

describe('Phase 8: Edit Concept', () => {
  it('8.1 editConcept updates name and description', async () => {
    const stored = await cw.store('Edit test chunk', [{ name: 'old-name', description: 'old desc' }]);
    const conceptId = Number(stored.concepts[0].id);

    await cw.editConcept(conceptId, 'new-name', 'new desc');

    const row = db.db.prepare('SELECT name, description FROM concepts WHERE id = ?').get(conceptId) as any;
    expect(row.name).toBe('new-name');
    expect(row.description).toBe('new desc');
  });

  it('8.2 findConcept finds updated name', async () => {
    const results = await cw.findConcept('new-name');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].concept.name).toBe('new-name');
  });
});

// ── Phase 9: Merge ─────────────────────────────────────────────

describe('Phase 9: Merge', () => {
  it('9.1 merge creates consolidated chunk', async () => {
    const a = await cw.store('Source chunk A');
    const b = await cw.store('Source chunk B');
    const idA = Number(a.chunk.id);
    const idB = Number(b.chunk.id);

    await cw.setProps(idA, { scope: 'test' });

    const merged = await cw.merge([idA, idB], 'Consolidated text');
    expect(merged.chunk.text).toBe('Consolidated text');

    // Source chunks should be outdated
    const rowA = db.db.prepare('SELECT outdated FROM chunks WHERE id = ?').get(idA) as any;
    expect(rowA.outdated).toBe(1);
    const rowB = db.db.prepare('SELECT outdated FROM chunks WHERE id = ?').get(idB) as any;
    expect(rowB.outdated).toBe(1);
  });

  it('9.2 merge copies properties from first source', async () => {
    // The merged chunk should have properties copied from first source
    const mergedId = db.db.prepare('SELECT MAX(id) FROM chunks').get() as any;
    // We can't predict the ID, but we know the most recent insert was the merge
    const props = await cw.getProps(mergedId['MAX(id)']);
    expect(props.scope).toBe('test');
  });
});

// ── Phase 10: Error Handling ───────────────────────────────────

describe('Phase 10: Error Handling', () => {
  it('10.1 getChunks empty array returns []', async () => {
    const result = await cw.getChunks([]);
    expect(result).toEqual([]);
  });

  it('10.2 setProps on non-existent chunk throws', async () => {
    await expect(cw.setProps(99999, { x: 'y' })).rejects.toThrow();
  });

  it('10.3 merge with empty sourceIds inserts new chunk', async () => {
    const result = await cw.merge([], 'Orphan chunk');
    expect(result.chunk.text).toBe('Orphan chunk');
  });
});
