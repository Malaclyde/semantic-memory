# Phase 0: Migrate from sqlite-vec to USearch

## Rationale

### The Problem

The knowledge-base library uses `sqlite-vec`, a SQLite loadable extension, for vector search via `vec0` virtual tables. This requires `db.loadExtension()` which calls `sqlite3_load_extension()` under the hood. On macOS, Apple's system SQLite is compiled with `SQLITE_OMIT_LOAD_EXTENSION`, which disables extension loading entirely.

Bun's `bun:sqlite` on macOS uses Apple's system SQLite. OpenCode initializes Bun's SQLite before loading any plugins, so `Database.setCustomSQLite()` (the only way to replace Apple's SQLite with a Homebrew build) cannot be called from within a plugin — by the time our module code runs, SQLite is already loaded.

On Linux and Windows, Bun bundles its own SQLite with extension loading enabled, so sqlite-vec works. But the library must work on all platforms without platform-specific setup.

### The Solution

Replace `sqlite-vec` with **USearch** (by unum-cloud), a high-performance HNSW vector search engine. USearch uses N-API native bindings (supported by Bun) with prebuilt binaries shipped in the package — no install scripts needed, no SQLite extensions required. It works identically on macOS, Linux, Windows, and is trusted by Google, ClickHouse, DuckDB, LangChain, and opencode-mem.

### Architecture Change

```
Before (sqlite-vec):
  SQLite ── vec0 virtual table ── loadExtension() → .dylib
                                  ↑ requires Apple SQLite replacement on macOS

After (USearch):
  SQLite ── BLOB column (embedding bytes)
  USearch ── in-memory HNSW index (N-API native addon, prebuilt binaries)
             ↑ supported by Bun, no install scripts needed
```

SQLite remains the source of truth. The HNSW index is rebuilt from SQLite on startup and can be persisted to a separate file for fast reload.

---

## Step 1 — New dependencies

### Changes

- **Add** `usearch` to `dependencies` in root `package.json` (v2.21+)
- **Remove** `sqlite-vec` from `dependencies`
- Keep `better-sqlite3` (still used by the adapter on Node.js)
- Keep `@types/better-sqlite3` (still used by the adapter)

### Files changed

- `package.json`

### Validation

```bash
npm install
npm test  # must still pass (old tests use sqlite-vec — will break until Step 8)
```

---

## Step 2 — New vector index module (`src/kb/vector-index.ts`)

Create a new module that wraps **USearch** for the vector index lifecycle. This module is the replacement for `sqlite-vec`'s vec0 virtual tables.

### Interface

```typescript
export class VectorIndex {
  constructor(numDimensions: number);

  // Lifecycle
  init(maxElements?: number): Promise<void>;
  loadFromDb(db: Database): Promise<void>;     // rebuild from SQLite BLOBs
  save(path: string): Promise<void>;            // save to .usearch file
  load(path: string): Promise<void>;            // load from .usearch file

  // CRUD
  add(id: number, vector: Float32Array): Promise<void>;
  remove(id: number): Promise<void>;
  search(vector: Float32Array, k: number): Promise<{ id: number; distance: number }[]>;

  // State
  get size(): number;
}
```

### Internal details

- Creates `new usearch.Index({ dimensions, metric: 'cos', connectivity: 16, expansionAdd: 128, expansionSearch: 64 })`
- `add()` → `index.add(BigInt(id), vector)` (USearch uses BigInt keys)
- `search()` → `index.search(vector, k)` → returns `{ keys: BigUint64Array, distances: Float64Array }`
- `remove()` → `index.remove(BigInt(id))`
- `save()` → `index.save(path)` / `load()` → `index.load(path)`
- `loadFromDb()` reads `SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND outdated = 0`, parses each BLOB as `Float32Array`, and calls `index.add()`
- The index is rebuilt from SQLite on startup; SQLite remains the source of truth

### File created

- `src/kb/vector-index.ts`

