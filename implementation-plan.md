# Implementation Plan — COMPLETED

All items implemented and tested step-by-step. See `src/kb/db.ts`, `src/kb/reranker.ts`, `src/kb/sql/initialize.sql`, `src/seed.ts`.

## Part 1: Fix `combinedSearch` in `src/kb/db.ts`

### ✅ 1. Fix `KeywordSearchResult` interface
- `rowid: BigInt` → `rowid: number`
- Added `rank: number`
- `text: string` populated by JOIN

### ✅ 2. Fix `#ftsSearch()` SQL
- JOIN chunks → returns `c.id, c.text, f.rank`

### ✅ 3. Add `#chunkVecSearchLight()`
- Returns `(id, distance)` with `JOIN chunks WHERE outdated=0`

### ✅ 4. Add `#getChunk()` private method
- Dynamic IN clause, filters `outdated=0`

### ✅ 5. Rewrite `combinedSearch()`
- Light vector query + FTS → RRF → reranker → sorted by score

### ✅ 6. Fix `Reranker.rank()` output
- Returns sigmoid of single logit → `Promise<number>`

### ✅ 7. New `CombinedSearchResult` interface
- `id, text, distance?, ftsRank?, rerankerScore`

### ✅ 8. Dead code removed

### ✅ 9. FTS sync triggers
- Added `chunks_ad` (delete), `chunks_au` (update)

---

## Part 2: Concept dedup/search infrastructure ✅

### Schema additions
- `vec_concepts` (vec0 for concept embeddings)
- `concepts_fts(name, description)` (FTS5)
- FTS sync triggers for concepts (ai, ad, au)

### DB class additions
- `#insertVecConcept()`, `#conceptVecSearch()`, `#conceptFtsSearch()`, `#conceptFtsNameSearch()`
- `conceptCombinedSearch(name, description)` — name FTS first, fall back to RRF+reranker
- `#getConceptChunks()` — returns non-outdated chunks for a concept
- `#getConceptsByIds()` — batch fetch concepts
- `#conceptText()` — concatenates name + description for embedding

### insertChunk changes
- Accepts `existingConceptIds?: number[]` parameter
- Embeds concept text and inserts into `vec_concepts` during transaction
- `#insertEdge()` → `INSERT OR IGNORE`

### Seed script (`src/seed.ts`)
- 75 chunks from Crawl4AI docs with 82 concepts
- Uses `conceptCombinedSearch` to find existing concepts (threshold 0.85)
- Creates only new concepts, reuses existing

---

## Part 3: Outdated chunks (soft-delete) ✅

### Schema
- `outdated INTEGER NOT NULL DEFAULT 0` on `chunks` table

### Filtering
- All queries: `#chunkVecSearch`, `#chunkVecSearchLight`, `#ftsSearch`, `#getChunk`, `#getConceptChunks`

### Method
- `setChunkOutdated(id)` — sets flag

---

## Part 4: Edit concept ✅

### `editConcept(id, name, description)`
- Updates `concepts` table (FTS triggers sync `concepts_fts`)
- DELETEs old vec0 entry + INSERTs new embedding
- Embedding uses `name + " " + description`

---

### Open design decisions (resolved)
1. **Threshold**: 0.85 reranker score for concept match
2. **Concept search reranker**: Yes, same RRF+reranker pipeline
3. **description: undefined**: Treated as empty string everywhere
