import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Embedder from '../embedder';
import Reranker from '../reranker';
import DB from '../db';

const EMBEDDING_MODEL = { name: 'Xenova/all-MiniLM-L6-v2', numDimensions: 384 };
const RERANKER = { tokenizer: 'Xenova/bge-reranker-base', model: 'Xenova/bge-reranker-base' };
const DB_PATH = path.join(import.meta.dirname, '..', '..', '..', 'test-db.db');

let embedder: Embedder;
let reranker: Reranker;
let db: DB;

function deleteDb() {
  try { fs.unlinkSync(DB_PATH); } catch { /* ok */ }
}

beforeAll(async () => {
  deleteDb();
  embedder = new Embedder(EMBEDDING_MODEL.name, EMBEDDING_MODEL.numDimensions);
  reranker = new Reranker(RERANKER.tokenizer, RERANKER.model);
  db = new DB(embedder, reranker);
  db.db; // trigger init
}, 180_000);

afterAll(() => {
  db.db.close();
  deleteDb();
});

// ── Schema ─────────────────────────────────────────────────────

describe('DB: Schema', () => {
  it('has all tables', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('chunks');
    expect(names).toContain('chunks_fts');
    expect(names).toContain('concepts');
    expect(names).toContain('concepts_fts');
    expect(names).toContain('edges');
    expect(names).toContain('properties');
    expect(names).toContain('chunk_properties');
    expect(names).toContain('vec_chunks');
    expect(names).toContain('vec_concepts');
  });

  it('chunks has native columns', () => {
    const info = db.db.prepare("PRAGMA table_info('chunks')").all() as { name: string; type: string }[];
    const names = info.map(c => c.name);
    expect(names).toContain('created_at');
    expect(names).toContain('access_count');
    expect(names).toContain('outdated');
  });

  it('has FTS triggers', () => {
    const triggers = db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
    const names = triggers.map(t => t.name);
    expect(names).toContain('chunks_ai');
    expect(names).toContain('chunks_ad');
    expect(names).toContain('chunks_au');
    expect(names).toContain('concepts_ai');
    expect(names).toContain('concepts_ad');
    expect(names).toContain('concepts_au');
  });
});

// ── Insert ─────────────────────────────────────────────────────