### Validation

```typescript
// Quick smoke test in project root
npx tsx -e "
import { VectorIndex } from './src/kb/vector-index';
const idx = new VectorIndex(384);
await idx.init(1000);
await idx.add(1, new Float32Array(384));
const results = await idx.search(new Float32Array(384), 5);
console.log('search results:', results);
"
```

---

## Step 3 — Update SQL schema (`src/kb/sql/initialize.sql`)

### Changes

Remove `vec0` virtual tables, add `embedding` BLOB column to `chunks` and `concepts`:

```sql
-- Before
CREATE TABLE IF NOT EXISTS chunks (...);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    id INTEGER PRIMARY KEY UNIQUE NOT NULL,
    embedding float[${numDimensions}]
);

-- After
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    embedding BLOB,              -- NEW: Float32Array serialized as Uint8Array
    outdated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0
);
```

Similarly for `concepts`:

```sql
-- Before
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_concepts USING vec0(
    id INTEGER PRIMARY KEY UNIQUE NOT NULL,
    embedding float[${numDimensions}]
);

-- After
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    embedding BLOB              -- NEW
);
```

Remove `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks` and `CREATE VIRTUAL TABLE IF NOT EXISTS vec_concepts` entirely. Remove the `${numDimensions}` placeholder (it's no longer needed in SQL — it goes into the VectorIndex constructor).

### File changed

- `src/kb/sql/initialize.sql`

### Validation

```bash
# Read the init SQL and check for vec0 references
grep -c "vec0\|vec_chunks\|vec_concepts" src/kb/sql/initialize.sql
# Expected: 0
grep -c "embedding" src/kb/sql/initialize.sql
# Expected: 2 (chunks.embedding, concepts.embedding)
```

---

## Step 4 — Update `dbo.ts` types

### Changes

`Chunk` and `Concept` interfaces already have `embedding: Float32Array`. No type changes needed, but verify:

- `Chunk.embedding` is `Float32Array` ✓
- `Concept` does NOT have embedding in the interface — `editConcept()` will store embedding in the concepts table directly, not through the Concept type

### File changed

- `src/kb/dbo.ts` (verify only, likely no changes)

---

## Step 5 — Update `db.ts` — remove sqlite-vec, integrate VectorIndex

### 5a. Remove sqlite-vec import and init

```typescript
// Before
import * as sqlite from 'sqlite-vec';
// ...
try { sqlite.load(db); } catch (error) { console.error(...) }

// After
// No sqlite import. No load call.
```

### 5b. Add VectorIndex integration

```typescript
import { VectorIndex } from './vector-index';

export default class DB {
    #db: Database | undefined
    #dbPath: string
    #vectorIndex: VectorIndex      // NEW

    constructor(public embedder: Embedder, public reranker: Reranker, options?: { dbPath?: string }) {
        this.#dbPath = options?.dbPath || process.env.SEMANTIC_MEMORY_DB_PATH || './test.db';
        this.#vectorIndex = new VectorIndex(embedder.numDimensions);  // NEW
    }
```

### 5c. Init the vector index after DB init

```typescript
public get db(): Database {
    if (!this.#db) {
        this.#db = this.#init();
        // Don't block — index rebuild is async, called separately
    }
    return this.#db;
}

public async initVectorIndex(): Promise<void> {
    await this.#vectorIndex.init();
    await this.#vectorIndex.loadFromDb(this.db);
}
```

### 5d. Remove vec0 prepared statements

Remove these methods entirely:
- `#insertVecChunk()` — inserts into `vec_chunks`
- `#insertVecConcept()` — inserts into `vec_concepts`
- `#chunkVecSearch()` — SELECT from `vec_chunks`
- `#chunkVecSearchLight()` — SELECT from `vec_chunks` (light)
- `#conceptVecSearch()` — SELECT from `vec_concepts`

### 5e. Update `#insertChunkTransaction()`

Replace vec0 INSERT with embedding BLOB update:

```typescript
#insertChunkTransaction() { 
    return this.db.transaction((chunk: dbo.Chunk, concepts: { concept: dbo.Concept, embedding: string }[], existingConceptIds: number[]) => {
        chunk.id = BigInt(this.#insertChunk().run(chunk.text).lastInsertRowid);
        // Store embedding as BLOB
        this.db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
            .run(Buffer.from(chunk.embedding.buffer), chunk.id);
        // ... rest stays the same but remove #insertVecChunk
    }); 
}
```

### 5f. Update `insertChunk()` — add to vector index after SQLite write

```typescript
public async insertChunk(...) {
    const result = await this.#insertChunkTransaction()(...);
    // Add to in-memory vector index
    await this.#vectorIndex.add(Number(result.chunk.id), result.chunk.embedding);
    return result;
}
```

### 5g. Update `semanticSearch()` — use VectorIndex

```typescript
public async semanticSearch(text: string, limit: number): Promise<SemanticSearchResult[]> {
    const embedding = await this.embedder.embed(text);
    const vecResults = await this.#vectorIndex.search(embedding, limit);
    // Fetch chunks + concepts by ID
    const ids = vecResults.map(r => r.id);
    const chunks = this.getChunksByIds(ids).map(c => ({
        ...c,
        distance: vecResults.find(r => r.id === c.id)!.distance
    }));
    const concepts: dbo.Concept[][] = chunks.map(chunk => this.#conceptSearch().all(chunk.id));
    return chunks.map((chunk, idx) => ({ chunk, concepts: concepts[idx] }));
}
```

### 5h. Update `combinedSearch()` — use VectorIndex

Replace `#chunkVecSearchLight()` with `this.#vectorIndex.search()`:

```typescript
const vecResults = (await this.#vectorIndex.search(
    await this.embedder.embed(text),
    Math.max(10 * limit, FTS_SEARCH_LIMIT)
)).map(r => ({ id: r.id, distance: r.distance }));
```

### 5i. Update `conceptCombinedSearch()` — use VectorIndex

Same pattern: replace `#conceptVecSearch()` with `this.#vectorIndex.search()`.

### 5j. Update `editConcept()` — update vector index

```typescript
public async editConcept(id: number, name: string, description: string): Promise<void> {
    this.db.prepare('UPDATE concepts SET name = ?, description = ? WHERE id = ?').run(name, description, id);
    const embedding = await this.embedder.embed(this.#conceptText({ name, description }));
    this.db.prepare('UPDATE concepts SET embedding = ? WHERE id = ?').run(Buffer.from(embedding.buffer), id);
    await this.#vectorIndex.remove(id);     // remove old
    await this.#vectorIndex.add(id, embedding); // add new
}
```

### 5k. Update `setChunkOutdated()` — also remove from vector index

```typescript
public setChunkOutdated(id: number): void {
    this.db.prepare('UPDATE chunks SET outdated = 1 WHERE id = ?').run(id);
    this.#vectorIndex.remove(id);
}
```

### 5l. Remove `#snaitizeEmbeddings()` helper

No longer needed — embeddings are stored as raw BLOBs, not JSON strings in vec0 format.

### File changed

- `src/kb/db.ts`

### Validation

```bash
npm test  # tests will still fail until Step 8 updates them
```

---

## Step 6 — Update `sqlite-adapter.ts` — simplify

### Changes

- Remove the `setCustomSQLite` code (no longer needed since we don't use sqlite-vec)
- Keep the dual Bun/Node adapter (still need bun:sqlite vs better-sqlite3)
- Add `mkdirSync(dirname(path), { recursive: true })` (already done in current code)

The adapter is simpler because it no longer needs sqlite-vec compatibility.

### File changed

- `src/kb/sqlite-adapter.ts`

---

## Step 7 — Update `seed.ts`

### Changes

- Replace `sqlite-vec` import with VectorIndex integration (or remove vec-related seeding)

Since seed now just inserts chunks with embeddings as regular BLOBs, the seed script needs minimal changes — the embedding is stored in `chunks.embedding` column instead of `vec_chunks`.

### File changed

- `src/seed.ts`

### Validation

```bash
npx tsx src/seed.ts
# Must complete without sqlite-vec errors
```

---

## Step 8 — Update tests

### 8a. Update `src/kb/__tests__/db.test.ts`

- Remove assertions that check for `vec_chunks` and `vec_concepts` in `sqlite_master`
- Add assertions for `embedding` column in `chunks` and `concepts`
- Update test expectations for `semanticSearch` (uses VectorIndex now)
- Add test for `initVectorIndex()` lifecycle

### 8b. Update `src/kb/__tests__/coding-wrapper.test.ts`

- Update any sqlite-vec-related setup/teardown
- Verify `store()` + `search()` works end-to-end

### 8c. Update `src/kb/__tests__/base-wrapper.test.ts`

- Same pattern: remove vec0 assertions, verify embedding BLOB storage

### 8d. Update `src/kb/__tests__/embedder.test.ts`

- Likely no changes — embedder is independent

### 8e. Update `src/kb/__tests__/reranker.test.ts`

- Likely no changes — reranker is independent

### Files changed

- `src/kb/__tests__/db.test.ts`
- `src/kb/__tests__/coding-wrapper.test.ts`
- `src/kb/__tests__/base-wrapper.test.ts`

### Validation

```bash
npm test  # ALL must pass
```

---

## Step 9 — Update export paths in `src/index.ts`

### Changes

- Add export for `VectorIndex`: `export { VectorIndex } from './kb/vector-index';`
- Remove `VecSearchLightResult` type from exports if no longer used externally
- Export the new `embedding` column-related types if needed

### File changed

- `src/index.ts`

---

## Step 10 — Update `package.json` exports

### Changes

Ensure the new `./kb/vector-index` path is exported if consumers might import it directly:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./kb/embedder": "./src/kb/embedder.ts",
    "./kb/reranker": "./src/kb/reranker.ts",
    "./kb/db": "./src/kb/db.ts",
    "./kb/dbo": "./src/kb/dbo.ts",
    "./kb/vector-index": "./src/kb/vector-index.ts",
    "./kb/wrappers/coding": "./src/kb/wrappers/coding.ts",
    "./kb/wrappers/assistant": "./src/kb/wrappers/assistant.ts",
    "./kb/wrappers/base": "./src/kb/wrappers/base.ts"
  }
}
```

### File changed

- `package.json`

---

## Step 11 — Comprehensive README updates

### 11a. Root `README.md` — full rewrite

Changes needed:

| Section | Change |
|---------|--------|
| **Architecture diagram** | Replace `sqlite-vec` + `better-sqlite3` with `USearch` + generic `SQLite`. New diagram: `chunks (BLOB) ──┬── USearch (HNSW index)`. |
| **Quick Start** | Remove `npm install sqlite-vec`. The USearch is bundled automatically via the knowledge-base package. No separate install step. |
| **Database Schema** | Remove `vec_chunks` and `vec_concepts` entries. Add `embedding BLOB` column to `chunks` and `concepts` table descriptions. Note that vector search uses an in-memory HNSW index, not SQLite virtual tables. |
| **Prerequisites** | Remove any mention of `brew install sqlite` or macOS-specific setup. Replace with: "Works out of the box on macOS, Linux, and Windows." |
| **Installation** | Add explicit `npm install @malaclyde/knowledge-base` with example. Currently the README jumps directly to import without showing the install step. |
| **Dependencies** | Replace "better-sqlite3 + sqlite-vec + transformers" with "bun:sqlite / better-sqlite3 + USearch + transformers" |
| **Browser/Deno note** | USearch works in browsers too — add a note for browser-based usage |

Full README draft:

```markdown
# Semantic Memory

