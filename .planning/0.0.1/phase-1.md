# Implementation Plan

---

## Part 1 — Schema changes (`src/kb/sql/initialize.sql`)

### Changes to `chunks` table

Add native columns for universal chunk metadata:

```sql
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    outdated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0
);
```

- `created_at` — auto-set by SQLite on INSERT, never modified after
- `access_count` — incremented atomically by retrieval methods (not EAV)

### New EAV tables

```sql
-- Property name registry
CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- Chunk → property → value
CREATE TABLE IF NOT EXISTS chunk_properties (
    chunk_id INTEGER NOT NULL,
    property_id INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (chunk_id, property_id),
    FOREIGN KEY (chunk_id) REFERENCES chunks(id),
    FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE INDEX IF NOT EXISTS idx_cp_lookup ON chunk_properties(property_id, value);
```

### Validation

1. `npx tsx src/seed.ts` — must create DB without errors
2. Check schema with `sqlite3 test.db ".schema"` — must show `chunks` with `created_at` and `access_count`, plus `properties` and `chunk_properties` tables

---

## Part 2 — Core DB methods (`src/kb/db.ts`)

### 2A — Section C: Batch retrieval methods

All three are building blocks for tool wrappers. They fetch data by ID without any property filtering.

#### `getChunksByIds(ids)` — NEW

```typescript
public getChunksByIds(ids: number[]): ChunkResult[]
```

- Returns matching non-outdated chunks with full text
- Empty array → return `[]`
- Increments `access_count` for all returned chunks

```sql
SELECT id, text FROM chunks WHERE id IN (?,?,...) AND outdated = 0
```

#### `getConceptChunks(conceptId, maxLen?)` — make public

```typescript
public getConceptChunks(conceptId: number, maxLen?: number): { id: number; text: string }[]
```

- Remove `#` prefix, add `maxLen` param (default 100)
- Returns linked non-outdated chunks, text truncated to `maxLen`
- Increments `access_count` for all returned chunks

```sql
SELECT c.id, substr(c.text, 1, ?) as text
FROM edges e
JOIN chunks c ON e.chunk_id = c.id
WHERE e.concept_id = ? AND c.outdated = 0
```

#### `getConceptsByIds(ids)` — make public

```typescript
public getConceptsByIds(ids: number[]): dbo.Concept[]
```

