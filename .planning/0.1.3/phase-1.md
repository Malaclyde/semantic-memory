# Phase 1: Extend coding-memory plugin with scope, date filters, and richer results

## Rationale

The coding-memory plugin has feature gaps identified during testing:

1. **`store_memory`** accepts no `scope` parameter, but `search_memory` can filter by scope — chunks stored without scope can never be found via scoped search.
2. **Scope filtering semantics** are unclear — the LLM needs control over whether scope filtering is strict (only matching scope) or inclusive (matching scope + un-scoped chunks).
3. **Search results** lack `created_at` and `access_count` — the LLM can't gauge freshness or popularity.
4. **No date range filtering** — the LLM can't constrain searches to recent or old knowledge.

## Scope semantics design

The `combinedSearch` filter logic:
```typescript
return f.required ? matches : matches || !hasIt;
```

| `strict_scope` | `required` | Chunks with matching scope | Chunks with no scope |
|---------------|-----------|---------------------------|---------------------|
| `true` (default) | `true` | Included | Excluded |
| `false` | `false` | Included | Included |

Default is `true` to preserve backward compatibility.

---

## Step 1 — Add `strict_scope` to `BaseWrapper.search()`

### File changed

- `src/kb/wrappers/base.ts`

### Changes

Update the `SearchOptions` interface and the `search()` method:

```typescript
export interface SearchOptions {
  filters?: { propertyName: string; value: string; required: boolean }[];
  scope?: string;
  memoryType?: string;
  strictScope?: boolean;  // NEW
}
```

```typescript
if (options?.scope) {
  const required = options.strictScope !== false; // defaults to true
  filters.push({ propertyName: 'scope', value: options.scope, required });
}
```

### Validation

```bash
npm test
# All tests must pass
```

---

## Step 2 — Add `scope` to `BaseWrapper.store()`

### File changed

- `src/kb/wrappers/base.ts`

### Changes

```typescript
export default class BaseWrapper extends DB {
  async search(
    query: string,
    limit: number,
    options?: SearchOptions
  ): Promise<CombinedSearchResult[]> {
    // ... unchanged
  }

  async store(
    text: string,
    concepts?: Concept[],
    existingConceptIds?: number[],
    sources?: string[],              // was already here in CodingWrapper
    scope?: string,                   // NEW
  ): Promise<{ chunk: dbo.Chunk; concepts: dbo.Concept[] }> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) {
      props.sources = JSON.stringify(sources);
    }
    if (scope) {
      props.scope = scope;            // NEW
    }
    const result = await this.insertChunk(
      text,
      concepts || [],
      existingConceptIds,
      Object.keys(props).length > 0 ? props : undefined
    );
    return result;
  }
}
```

### Validation

```bash
npm test
# All tests must pass
```

---

## Step 3 — Update `coding-memory/plugin.ts` — store_memory

### File changed

- `opencode/coding-memory/plugin.ts`

### Changes

Add `scope` parameter to `store_memory`:

```typescript
const store_memory = tool({
  description: "Store a new fact into knowledge base. Use scope to organize knowledge by project area (e.g. 'frontend', 'backend', 'api'). Unscoped chunks match all searches.",
  args: {
    text: tool.schema.string().describe("The fact or knowledge to store"),
    concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
    existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("Reuse existing concept IDs"),
    sources: tool.schema.array(tool.schema.string()).optional().describe("Source URLs"),
    scope: tool.schema.string().optional().describe("Project area scope (e.g. 'frontend', 'backend'). Chunks without scope are found by all searches."),
  },
  async execute(args) {
    const concepts = (args.concepts || []).map(name => ({ name }));
    const result = await memory.store(args.text, concepts, args.existingConceptIds, args.sources, args.scope);
    return { output: JSON.stringify({ chunkId: Number(result.chunk.id), conceptIds: result.concepts.map(c => Number(c.id)) }) };
  },
});
```

