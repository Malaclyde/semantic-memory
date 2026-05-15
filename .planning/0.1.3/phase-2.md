# Phase 2: Shadow retrieval operations (most recent, most accessed, most important)

## Rationale

The library needs internal retrieval operations for compaction mechanisms and agent spawning that do NOT increment the `access_count` counter (shadow operations). Three functions:

1. **`getRecentChunks(X)`** — X most recent chunks by `created_at DESC`
2. **`getMostAccessedChunks(X)`** — X most accessed chunks by `access_count DESC`
3. **`getImportantChunks(X)`** — hybrid: X most recent re-ranked by access, filled with most-accessed-not-already-returned

These are NOT exported as plugin tools — they are internal DB methods for use by compaction/agent-spawning harness code.

---

## Design

### Shadow operation invariant

All three methods MUST NOT call `#incrementAccessCounts`. They are "read-only" from the counter's perspective.

### Outdated exclusion

All queries filter `outdated = 0`, consistent with all other retrieval methods.

### X validation

X must be a positive integer (>0). If validation fails, throw an `Error` (consistent with codebase patterns like `setChunkProperties`).

### Return type

New interface in `src/kb/db.ts`:

```typescript
export interface ShadowChunkResult {
  id: number;
  text: string;
  properties: { name: string; value: string }[];
  concepts: { id: number; name: string; description: string }[];
}
```

- `id`: chunk ID
- `text`: full chunk text (not clipped)
- `properties`: array of all EAV properties for the chunk (name-value pairs)
- `concepts`: array of linked concepts, with `description` clipped to 100 characters

### Where to implement

All three methods go directly on the `DB` class in `src/kb/db.ts`. They are automatically inherited by `BaseWrapper`, `CodingWrapper`, and `AssistantWrapper` since all extend `DB`. They are NOT added to plugin files.

---

## Step 1 — Add `ShadowChunkResult` interface to `src/kb/db.ts`

### Location

After the `ConceptSearchResult` interface (around line 57), before the class definition.

### New code

```typescript
export interface ShadowChunkResult {
  id: number;
  text: string;
  properties: { name: string; value: string }[];
  concepts: { id: number; name: string; description: string }[];
}
```

### Verification

```bash
npx tsc --noEmit
# No errors
```

---

## Step 2 — Add `#assembleShadowResults` helper to `DB` class

A private batch helper that takes chunk plain rows and enriches them with properties and concepts in bulk queries.

### Location

After `#incrementAccessCounts` (around line 162), before the constructor.

### Implementation

```typescript
#assembleShadowResults(rows: { id: number; text: string }[]): ShadowChunkResult[] {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  // Batch fetch properties
  const propRows = this.db.prepare(`
    SELECT cp.chunk_id, p.name, cp.value
    FROM chunk_properties cp
    JOIN properties p ON cp.property_id = p.id
    WHERE cp.chunk_id IN (${placeholders})
  `).all(...ids) as { chunk_id: number; name: string; value: string }[];

  // Batch fetch concepts (description clipped to 100 chars)
  const conceptRows = this.db.prepare(`
    SELECT e.chunk_id, c.id, c.name, substr(c.description, 1, 100) as description
    FROM edges e
    JOIN concepts c ON e.concept_id = c.id
    WHERE e.chunk_id IN (${placeholders})
  `).all(...ids) as { chunk_id: number; id: number; name: string; description: string }[];

  // Group properties by chunk_id
  const propsByChunk = new Map<number, { name: string; value: string }[]>();
  for (const row of propRows) {
    if (!propsByChunk.has(row.chunk_id)) propsByChunk.set(row.chunk_id, []);
    propsByChunk.get(row.chunk_id)!.push({ name: row.name, value: row.value });
  }

  // Group concepts by chunk_id
  const conceptsByChunk = new Map<number, { id: number; name: string; description: string }[]>();
  for (const row of conceptRows) {
    if (!conceptsByChunk.has(row.chunk_id)) conceptsByChunk.set(row.chunk_id, []);
    conceptsByChunk.get(row.chunk_id)!.push({
      id: row.id,
      name: row.name,
      description: row.description || ''
    });
  }

  return rows.map(r => ({
    id: r.id,
    text: r.text,
    properties: propsByChunk.get(r.id) || [],
    concepts: conceptsByChunk.get(r.id) || [],
  }));
}
```