describe('DB: Insert', () => {
  it('inserts chunk without concepts', async () => {
    const result = await db.insertChunk('Simple chunk');
    expect(Number(result.chunk.id)).toBeGreaterThan(0);
    expect(result.chunk.text).toBe('Simple chunk');
    expect(result.concepts).toEqual([]);
  });

  it('inserts chunk with concepts', async () => {
    const result = await db.insertChunk('Chunk with tags', [
      { name: 'tag-a', description: 'first tag' },
      { name: 'tag-b' },
    ]);
    expect(result.concepts.length).toBe(2);
    expect(result.concepts[0].name).toBe('tag-a');
  });

  it('inserts chunk with existing concept IDs + properties', async () => {
    const first = await db.insertChunk('Concept holder', [{ name: 'shared-concept' }]);
    const conceptId = Number(first.concepts[0].id);

    const second = await db.insertChunk('Linked chunk', [], [conceptId], { scope: 'test' });
    expect(Number(second.chunk.id)).toBeGreaterThan(0);

    const edge = db.db.prepare('SELECT * FROM edges WHERE chunk_id = ? AND concept_id = ?').get(Number(second.chunk.id), conceptId);
    expect(edge).toBeDefined();

    const props = db.getChunkProperties(Number(second.chunk.id));
    expect(props.scope).toBe('test');
  });

  it('created_at is auto-set', () => {
    const row = db.db.prepare('SELECT created_at FROM chunks ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.created_at).toBeTruthy();
    expect(() => new Date(row.created_at)).not.toThrow();
  });

  it('access_count starts at 0', () => {
    const row = db.db.prepare('SELECT access_count FROM chunks ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.access_count).toBe(0);
  });
});

// ── Search ─────────────────────────────────────────────────────

describe('DB: Search', () => {
  beforeAll(async () => {
    await db.insertChunk('Crawl4AI is an open-source web crawler framework.');
    await db.insertChunk('AsyncWebCrawler is the main entry point for crawling.');
    await db.insertChunk('Markdown generation converts HTML to clean text.');
  });

  it('semanticSearch returns results', async () => {
    const results = await db.semanticSearch('web crawler', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.text).toBeTruthy();
    expect(results[0].concepts).toBeDefined();
  });

  it('keywordSearch returns results', async () => {
    const results = await db.keywordSearch('crawler', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('rowid');
    expect(results[0]).toHaveProperty('text');
    expect(results[0]).toHaveProperty('rank');
  });

  it('combinedSearch returns fusion results', async () => {
    const results = await db.combinedSearch('web crawler', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('rerankerScore');
    expect(results[0].rerankerScore).toBeGreaterThan(0);
  });

  it('combinedSearch with filters', async () => {
    // Tag chunk 1 with a scope
    db.setChunkProperties(1, { scope: 'backend' });

    const filtered = await db.combinedSearch('crawler', 5, [
      { propertyName: 'scope', value: 'backend', required: true },
    ]);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.some(r => r.id === 1)).toBe(true);

    const excluded = await db.combinedSearch('crawler', 5, [
      { propertyName: 'scope', value: 'frontend', required: true },
    ]);
    // Chunk 1 has scope=backend, so it should be excluded when filtering for frontend
    expect(excluded.some(r => r.id === 1)).toBe(false);
  });

  it('access_count increments on combinedSearch', async () => {
    // Search and get the top returned chunk
    const results = await db.combinedSearch('crawler', 5);
    expect(results.length).toBeGreaterThan(0);
    const returnedId = results[0].id;

    const before = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(returnedId) as any).access_count;
    await db.combinedSearch('crawler', 5);
    const after = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(returnedId) as any).access_count;
    expect(after).toBeGreaterThan(before);
  });
});

// ── Concepts ───────────────────────────────────────────────────

describe('DB: Concepts', () => {
  it('conceptCombinedSearch finds by name', async () => {
    await db.insertChunk('Concept sample', [{ name: 'UnicornConcept' }]);
    const results = await db.conceptCombinedSearch('UnicornConcept', '');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].concept.name).toBe('UnicornConcept');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('conceptCombinedSearch returns linked chunks', async () => {
    const results = await db.conceptCombinedSearch('UnicornConcept', '');
    expect(results[0].chunks.length).toBeGreaterThan(0);
    expect(results[0].chunks[0].text.length).toBeLessThanOrEqual(100);
  });

  it('editConcept updates name and FTS syncs', async () => {
    const stored = await db.insertChunk('Edit me', [{ name: 'EditMeConcept' }]);
    const conceptId = Number(stored.concepts[0].id);

    await db.editConcept(conceptId, 'EditedConcept', 'new description');

    const row = db.db.prepare('SELECT name, description FROM concepts WHERE id = ?').get(conceptId) as any;
    expect(row.name).toBe('EditedConcept');
    expect(row.description).toBe('new description');

    // FTS should find the new name
    const fts = db.db.prepare("SELECT rowid FROM concepts_fts WHERE name MATCH 'EditedConcept'").all();
    expect(fts.length).toBe(1);
  });
});

// ── EAV Properties ─────────────────────────────────────────────

describe('DB: EAV Properties', () => {
  const chunkId = 1;

  it('setChunkProperties stores and getChunkProperties retrieves', () => {
    db.setChunkProperties(chunkId, { color: 'red', size: 'large' });
    const props = db.getChunkProperties(chunkId);
    expect(props.color).toBe('red');
    expect(props.size).toBe('large');
  });

  it('overwrite property keeps others', () => {
    db.setChunkProperties(chunkId, { color: 'blue' });
    const props = db.getChunkProperties(chunkId);
    expect(props.color).toBe('blue');
    expect(props.size).toBe('large');
  });

  it('deleteChunkProperty removes single property', () => {
    db.deleteChunkProperty(chunkId, 'color');
    const props = db.getChunkProperties(chunkId);
    expect(props.color).toBeUndefined();
    expect(props.size).toBe('large');
  });

  it('getChunkProperties returns empty object for no props', () => {
    const props = db.getChunkProperties(99999);
    expect(props).toEqual({});
  });

  it('getChunksByProperty filters correctly', () => {
    // Chunk 1 has size=large
    const results = db.getChunksByProperty('size', 'large');
    expect(results.some(r => r.id === chunkId)).toBe(true);
    expect(results.some(r => r.id === 99999)).toBe(false);
  });

  it('getChunksByProperty excludes outdated', () => {
    db.setChunkOutdated(chunkId);
    const results = db.getChunksByProperty('size', 'large');
    expect(results.some(r => r.id === chunkId)).toBe(false);
    db.db.prepare('UPDATE chunks SET outdated = 0 WHERE id = ?').run(chunkId); // restore
  });
});

// ── getChunksByIds ─────────────────────────────────────────────

describe('DB: getChunksByIds', () => {
  it('returns matching chunks', () => {
    const results = db.getChunksByIds([1, 2]);
    expect(results.length).toBe(2);
    expect(results[0]).toHaveProperty('text');
  });

  it('excludes outdated chunks', () => {
    // Chunk 1 was restored in previous test, so it should appear
    const results = db.getChunksByIds([1]);
    expect(results.length).toBe(1);
  });

  it('returns [] for empty input', () => {
    expect(db.getChunksByIds([])).toEqual([]);
  });

  it('returns [] for non-existent IDs', () => {
    expect(db.getChunksByIds([99999])).toEqual([]);
  });
});

// ── getConceptChunks / getConceptsByIds ─────────────────────────

describe('DB: getConceptChunks & getConceptsByIds', () => {
  it('getConceptChunks returns truncated text', async () => {
    const stored = await db.insertChunk('X'.repeat(500), [{ name: 'trunc-test' }]);
    const conceptId = Number(stored.concepts[0].id);

    const chunks = db.getConceptChunks(conceptId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.length).toBeLessThanOrEqual(100);

    const longer = db.getConceptChunks(conceptId, 200);
    expect(longer[0].text.length).toBeLessThanOrEqual(200);
    expect(longer[0].text.length).toBeGreaterThan(100);
  });

  it('getConceptsByIds returns concepts', () => {
    const results = db.getConceptsByIds([1, 2]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('name');
  });
});

// ── Merge ──────────────────────────────────────────────────────

describe('DB: merge', () => {
  it('mergeChunks consolidates and marks sources outdated', async () => {
    await db.insertChunk('Merge source A');
    const idA = (db.db.prepare('SELECT MAX(id) FROM chunks').get() as any)['MAX(id)'];
    await db.insertChunk('Merge source B');
    const idB = (db.db.prepare('SELECT MAX(id) FROM chunks').get() as any)['MAX(id)'];

    db.setChunkProperties(idA, { source: 'first' });

    const merged = await db.mergeChunks([idA, idB], 'Merged result', []);
    expect(merged.chunk.text).toBe('Merged result');

    const outdatedA = (db.db.prepare('SELECT outdated FROM chunks WHERE id = ?').get(idA) as any).outdated;
    expect(outdatedA).toBe(1);

    // Properties copied from first source
    const props = db.getChunkProperties(merged.chunk.id);
    expect(props.source).toBe('first');
  });

  it('mergeChunks with empty sourceIds inserts new chunk', async () => {
    const result = await db.mergeChunks([], 'Orphan', []);
    expect(result.chunk.text).toBe('Orphan');
  });
});

// ── Outdated ───────────────────────────────────────────────────

describe('DB: setChunkOutdated', () => {
  it('excludes from vec search', async () => {
    const stored = await db.insertChunk('Chunk to be outdated for vec search');
    const id = Number(stored.chunk.id);
    db.setChunkOutdated(id);

    const results = await db.semanticSearch('outdated', 10);
    expect(results.some(r => Number(r.chunk.id) === id)).toBe(false);
  });

  it('excludes from FTS', async () => {
    const results = await db.keywordSearch('outdated', 10);
    expect(results.some(r => r.rowid === 7)).toBe(false); // outdated chunks excluded
  });
});

// ── incrementAccessCounts (indirect) ───────────────────────────

describe('DB: access_count auto-increment', () => {
  it('getChunksByIds increments access_count', () => {
    const before = (db.db.prepare('SELECT access_count FROM chunks WHERE id = 1').get() as any).access_count;
    db.getChunksByIds([1]);
    const after = (db.db.prepare('SELECT access_count FROM chunks WHERE id = 1').get() as any).access_count;
    expect(after).toBe(before + 1);
  });
});