A persistent memory backend for AI agents. Stores text chunks with vector embeddings
for semantic search (via in-memory HNSW index), FTS5 for keyword search, and a
cross-encoder reranker for relevance fusion. Supports EAV metadata (scope, sources,
memory type, etc.) and chunk-to-concept relationships.

## Architecture

```
                    ┌─────────────────────────────┐
                    │      Tool Wrappers          │
                    │  (Base / Coding / Assistant) │
                    └──────────────┬──────────────┘
                                   │ extends
                    ┌──────────────┴──────────────┐
                    │          DB Class            │
                    │  insert / search / merge     │
                    │  EAV properties / concepts   │
                    └───┬──────┬──────┬────────────┘
                        │      │      │
                ┌───────┘      │      └───────────┐
                ▼              ▼                  ▼
         bun:sqlite /    USearch      @huggingface/transformers
         better-sqlite3  (WASM HNSW idx)   (embeddings + reranker)
         (SQLite + FTS5) (in-memory vec search)
```

## Installation

```bash
npm install @malaclyde/knowledge-base
```

Works on macOS, Linux, and Windows. No platform-specific setup or native
dependencies required.

## Quick Start

```typescript
import { Embedder, Reranker, CodingWrapper } from '@malaclyde/knowledge-base';

const embedder = new Embedder('Xenova/all-MiniLM-L6-v2', 384);
const reranker = new Reranker('Xenova/bge-reranker-base', 'Xenova/bge-reranker-base');
const memory = new CodingWrapper(embedder, reranker, { dbPath: './memory.db' });

// Store knowledge
await memory.store('Crawl4AI is an open-source LLM-friendly web crawler.',
  [{ name: 'Crawl4AI', description: 'Web crawler framework' }],
  [], ['https://github.com/unclecode/crawl4ai']);

// Search with semantic + keyword + reranker fusion
const results = await memory.search('web crawler', 5);
// results[0] → { id, text, rerankerScore, sources }
```