### Verification

```bash
npx tsc --noEmit
# No errors
```

---

## Step 3 — Add `getRecentChunks(X)` method

### Location

After the `mergeChunks` method (around line 517), before the closing brace of the class.

### Implementation

```typescript
public getRecentChunks(x: number): ShadowChunkResult[] {
  if (!Number.isInteger(x) || x < 1) {
    throw new Error('X must be a positive integer');
  }
  const rows = this.db.prepare(`
    SELECT id, text FROM chunks WHERE outdated = 0 ORDER BY created_at DESC LIMIT ?
  `).all(x) as { id: number; text: string }[];
  return this.#assembleShadowResults(rows);
}
```

### SQL logic

- `SELECT id, text FROM chunks WHERE outdated = 0 ORDER BY created_at DESC LIMIT X`
- Returns X most recent non-outdated chunks
- No `#incrementAccessCounts` call (shadow operation)

### Verification

```bash
npx tsc --noEmit
# No errors
```

---

## Step 4 — Add `getMostAccessedChunks(X)` method

### Location

After `getRecentChunks`.

### Implementation

```typescript
public getMostAccessedChunks(x: number): ShadowChunkResult[] {
  if (!Number.isInteger(x) || x < 1) {
    throw new Error('X must be a positive integer');
  }
  const rows = this.db.prepare(`
    SELECT id, text FROM chunks WHERE outdated = 0 ORDER BY access_count DESC LIMIT ?
  `).all(x) as { id: number; text: string }[];
  return this.#assembleShadowResults(rows);
}
```

### SQL logic

- `SELECT id, text FROM chunks WHERE outdated = 0 ORDER BY access_count DESC LIMIT X`
- Returns X most accessed non-outdated chunks
- No `#incrementAccessCounts` call

### Verification

```bash
npx tsc --noEmit
# No errors
```

---

## Step 5 — Add `getImportantChunks(X)` method

### Location

After `getMostAccessedChunks`.

### Algorithm

1. Select X most recent chunks → re-order by `access_count DESC` → take top `ceil(X/2)` → this is "step 1 set"
2. Select `X - ceil(X/2)` most accessed chunks NOT already in step 1 set → this is "step 2 set"
3. Return combined array: [step1 ...step2]

### SQL implementation using CTEs

```typescript
public getImportantChunks(x: number): ShadowChunkResult[] {
  if (!Number.isInteger(x) || x < 1) {
    throw new Error('X must be a positive integer');
  }
  const step1Limit = Math.ceil(x / 2);
  const step2Limit = x - step1Limit;

  const ids = this.db.prepare(`
    WITH recent AS (
      SELECT id, access_count, created_at
      FROM chunks
      WHERE outdated = 0
      ORDER BY created_at DESC
      LIMIT ?
    ),
    step1 AS (
      SELECT id FROM recent
      ORDER BY access_count DESC
      LIMIT ?
    ),
    step2 AS (
      SELECT id FROM chunks
      WHERE outdated = 0
        AND id NOT IN (SELECT id FROM step1)
      ORDER BY access_count DESC
      LIMIT ?
    )
    SELECT id FROM step1
    UNION ALL
    SELECT id FROM step2
  `).all(x, step1Limit, step2Limit) as { id: number }[];

  const chunkIds = ids.map(r => r.id);
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = this.db.prepare(`
    SELECT id, text FROM chunks WHERE id IN (${placeholders})
  `).all(...chunkIds) as { id: number; text: string }[];

  // Preserve order from CTE query
  const idOrder = new Map(chunkIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

  return this.#assembleShadowResults(rows);
}
```

### SQL logic breakdown

The CTE:
1. `recent`: gets X most recent chunks IDs (by `created_at DESC`)
2. `step1`: from `recent`, re-orders by `access_count DESC`, takes top `ceil(X/2)` IDs
3. `step2`: from ALL chunks, gets most accessed NOT in step1, takes `X - ceil(X/2)` IDs
4. Final SELECT: UNION ALL of step1 IDs (in access_count order) then step2 IDs (in access_count order)