- Remove `#` prefix
- Returns matching concepts (no outdated filter — concepts don't have it)
- No access_count increment (concepts don't have it)

```sql
SELECT id, name, description FROM concepts WHERE id IN (?,?,...)
```

#### Access count increment helper

```typescript
#incrementAccessCounts(ids: number[]): void
```

- Called internally by `getChunksByIds`, `getConceptChunks`, `combinedSearch`
- Single atomic UPDATE:

```sql
UPDATE chunks SET access_count = access_count + 1 WHERE id IN (?,?,...)
```

- No-op if `ids` is empty

#### Validation (C)

1. Insert a chunk, call `getChunksByIds([id])` → returns it with full text
2. Same chunk, call again → `access_count` incremented by 1
3. Mark chunk outdated, call `getChunksByIds([id])` → returns `[]`
4. Insert chunk + concept, call `getConceptChunks(conceptId)` → returns ≤100 chars
5. Call with `maxLen=200` → returns ≤200 chars
6. Outdated chunk linked to concept → excluded from `getConceptChunks`
7. `getConceptsByIds([id])` → returns concept with name/description
8. Empty arrays → all three return `[]`

---

### 2B — Section D: EAV property methods

#### `#upsertProperty(name)` — private helper

```typescript
#upsertProperty(name: string): number
```

- Returns property ID for a name, creating it if missing

```sql
INSERT OR IGNORE INTO properties(name) VALUES (?);
SELECT id FROM properties WHERE name = ?;
```

#### `setChunkProperties(chunkId, props)` — public

```typescript
public setChunkProperties(chunkId: number, props: Record<string, string>): void
```

- For each `{name: value}` entry: upsert property name, then upsert into `chunk_properties`
- Overwrites existing values for the same property (INSERT OR REPLACE)
- Does NOT filter by outdated status (properties readable on any chunk)
- Empty `props` → no-op
- FK constraint fails if chunk doesn't exist (caller's responsibility)

```sql
INSERT OR REPLACE INTO chunk_properties(chunk_id, property_id, value) VALUES (?, ?, ?);
```

#### `getChunkProperties(chunkId)` — public

```typescript
public getChunkProperties(chunkId: number): Record<string, string>
```

- Returns all properties as `{name: value}` map
- Empty object if chunk has no properties

```sql
SELECT p.name, cp.value
FROM chunk_properties cp
JOIN properties p ON cp.property_id = p.id
WHERE cp.chunk_id = ?
```

#### `deleteChunkProperty(chunkId, propertyName)` — public

```typescript
public deleteChunkProperty(chunkId: number, propertyName: string): void
```

- Removes a single property from a chunk
- No-op if property doesn't exist on that chunk

```sql
DELETE FROM chunk_properties
WHERE chunk_id = ? AND property_id = (SELECT id FROM properties WHERE name = ?)
```

#### `getChunksByProperty(propertyName, value)` — public

```typescript
public getChunksByProperty(propertyName: string, value: string): ChunkResult[]
```

- Returns non-outdated chunks with matching property value
- Uses `idx_cp_lookup` index

```sql
SELECT c.id, c.text
FROM chunks c
JOIN chunk_properties cp ON cp.chunk_id = c.id
JOIN properties p ON cp.property_id = p.id
WHERE p.name = ? AND cp.value = ? AND c.outdated = 0
```

#### `insertChunk` — extend with properties parameter

```typescript
public insertChunk(
  chunk: string,
  concepts?: Concept[],
  existingConceptIds?: number[],
  properties?: Record<string, string>
): Promise<{chunk: dbo.Chunk, concepts: dbo.Concept[]}>
```

- Properties are applied after the transaction completes (chunk must exist for FK)
- `created_at` and `access_count` are handled by native columns — never passed as EAV properties

---

#### `combinedSearch` — add filters parameter

```typescript
public async combinedSearch(
  text: string,
  limit: number,
  filters?: { propertyName: string; value: string; required: boolean }[]
): Promise<CombinedSearchResult[]>
```

**No filters provided** — behaves exactly as before (RRF + reranker, no property filtering).

**Filters provided** — applied after RRF candidate selection, before reranking, on the ~60 candidates:

```typescript
// 1. Batch fetch all properties for all candidate chunks
const candidateIds = candidates.map(([id]) => id);
const propsMap = new Map<number, Record<string, string>>();

const rows = this.db.prepare(`
    SELECT cp.chunk_id, p.name, cp.value
    FROM chunk_properties cp
    JOIN properties p ON cp.property_id = p.id
    WHERE cp.chunk_id IN (${placeholders})
`).all(...candidateIds) as { chunk_id: number; name: string; value: string }[];

for (const row of rows) {
    if (!propsMap.has(row.chunk_id)) propsMap.set(row.chunk_id, {});
    propsMap.get(row.chunk_id)![row.name] = row.value;
}

// 2. Filter candidates
const filtered = candidates.filter(([id]) => {
    const props = propsMap.get(id) || {};
    return filters!.every(f => {
        const hasIt = f.propertyName in props;
        const matches = hasIt && props[f.propertyName] === f.value;
        return f.required ? matches : matches || !hasIt;
    });
});
```

**Filter semantics:**
- `required: true` — chunk must have the property with the exact value
- `required: false` — chunk either has the property with the value, OR doesn't have the property at all
- If all candidates filtered out → return `[]`
- `incrementAccessCounts` is called for the *final* (post-filter) set of returned chunks

---

#### `mergeChunks(sourceIds, targetText, targetConcepts?)` — NEW

```typescript
public mergeChunks(
  sourceIds: number[],
  targetText: string,
  targetConcepts?: Concept[]
): { chunk: ChunkResult; concepts: dbo.Concept[] }
```

Merges multiple chunks into one. Useful for memory consolidation.

**Behavior:**
1. Calls `insertChunk(targetText, targetConcepts)` to create the new merged chunk
2. Copies all properties from the first source chunk to the new chunk (including `sources`, `memory_type`, `scope`, etc.)
3. Marks all source chunks as outdated via `setChunkOutdated`
4. Returns the new chunk + concepts

**Note:** `access_count` of the new chunk starts at 0 (freshly inserted). `created_at` is the merge time, not the original creation time — this is intentional (the merge is a new artifact).

**Edge cases:**
- Empty `sourceIds` → just inserts a new chunk with no sources
- Single `sourceId` → duplicates the chunk under a new ID (valid for "refreshing" outdated content)
- Source chunks already outdated → still works (no-op on `setChunkOutdated`)

---

## Part 3 — Tool wrappers (`src/kb/wrappers/`)

### Design

Three layers, each extending the previous:

```
DB (base class, knows nothing about semantics)
  └─ BaseWrapper (adds access_count auto-increment, result enrichment)
       ├─ CodingWrapper (adds scope + sources)
       └─ AssistantWrapper (adds scope + sources, memory_type)
```

Wrappers translate agent-facing tool calls into DB operations. They inject automatic metadata, enrich results with sources, and validate parameters.

### Files to create

- `src/kb/wrappers/base.ts`
- `src/kb/wrappers/coding.ts`
- `src/kb/wrappers/assistant.ts`

No changes to `db.ts` beyond what's already specified in Part 2.

---

### `BaseWrapper` (`wrappers/base.ts`)

Extends `DB`. Provides the safe core API that all agent types share.

#### Exposed methods

| Agent tool | Maps to DB | Notes |
|-----------|-----------|-------|
| `search(query, limit, filters?)` | `combinedSearch(query, limit, filters)` | Access count auto-incremented by DB internally |
| `store(text, concepts?, existingConceptIds?)` | `insertChunk(text, concepts, existingConceptIds)` | No properties needed — `created_at` and `access_count` are native columns |
| `getChunks(ids)` | `getChunksByIds(ids)` | Access count auto-incremented by DB internally |
| `getPreviews(conceptId, maxLen?)` | `getConceptChunks(conceptId, maxLen)` | Access count auto-incremented by DB internally |
| `findConcept(name, desc?)` | `conceptCombinedSearch(name, desc)` | |
| `setOutdated(id)` | `setChunkOutdated(id)` | |
| `editConcept(id, name, desc)` | `editConcept(id, name, desc)` | |
| `setProps(id, props)` | `setChunkProperties(id, props)` | |
| `getProps(id)` | `getChunkProperties(id)` | |
| `delProp(id, name)` | `deleteChunkProperty(id, name)` | |

No override of `search()` or `getChunks()` needed — `access_count` auto-increment is handled inside the DB class's `combinedSearch` and `getChunksByIds`.

---

### `CodingWrapper` (`wrappers/coding.ts`)

Extends `BaseWrapper`. Adds scope filtering and source tracking.

#### `search(query, limit, scope?)`

```typescript
async search(query: string, limit: number, scope?: string): Promise<CombinedSearchResult[]> {
    const filters: { propertyName: string; value: string; required: boolean }[] = [];
    if (scope) {
        filters.push({ propertyName: 'scope', value: scope, required: true });
    }
    const results = await super.search(query, limit, filters.length > 0 ? filters : undefined);
    this.#enrichSources(results);
    return results;
}
```

#### `store(text, concepts?, existingConceptIds?, sources?)`

```typescript
async store(text: string, concepts?: Concept[], existingConceptIds?: number[], sources?: string[]): Promise<...> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) {
        props.sources = JSON.stringify(sources);
    }
    return this.insertChunk(text, concepts || [], existingConceptIds, Object.keys(props).length > 0 ? props : undefined);
}
```

#### Source enrichment

```typescript
#enrichSources(results: CombinedSearchResult[]) {
    for (const r of results) {
        const props = this.getChunkProperties(r.id);
        if (props.sources) {
            (r as any).sources = JSON.parse(props.sources);
        }
    }
}
```

Also called by `getChunks(ids)` override to enrich with sources.

---

### `AssistantWrapper` (`wrappers/assistant.ts`)

Extends `BaseWrapper`. Uses `memory_type` property instead of `scope` for filtering.

#### `search(query, limit, memoryType?)`

```typescript
async search(query: string, limit: number, memoryType?: string): Promise<CombinedSearchResult[]> {
    const filters: { propertyName: string; value: string; required: boolean }[] = [];
    if (memoryType) {
        filters.push({ propertyName: 'memory_type', value: memoryType, required: true });
    }
    const results = await super.search(query, limit, filters.length > 0 ? filters : undefined);
    this.#enrichSources(results);
    return results;
}
```

#### `store(text, concepts?, existingConceptIds?, sources?, memoryType?)`

```typescript
async store(text: string, concepts?: Concept[], existingConceptIds?: number[], sources?: string[], memoryType?: string): Promise<...> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) {
        props.sources = JSON.stringify(sources);
    }
    if (memoryType) {
        props.memory_type = memoryType;
    }
    return this.insertChunk(text, concepts || [], existingConceptIds, Object.keys(props).length > 0 ? props : undefined);
}
```

#### `promoteToWorking(id)` / `demoteToArchival(id)`

Convenience methods that call `setChunkProperties`:

```typescript
async promoteToWorking(id: number) {
    this.setChunkProperties(id, { memory_type: 'working' });
}
async demoteToArchival(id: number) {
    this.setChunkProperties(id, { memory_type: 'archival' });
}
```

#### Source enrichment (same as CodingWrapper)

```typescript
#enrichSources(results: CombinedSearchResult[]) {
    for (const r of results) {
        const props = this.getChunkProperties(r.id);
        if (props.sources) {
            (r as any).sources = JSON.parse(props.sources);
        }
    }
}
```

**Deferred features** (not in scope for this plan):
- `agent_id`, `model_id`, `session_id` — automatic property injection
- `consolidate()` — merging similar chunks

---

### Validation (wrappers)

1. **BaseWrapper store + created_at:**
   - `wrapper.store("test")`
   - `SELECT created_at FROM chunks WHERE id = ?` → non-empty ISO timestamp

2. **BaseWrapper search access_count:**
   - `wrapper.search("test", 5)`
   - Check chunk's `access_count` column → incremented by 1

3. **CodingWrapper scope filter:**
   - Store chunks with and without `scope: 'backend'`
   - `wrapper.search("test", 5, 'backend')` → only scoped chunks returned
   - `wrapper.search("test", 5)` → all chunks returned (no filter)

4. **CodingWrapper sources:**
   - `wrapper.store("text", [], ["https://a.com"])`
   - `wrapper.search("text", 5)` → result has `sources: ["https://a.com"]`

5. **CodingWrapper sources absent:**
   - `wrapper.store("text")` without sources
   - `wrapper.search("text", 5)` → result has no `sources` field

6. **Edge — empty scope|memoryType = no filter:**
   - `wrapper.search("test", 5, undefined)` → same as `super.search()`

7. **AssistantWrapper memory_type:**
   - Store a chunk with `memory_type: 'working'`
   - `wrapper.search("test", 5, 'working')` → returns only working chunks
   - `wrapper.search("test", 5)` → returns all chunks (no filter)

8. **promoteToWorking / demoteToArchival:**
   - Call `promoteToWorking(id)`, then `getChunkProperties(id).memory_type` → `'working'`
   - Call `demoteToArchival(id)`, then `getChunkProperties(id).memory_type` → `'archival'`