## Core Concepts

### Chunks
The fundamental unit of memory. Each chunk has:
- **Text** — the stored content
- **Embedding** — Float32Array vector stored as BLOB, indexed in-memory via HNSW
- **created_at**, **access_count**, **outdated** — metadata columns

### Concepts
Named entities linked to multiple chunks via edges table. Searchable via FTS5.

### EAV Properties
Flexible metadata via `properties` + `chunk_properties` tables. Common properties:
`scope`, `sources`, `memory_type`.

## API Reference

[table of methods — same as current]

## Database Schema

- **chunks** — text + `embedding BLOB` + metadata
- **concepts** — name/description + `embedding BLOB`
- **edges** — many-to-many chunk↔concept links
- **properties** — EAV property name registry
- **chunk_properties** — EAV values linked to chunks
- **chunks_fts** — FTS5 on chunk text
- **concepts_fts** — FTS5 on concept name + description

Vector search is performed in-memory via USearch (HNSW algorithm), not via
SQLite virtual tables. The HNSW index is built from the `embedding` BLOB columns
on startup.

## Vector Index Lifecycle

The HNSW index is managed automatically by the `DB` class:

- **On write**: embeddings are stored as BLOBs in SQLite AND added to the HNSW index
- **On search**: the HNSW index returns candidate IDs, full text is fetched from SQLite
- **On startup**: `initVectorIndex()` rebuilds the HNSW index from SQLite data
- **On outdated**: entries are removed from the HNSW index

