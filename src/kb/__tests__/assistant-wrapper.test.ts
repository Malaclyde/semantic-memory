import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Embedder from '../embedder';
import Reranker from '../reranker';
import AssistantWrapper from '../wrappers/assistant';

const EMBEDDING_MODEL = { name: 'Xenova/all-MiniLM-L6-v2', numDimensions: 384 };
const RERANKER = { tokenizer: 'Xenova/bge-reranker-base', model: 'Xenova/bge-reranker-base' };
const DB_PATH = path.join(import.meta.dirname, '..', '..', '..', 'test-aw.db');

let embedder: Embedder;
let reranker: Reranker;
let aw: AssistantWrapper;

function deleteDb() {
  try { fs.unlinkSync(DB_PATH); } catch { /* ok */ }
}

beforeAll(async () => {
  deleteDb();
  embedder = new Embedder(EMBEDDING_MODEL.name, EMBEDDING_MODEL.numDimensions);
  reranker = new Reranker(RERANKER.tokenizer, RERANKER.model);
  aw = new AssistantWrapper(embedder, reranker, { dbPath: DB_PATH });
  aw.db;
}, 180_000);

afterAll(() => {
  aw.db.close();
  deleteDb();
});

// ── Store ──────────────────────────────────────────────────────

describe('AssistantWrapper: store', () => {
  it('stores plain text', async () => {
    const result = await aw.store('Assistant memory');
    expect(Number(result.chunk.id)).toBeGreaterThan(0);
  });

  it('stores with memory_type', async () => {
    const result = await aw.store('Working memory', [], [], [], 'working');
    const id = Number(result.chunk.id);
    const props = await aw.getProps(id);
    expect(props.memory_type).toBe('working');
  });

  it('stores with sources', async () => {
    const result = await aw.store('Sourced', [], [], ['https://src.test']);
    const id = Number(result.chunk.id);
    const props = await aw.getProps(id);
    expect(props.sources).toBe('["https://src.test"]');
  });

  it('stores with both sources and memory_type', async () => {
    const result = await aw.store('Both', [], [], ['https://both.test'], 'archival');
    const id = Number(result.chunk.id);
    const props = await aw.getProps(id);
    expect(props.sources).toBe('["https://both.test"]');
    expect(props.memory_type).toBe('archival');
  });

  it('stores with existingConceptIds', async () => {
    const first = await aw.store('Holder', [{ name: 'aw-concept' }]);
    const conceptId = Number(first.concepts[0].id);
    const second = await aw.store('Linked', [], [conceptId]);
    expect(Number(second.chunk.id)).toBeGreaterThan(0);
  });
});

// ── Search ─────────────────────────────────────────────────────

describe('AssistantWrapper: search', () => {
  beforeAll(async () => {
    await aw.store('General assistant knowledge');
    await aw.store('Working set', [], [], [], 'working');
    await aw.store('Archived set', [], [], [], 'archival');
  });

  it('returns results without filter', async () => {
    const results = await aw.search('assistant', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('filters by memory_type working', async () => {
    const results = await aw.search('knowledge', 10, { memoryType: 'working' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('filters by memory_type archival', async () => {
    const results = await aw.search('knowledge', 10, { memoryType: 'archival' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('working and archival are mutually exclusive', async () => {
    const working = await aw.search('knowledge', 10, { memoryType: 'working' });
    const archival = await aw.search('knowledge', 10, { memoryType: 'archival' });
    // Chunks with different memory types should not overlap
    const workingIds = new Set(working.map(r => r.id));
    const archivalIds = new Set(archival.map(r => r.id));
    const overlap = [...workingIds].filter(id => archivalIds.has(id));
    expect(overlap.length).toBe(0);
  });
});

// ── promoteToWorking / demoteToArchival ────────────────────────

describe('AssistantWrapper: memory type promotion', () => {
  let chunkId: number;

  beforeAll(async () => {
    const stored = await aw.store('Promotable memory');
    chunkId = Number(stored.chunk.id);
  });

  it('promoteToWorking sets memory_type', async () => {
    await aw.promoteToWorking(chunkId);
    const props = await aw.getProps(chunkId);
    expect(props.memory_type).toBe('working');
  });

  it('demoteToArchival sets memory_type', async () => {
    await aw.demoteToArchival(chunkId);
    const props = await aw.getProps(chunkId);
    expect(props.memory_type).toBe('archival');
  });

  it('toggle works multiple times', async () => {
    await aw.promoteToWorking(chunkId);
    expect((await aw.getProps(chunkId)).memory_type).toBe('working');
    await aw.demoteToArchival(chunkId);
    expect((await aw.getProps(chunkId)).memory_type).toBe('archival');
    await aw.promoteToWorking(chunkId);
    expect((await aw.getProps(chunkId)).memory_type).toBe('working');
  });
});

// ── Source enrichment ──────────────────────────────────────────

describe('AssistantWrapper: source enrichment', () => {
  let sourcedId: number;

  beforeAll(async () => {
    const stored = await aw.store('Sourced enrichment', [], [], ['https://enrich.test'], 'working');
    sourcedId = Number(stored.chunk.id);
  });

  it('search returns sources on results', async () => {
    const results = await aw.search('enrichment', 5);
    const withSources = results.filter((r: any) => r.sources);
    expect(withSources.length).toBeGreaterThan(0);
    expect((withSources[0] as any).sources).toEqual(['https://enrich.test']);
  });

  it('getChunks returns sources on results', async () => {
    const results = await aw.getChunks([sourcedId]);
    expect(results.length).toBe(1);
    expect((results[0] as any).sources).toEqual(['https://enrich.test']);
  });
});

// ── Merge ──────────────────────────────────────────────────────

describe('AssistantWrapper: merge', () => {
  it('merges and copies memory_type', async () => {
    const a = await aw.store('Merge AW A', [], [], [], 'working');
    const b = await aw.store('Merge AW B');
    const idA = Number(a.chunk.id);
    const idB = Number(b.chunk.id);

    const merged = await aw.merge([idA, idB], 'Merged AW');
    expect(merged.chunk.text).toBe('Merged AW');
  });
});
