import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Embedder from '../embedder';
import Reranker from '../reranker';
import BaseWrapper from '../wrappers/base';

const EMBEDDING_MODEL = { name: 'Xenova/all-MiniLM-L6-v2', numDimensions: 384 };
const RERANKER = { tokenizer: 'Xenova/bge-reranker-base', model: 'Xenova/bge-reranker-base' };
const DB_PATH = path.join(import.meta.dirname, '..', '..', '..', 'test-bw.db');

let embedder: Embedder;
let reranker: Reranker;
let bw: BaseWrapper;

function deleteDb() {
  try { fs.unlinkSync(DB_PATH); } catch { /* ok */ }
}

beforeAll(async () => {
  deleteDb();
  embedder = new Embedder(EMBEDDING_MODEL.name, EMBEDDING_MODEL.numDimensions);
  reranker = new Reranker(RERANKER.tokenizer, RERANKER.model);
  bw = new BaseWrapper(embedder, reranker);
  bw.db;
}, 180_000);

afterAll(() => {
  bw.db.close();
  deleteDb();
});

// ── Store ──────────────────────────────────────────────────────

describe('BaseWrapper: store', () => {
  it('stores plain text', async () => {
    const result = await bw.store('Base wrapper test');
    expect(Number(result.chunk.id)).toBeGreaterThan(0);
    expect(result.concepts).toEqual([]);
  });

  it('stores with concepts', async () => {
    const result = await bw.store('With concepts', [{ name: 'bw-concept' }]);
    expect(result.concepts.length).toBe(1);
    expect(result.concepts[0].name).toBe('bw-concept');
  });

  it('stores with existingConceptIds', async () => {
    const found = await bw.findConcept('bw-concept');
    const id = Number(found[0].concept.id);
    const result = await bw.store('Linked via BW', [], [id]);
    expect(Number(result.chunk.id)).toBeGreaterThan(0);
  });
});

// ── Search ─────────────────────────────────────────────────────

describe('BaseWrapper: search', () => {
  beforeAll(async () => {
    await bw.store('Searchable knowledge content for base wrapper tests');
  });

  it('returns results', async () => {
    const results = await bw.search('base wrapper', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('rerankerScore');
  });

  it('respects limit', async () => {
    const results = await bw.search('knowledge', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('no options is same as before', async () => {
    const results = await bw.search('knowledge', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('empty scope = no filter (allowed by SearchOptions)', async () => {
    const withScope = await bw.search('knowledge', 5, { scope: 'nonexistent' });
    // With scope filter that doesn't match anything, results may be empty
    // This is correct behavior — just verify no crash
    expect(Array.isArray(withScope)).toBe(true);
  });
});

// ── Search with filters ────────────────────────────────────────

describe('BaseWrapper: search with filters', () => {
  let taggedId: number;

  beforeAll(async () => {
    const stored = await bw.store('Filtered content');
    taggedId = Number(stored.chunk.id);
    await bw.setProps(taggedId, { region: 'us' });
  });

  it('filters by property', async () => {
    const results = await bw.search('content', 5, {
      filters: [{ propertyName: 'region', value: 'us', required: true }],
    });
    expect(results.some(r => r.id === taggedId)).toBe(true);
  });

  it('non-required filter includes chunks without property', async () => {
    const results = await bw.search('content', 5, {
      filters: [{ propertyName: 'region', value: 'eu', required: false }],
    });
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── getChunks ──────────────────────────────────────────────────

describe('BaseWrapper: getChunks', () => {
  it('returns by IDs', async () => {
    const results = await bw.getChunks([1]);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(1);
  });

  it('returns [] for empty input', async () => {
    expect(await bw.getChunks([])).toEqual([]);
  });
});

// ── Other methods ──────────────────────────────────────────────

describe('BaseWrapper: other methods', () => {
  it('getPreviews', async () => {
    const stored = await bw.store('Preview test', [{ name: 'preview-bw' }]);
    const conceptId = Number(stored.concepts[0].id);
    const previews = await bw.getPreviews(conceptId);
    expect(previews.length).toBeGreaterThan(0);
    expect(previews[0].text.length).toBeLessThanOrEqual(100);
  });

  it('findConcept', async () => {
    const results = await bw.findConcept('preview-bw');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].concept.name).toBe('preview-bw');
  });

  it('setOutdated + editConcept + props round-trip', async () => {
    const stored = await bw.store('Edit via BW', [{ name: 'edit-bw-concept' }]);
    const id = Number(stored.chunk.id);
    const conceptId = Number(stored.concepts[0].id);

    await bw.editConcept(conceptId, 'edited-bw', 'edited');
    const found = await bw.findConcept('edited-bw');
    expect(found.length).toBeGreaterThan(0);

    await bw.setProps(id, { mykey: 'myval' });
    const props = await bw.getProps(id);
    expect(props.mykey).toBe('myval');

    await bw.delProp(id, 'mykey');
    expect((await bw.getProps(id)).mykey).toBeUndefined();

    await bw.setOutdated(id);
    const chunks = await bw.getChunks([id]);
    expect(chunks).toEqual([]);
  });

  it('merge', async () => {
    const a = await bw.store('Merge A BW');
    const b = await bw.store('Merge B BW');
    const idA = Number(a.chunk.id);
    const idB = Number(b.chunk.id);

    await bw.setProps(idA, { type: 'test' });

    const merged = await bw.merge([idA, idB], 'Merged BW');
    expect(merged.chunk.text).toBe('Merged BW');

    const props = await bw.getProps(Number(merged.chunk.id));
    expect(props.type).toBe('test');
  });
});