For advanced usage, the `VectorIndex` class can be used directly:

```typescript
import { VectorIndex } from '@malaclyde/knowledge-base/kb/vector-index';
const idx = new VectorIndex(384);
await idx.init();
await idx.loadFromDb(sqliteDb);
const results = await idx.search(queryVector, 10);
```

## OpenCode Plugins

[same as current, but remove macOS setup notes]

## Testing

```bash
npm test                # Run all tests
npm run seed            # Populate test DB with sample data
```

## License

MIT
```

### 11b. Plugin READMEs — update

Both `opencode/coding-memory/README.md` and `opencode/assistant-memory/README.md`:

| Section | Change |
|---------|--------|
| **Prerequisites** | Remove `brew install sqlite`, remove macOS-specific notes. Replace with: "Works on all platforms." |
| **Dependencies** | Replace `sqlite-vec` with `USearch` (transitive, no user action needed) |
| **Architecture** | Update to reference WASM-based vector search instead of sqlite-vec |

### Files changed

- `README.md` (root)
- `opencode/coding-memory/README.md`
- `opencode/assistant-memory/README.md`

---

## Step 12 — Bump version to 0.1.0

Update version in:
- `package.json` (root): `0.0.7` → `0.1.0`
- `opencode/coding-memory/package.json`: `0.0.6` → `0.1.0`
- `opencode/assistant-memory/package.json`: `0.0.6` → `0.1.0`

### Files changed

- `package.json`
- `opencode/coding-memory/package.json`
- `opencode/assistant-memory/package.json`

---

## Migration Path for Existing Databases

Existing databases created with sqlite-vec have `vec_chunks` and `vec_concepts` virtual tables. These are NOT compatible with the new schema. The migration strategy:

1. **Fresh start**: Existing `.db` files will fail the `CREATE TABLE IF NOT EXISTS` (which is fine — regular tables will be kept, embedding column will be missing). The `initVectorIndex()` method reads embeddings from the `embedding` column — if it's missing, the vector index will be empty but functional.

2. **Recommended**: Delete old `.db` files and re-seed. Equivalent to a clean install.

3. **Data migration script** (optional, low priority): A one-time script that reads from `vec_chunks` and copies embeddings to `chunks.embedding`. Can be added later if needed.

---

## Full Validation Sequence

```bash
# 1. Install new deps
npm install