After the CTE, we fetch the full rows by ID and preserve the CTE order.

### Edge cases handled

- **DB has fewer than X chunks**: `recent` returns fewer rows, `step1` takes what it can, `step2` may find all remaining IDs already in `step1` — returns all available chunks
- **step2Limit = 0**: when X=1 (ceil(1/2)=1, step2Limit=0), step2 query with LIMIT 0 returns nothing — correct
- **All most accessed are also most recent**: step1 takes the top from recent, step2 gets the next tier — guaranteed at least ceil(X/2) recent chunks are included
- **Outdated chunks**: excluded by `outdated = 0` in all CTEs

### Verification

```bash
npx tsc --noEmit
# No errors
```

---

## Step 6 — Export `ShadowChunkResult` from `src/index.ts`

### Location

Update the type export line.

### Change

```typescript
// Before
export type { Concept, ChunkSearchResult, SemanticSearchResult, KeywordSearchResult, VecSearchLightResult, ChunkResult, CombinedSearchResult, ConceptSearchResult } from './kb/db';

// After
export type { Concept, ChunkSearchResult, SemanticSearchResult, KeywordSearchResult, VecSearchLightResult, ChunkResult, CombinedSearchResult, ConceptSearchResult, ShadowChunkResult } from './kb/db';
```

### Verification

```bash
npx tsc --noEmit
# No errors
```

---

## Step 7 — Add tests to `src/kb/__tests__/db.test.ts`

### 7a. Import the new type at the top

Add `ShadowChunkResult` to the import if needed, though we typically just check shapes.

### 7b. Test section: "DB: Shadow Operations (no access_count increment)"

Add a new `describe` block after the existing `access_count` tests (after line 357):

```typescript
// ── Shadow Operations ──────────────────────────────────────────

describe('DB: Shadow Operations', () => {
  it('getRecentChunks returns X most recent, newest first', () => {
    const results = db.getRecentChunks(3);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    // Verify order: newest first
    for (let i = 1; i < results.length; i++) {
      const prev = (db.db.prepare('SELECT created_at FROM chunks WHERE id = ?').get(results[i - 1].id) as any).created_at;
      const curr = (db.db.prepare('SELECT created_at FROM chunks WHERE id = ?').get(results[i].id) as any).created_at;
      expect(new Date(prev).getTime()).toBeGreaterThanOrEqual(new Date(curr).getTime());
    }
  });

  it('getRecentChunks returns all chunks when fewer than X', () => {
    const total = (db.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE outdated = 0').get() as any).count;
    const results = db.getRecentChunks(total + 100);
    expect(results.length).toBe(total);
  });

  it('getRecentChunks throws on invalid X', () => {
    expect(() => db.getRecentChunks(0)).toThrow();
    expect(() => db.getRecentChunks(-1)).toThrow();
    expect(() => db.getRecentChunks(1.5)).toThrow();
  });

  it('getMostAccessedChunks returns X most accessed', () => {
    // Get access counts before
    const results = db.getMostAccessedChunks(3);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    // Verify order: most accessed first
    for (let i = 1; i < results.length; i++) {
      const prev = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(results[i - 1].id) as any).access_count;
      const curr = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(results[i].id) as any).access_count;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('getMostAccessedChunks returns all when fewer than X', () => {
    const total = (db.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE outdated = 0').get() as any).count;
    const results = db.getMostAccessedChunks(total + 100);
    expect(results.length).toBe(total);
  });

  it('getMostAccessedChunks throws on invalid X', () => {
    expect(() => db.getMostAccessedChunks(0)).toThrow();
    expect(() => db.getMostAccessedChunks(-5)).toThrow();
  });

  it('getImportantChunks combines recent + accessed', () => {
    const results = db.getImportantChunks(4);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(4);
    // Each result has the expected shape
    for (const r of results) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('text');
      expect(Array.isArray(r.properties)).toBe(true);
      expect(Array.isArray(r.concepts)).toBe(true);
    }
  });

  it('getImportantChunks ensures at least ceil(X/2) recent', () => {
    // With X=5, ceil(5/2)=3, so at least 3 recent should be included
    const results = db.getImportantChunks(5);
    if (results.length >= 3) {
      // Check that at least 3 results are from the set of most recent chunks
      const recentIds = db.getRecentChunks(5).map(r => r.id);
      const overlap = results.filter(r => recentIds.includes(r.id));
      expect(overlap.length).toBeGreaterThanOrEqual(Math.min(3, results.length));
    }
  });

  it('getImportantChunks does NOT increment access_count', () => {
    const chunkId = 1;
    const before = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(chunkId) as any).access_count;

    // Run all three shadow operations
    db.getRecentChunks(5);
    db.getMostAccessedChunks(5);
    db.getImportantChunks(5);

    const after = (db.db.prepare('SELECT access_count FROM chunks WHERE id = ?').get(chunkId) as any).access_count;
    expect(after).toBe(before);
  });

  it('getImportantChunks returns all chunks when fewer than X', () => {
    const total = (db.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE outdated = 0').get() as any).count;
    const results = db.getImportantChunks(total + 100);
    expect(results.length).toBe(total);
  });

  it('getImportantChunks throws on invalid X', () => {
    expect(() => db.getImportantChunks(0)).toThrow();
    expect(() => db.getImportantChunks(-1)).toThrow();
    expect(() => db.getImportantChunks(2.7)).toThrow();
  });

  it('shadow methods return properties and concepts', async () => {
    // Insert a chunk with properties and concepts for this test
    const stored = await db.insertChunk('Shadow test with metadata', [
      { name: 'shadow-concept', description: 'A' .repeat(200) }  // long description to test clipping
    ], undefined, { scope: 'test', color: 'blue' });
    const id = Number(stored.chunk.id);

    const results = db.getRecentChunks(100);
    const match = results.find(r => r.id === id);
    expect(match).toBeDefined();
    expect(match!.properties.length).toBeGreaterThanOrEqual(2);
    expect(match!.properties.some(p => p.name === 'scope' && p.value === 'test')).toBe(true);
    expect(match!.properties.some(p => p.name === 'color' && p.value === 'blue')).toBe(true);
    expect(match!.concepts.length).toBe(1);
    expect(match!.concepts[0].name).toBe('shadow-concept');
    expect(match!.concepts[0].description.length).toBeLessThanOrEqual(100);
  });
});
```