---

## Step 4 — Update `coding-memory/plugin.ts` — search_memory with strict_scope + date filters + richer results

### File changed

- `opencode/coding-memory/plugin.ts`

### Changes

```typescript
const search_memory = tool({
  description: "Search stored knowledge using semantic + keyword + reranker fusion. Supports scope filtering and date range limits.",
  args: {
    query: tool.schema.string().describe("The search query"),
    limit: tool.schema.number().default(5).describe("Max results"),
    scope: tool.schema.string().optional().describe("Scope filter (e.g. 'frontend', 'backend'). Requires strict_scope=true to exclude unscoped chunks."),
    strict_scope: tool.schema.boolean().optional().describe("If true, only chunks with the exact scope match. If false, also includes chunks without any scope. Default: true."),
    older_than: tool.schema.string().optional().describe("ISO 8601 date string. Only return chunks created before this date (e.g. '2026-01-01' or '2026-01-01T00:00:00')."),
    younger_than: tool.schema.string().optional().describe("ISO 8601 date string. Only return chunks created after this date."),
  },
  async execute(args) {
    const filters: { propertyName: string; value: string; required: boolean }[] = [];

    if (args.scope) {
      const required = args.strict_scope !== false;
      filters.push({ propertyName: 'scope', value: args.scope, required });
    }

    const results = await memory.search(args.query, args.limit, {
      filters: filters.length > 0 ? filters : undefined,
      olderThan: args.older_than,
      youngerThan: args.younger_than,
    });

    return { output: JSON.stringify(results.map(r => ({
      id: r.id,
      text: r.text,
      score: r.rerankerScore,
      sources: (r as any).sources,
      created_at: (r as any).created_at,
      access_count: (r as any).access_count,
    }))) };
  },
});
```

---

## Step 5 — Add date filtering to `BaseWrapper.search()` and `DB.combinedSearch()`

### Files changed

- `src/kb/wrappers/base.ts`
- `src/kb/db.ts`

### 5a. Update `SearchOptions` in `base.ts`

```typescript
export interface SearchOptions {
  filters?: { propertyName: string; value: string; required: boolean }[];
  scope?: string;
  memoryType?: string;
  strictScope?: boolean;
  olderThan?: string;     // NEW: ISO 8601
  youngerThan?: string;   // NEW: ISO 8601
}
```

Pass them through:

```typescript
async search(
  query: string,
  limit: number,
  options?: SearchOptions
): Promise<CombinedSearchResult[]> {
  // ... existing filter logic ...
  
  const results = await this.combinedSearch(
    query, limit,
    filters.length > 0 ? filters : undefined,
    options?.olderThan,
    options?.youngerThan,     // NEW
  );
  
  await this.#enrichSources(results);
  await this.#enrichDates(results);  // NEW
  return results;
}
```

### 5b. Add `#enrichDates` to `BaseWrapper`

```typescript
async #enrichDates(results: { id: number }[]): Promise<void> {
  // Batch-fetch created_at and access_count for all results
  const ids = results.map(r => r.id);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = this.db.prepare(
    `SELECT id, created_at, access_count FROM chunks WHERE id IN (${placeholders})`
  ).all(...ids) as { id: number; created_at: string; access_count: number }[];
  for (const row of rows) {
    const r = results.find(x => x.id === row.id);
    if (r) {
      (r as any).created_at = row.created_at;
      (r as any).access_count = row.access_count;
    }
  }
}
```

### 5c. Update `DB.combinedSearch()` to accept date filters

```typescript
public async combinedSearch(
  text: string,
  limit: number,
  filters?: { propertyName: string; value: string; required: boolean }[],
  olderThan?: string,     // NEW
  youngerThan?: string,   // NEW
): Promise<CombinedSearchResult[]> {
  // ... existing code ...
```

Add date filtering after the property filter step and before reranking:

```typescript
// Date filtering
if (olderThan || youngerThan) {
  let dateSql = 'SELECT id FROM chunks WHERE 1=1';
  const dateParams: any[] = [];
  if (olderThan) { dateSql += ' AND created_at < ?'; dateParams.push(olderThan); }
  if (youngerThan) { dateSql += ' AND created_at > ?'; dateParams.push(youngerThan); }
  const validIds = (this.db.prepare(dateSql).all(...dateParams) as { id: number }[])
    .map(r => r.id);
  candidates = candidates.filter(id => validIds.includes(id));
  if (candidates.length === 0) return [];
}
```

### Validation

```bash
npm test
# All tests must pass
```

---

## Step 6 — Verify `CombinedSearchResult` type includes new fields

### File changed

- `src/kb/db.ts`

The `CombinedSearchResult` interface currently extends `ChunkResult` with `distance`, `ftsRank`, `rerankerScore`. Since `created_at` and `access_count` are added dynamically via `(r as any).created_at`, they don't need to be in the interface. But for TypeScript cleanliness, we can add them as optional:

```typescript
export interface CombinedSearchResult extends ChunkResult {
  distance?: number,
  ftsRank?: number,
  rerankerScore: number,
  created_at?: string,       // NEW
  access_count?: number,     // NEW
}
```

### Validation

```bash
npx tsc --noEmit
# No errors
```

---

## Step 7 — Update `get_chunks` tool to return richer data

### File changed

- `opencode/coding-memory/plugin.ts`

Include `created_at` and `access_count` in `get_chunks` response:

```typescript
const get_chunks = tool({
  description: "Retrieve full chunk texts by their IDs, including metadata",
  args: {
    ids: tool.schema.array(tool.schema.number()).describe("Chunk IDs"),
  },
  async execute(args) {
    const results = await memory.getChunks(args.ids);
    // Enrich with dates and access counts
    const placeholders = args.ids.map(() => '?').join(',');
    const rows = memory.db.prepare(
      `SELECT id, created_at, access_count FROM chunks WHERE id IN (${placeholders})`
    ).all(...args.ids) as { id: number; created_at: string; access_count: number }[];
    return { output: JSON.stringify(results.map(r => {
      const meta = rows.find(row => row.id === r.id);
      return {
        id: r.id,
        text: r.text,
        created_at: meta?.created_at,
        access_count: meta?.access_count,
        sources: (r as any).sources,
      };
    })) };
  },
});
```

### Validation

Test in OpenCode: `get_chunks({ ids: [1] })` should return `created_at` and `access_count`.

---

## Step 8 — Final validation

```bash
# 1. Type check
npx tsc --noEmit

# 2. All tests
npm test

# 3. Copy to opencode cache
cp src/kb/db.ts <cache>/knowledge-base/src/kb/db.ts
cp src/kb/wrappers/base.ts <cache>/knowledge-base/src/kb/wrappers/base.ts
cp opencode/coding-memory/plugin.ts <cache>/coding-memory-oc/plugin.ts

# 4. Manual OpenCode test
# - store_memory with scope
# - search_memory with scope + strict_scope true/false
# - search_memory with older_than / younger_than
# - search_memory with both scope + date filters
# - get_chunks returns metadata
```

## Summary of files changed

| File | Change |
|------|--------|
| `src/kb/db.ts` | Add `created_at`, `access_count` to `CombinedSearchResult`; add date params to `combinedSearch()` |
| `src/kb/wrappers/base.ts` | Add `strictScope`, `olderThan`, `youngerThan` to `SearchOptions`; pass through to `combinedSearch`; add `scope` to `store()`; add `#enrichDates()` |
| `opencode/coding-memory/plugin.ts` | Add `scope` to `store_memory`; add `strict_scope`, `older_than`, `younger_than` to `search_memory`; enrich search results with `created_at`, `access_count`; enrich `get_chunks` with metadata |