# 2. TypeScript compiles cleanly
npx tsc --noEmit

# 3. All tests pass
npm test

# 4. Seed script runs
npm run seed

# 5. Manual smoke test
npx tsx -e "
import DB from './src/kb/db';
import Embedder from './src/kb/embedder';
import Reranker from './src/kb/reranker';

const e = new Embedder('Xenova/all-MiniLM-L6-v2', 384);
const r = new Reranker('Xenova/bge-reranker-base', 'Xenova/bge-reranker-base');
const db = new DB(e, r, { dbPath: ':memory:' });
db.db; // trigger init
await db.initVectorIndex();

const result = await db.insertChunk('Hello world', [{ name: 'greeting' }]);
console.log('Inserted:', result.chunk.id);

const search = await db.semanticSearch('hello', 5);
console.log('Found:', search.length, 'results');
"

# 6. Plugin smoke test (copy to opencode cache, restart opencode, test store_memory)
```

## Summary of Files Changed

| File | Change |
|------|--------|
| `package.json` | Add usearch, remove sqlite-vec, bump to 0.1.0 |
| `src/kb/vector-index.ts` | **NEW** — USearch wrapper |
| `src/kb/sql/initialize.sql` | Remove vec0, add embedding BLOB column |
| `src/kb/db.ts` | Remove sqlite-vec, integrate VectorIndex |
| `src/kb/sqlite-adapter.ts` | Simplify (no setCustomSQLite) |
| `src/kb/dbo.ts` | Verify types (likely no change) |
| `src/seed.ts` | Adapt to new schema |
| `src/index.ts` | Export VectorIndex, update types |
| `src/kb/__tests__/db.test.ts` | Remove vec0 assertions, add embedding tests |
| `src/kb/__tests__/coding-wrapper.test.ts` | Update for new schema |
| `src/kb/__tests__/base-wrapper.test.ts` | Update for new schema |
| `opencode/coding-memory/package.json` | Bump to 0.1.0 |
| `opencode/assistant-memory/package.json` | Bump to 0.1.0 |
| README files | Remove macOS setup, document USearch approach |