### Verification

```bash
npm test
# All 11+ new tests must pass (plus existing ones)
```

---

## Step 8 — Final validation

```bash
# 1. Type check
npx tsc --noEmit

# 2. All tests
npm test

# 3. Manual smoke test
npx tsx -e "
import DB from './src/kb/db';
import Embedder from './src/kb/embedder';
import Reranker from './src/kb/reranker';

const e = new Embedder('Xenova/all-MiniLM-L6-v2', 384);
const r = new Reranker('Xenova/bge-reranker-base', 'Xenova/bge-reranker-base');
const db = new DB(e, r, { dbPath: ':memory:' });
db.db;
await db.initVectorIndex();

// Insert some test data
await db.insertChunk('First chunk', [{ name: 'concept-a' }], undefined, { scope: 'a' });
await db.insertChunk('Second chunk', [{ name: 'concept-b' }], undefined, { scope: 'b' });
await db.insertChunk('Third chunk');

// Test shadow operations
const recent = db.getRecentChunks(2);
console.log('Recent:', recent.length, 'chunks');
console.log('Recent[0] props:', recent[0].properties);
console.log('Recent[0] concepts:', recent[0].concepts);

const accessed = db.getMostAccessedChunks(2);
console.log('Most accessed:', accessed.length, 'chunks');

const important = db.getImportantChunks(3);
console.log('Important:', important.length, 'chunks');

// Verify no access_count increment
const row = db.db.prepare('SELECT access_count FROM chunks WHERE id = 1').get() as any;
console.log('Access count (should be 0):', row.access_count);

console.log('All smoke tests passed!');
"
```

---

## Summary of files changed

| File | Change |
|------|--------|
| `src/kb/db.ts` | Add `ShadowChunkResult` interface; add `#assembleShadowResults` helper; add `getRecentChunks`, `getMostAccessedChunks`, `getImportantChunks` methods |
| `src/index.ts` | Export `ShadowChunkResult` type |
| `src/kb/__tests__/db.test.ts` | Add test suite for shadow operations (11+ tests) |
