# Phase 4: Concept dedup + unlink tool + merge existingConceptIds support

## Rationale

Currently every `store_memory` or `merge_memories` call creates new concept rows for every name string provided, even if identically-named concepts already exist in the DB. Over time this produces:

- **Concept table bloat** — duplicate rows with same name, different IDs
- **FTS5 bloat** — redundant index entries for same concept names
- **Orphaned concepts** — `merge_memories` marks source chunks outdated, leaving old concept rows dangling with no active chunk edges

The fix has three parts:

1. **Auto-dedup in `store_memory` and `merge_memories`** — before inserting, look up each concept name. If found, link the existing concept silently. If not found, create it. Return a `Note` (not an error) listing what was automatically linked, so the agent can verify the match.
2. **`unlink_concept` tool** — if a concept was linked incorrectly (wrong meaning despite same name), the agent can detach it from the chunk without losing the chunk text itself.
3. **`UNIQUE(name)` on the concepts table** — schema safety net. Prevents future duplicates. Existing DBs are deduped on startup via a migration step.

---

## Step 1 — Add `UNIQUE(name)` constraint on `concepts` table with migration

Two scenarios: fresh DB (constraint added by `CREATE TABLE`) and existing DB (migration dedups then adds index).

### 1a. Update `initialize.sql`

```sql
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    embedding BLOB
);
```

Only one word added: `UNIQUE` after `name TEXT NOT NULL`.

### 1b. Add migration logic in `db.ts` constructor

After `db.exec(sql)` but before returning, run a migration that:
1. Checks if a unique index on `concepts.name` already exists
2. If not, deduplicates existing concepts (keep lowest-ID per name, repoint edges), then creates the index

Implementation in `#init()`:

```typescript
#init(): Database {
    const db = createDatabase(this.#dbPath);
    const sql = fs.readFileSync(path.join(_dirname, 'sql', 'initialize.sql'), 'utf8');
    db.exec(sql);

    // Migration: ensure UNIQUE constraint on concepts.name
    const uniqueIdx = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='concepts' AND name='uq_concepts_name'"
    ).get() as any;
    if (!uniqueIdx) {
        // Step 1: For each duplicate name, repoint edges from stale IDs to canonical ID
        db.exec(`
            CREATE TEMP TABLE _dup_map AS
            SELECT name, id AS stale_id, MIN(id) OVER (PARTITION BY name) AS canonical_id
            FROM concepts
            WHERE id != canonical_id;
            
            UPDATE edges
            SET concept_id = (SELECT canonical_id FROM _dup_map WHERE stale_id = edges.concept_id)
            WHERE concept_id IN (SELECT stale_id FROM _dup_map);
            
            DELETE FROM concepts WHERE id IN (SELECT stale_id FROM _dup_map);
            
            DROP TABLE _dup_map;
        `);
        // Step 2: Add unique index
        db.exec("CREATE UNIQUE INDEX uq_concepts_name ON concepts(name)");
    }

    return db;
}
```

### Edge cases

- **Fresh DB**: `CREATE TABLE` already has `UNIQUE`, migration query finds `uq_concepts_name` exists, skips.
- **Existing DB with no duplicates**: the `UPDATE edges` and `DELETE` are no-ops (no rows match), index creation succeeds.
- **Existing DB with duplicates**: edges repointed to canonical ID, stale rows deleted, index created.

### Verification

```bash
# Schema check
sqlite3 test.db "SELECT sql FROM sqlite_master WHERE name='concepts'"
# Should show UNIQUE on name

sqlite3 test.db "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_concepts_name'"
# Should show the unique index
```

---

## Step 2 — Add `findConceptsByNames` method to `DB`

A batched lookup for concept names. Used by the wrapper's dedup logic.

### Location

In `db.ts`, after `getConceptsByIds` (line 309).

### Implementation

```typescript
public findConceptsByNames(names: string[]): { id: number; name: string; description: string }[] {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(',');
    return this.db.prepare(
        `SELECT id, name, substr(coalesce(description, ''), 1, 100) as description FROM concepts WHERE name IN (${placeholders})`
    ).all(...names) as { id: number; name: string; description: string }[];
}
```

### Key detail

Description clipped to 100 characters (consistent with `#assembleShadowResults`). Returned descriptions are used in the dedup warning — no need for full text here.

---

## Step 3 — Add `removeConceptEdge` method to `DB`

Deletes a single row from the `edges` junction table.

### Location

In `db.ts`, after `setChunkProperties` (line 520).

### Implementation

```typescript
public removeConceptEdge(chunkId: number, conceptId: number): number {
    return this.db.prepare(
        "DELETE FROM edges WHERE chunk_id = ? AND concept_id = ?"
    ).run(chunkId, conceptId).changes;
}
```

### Return value

`1` if an edge existed and was deleted, `0` if none found. Used by the plugin to form the response message.

---

## Step 4 — Add concept dedup logic to `BaseWrapper.store()`

Pre-flight: for each concept name in the `concepts` array, check if it already exists. If yes, add its ID to `existingConceptIds`. If no, pass it to `insertChunk` as a new concept.

### Implementation in `base.ts`

Replace the `store` method:

```typescript
async store(
    text: string,
    concepts?: Concept[],
    existingConceptIds?: number[],
    sources?: string[],
    scope?: string,
): Promise<{
    chunk: dbo.Chunk;
    concepts: dbo.Concept[];
    notes?: { type: "concept_exists"; name: string; id: number; description: string }[];
}> {
    const props: Record<string, string> = {};
    if (sources && sources.length > 0) props.sources = JSON.stringify(sources);
    if (scope) props.scope = scope;

    const existingIds = [...(existingConceptIds || [])];
    const trulyNew: Concept[] = [];
    const notes: { type: "concept_exists"; name: string; id: number; description: string }[] = [];

    if (concepts && concepts.length > 0) {
        const names = concepts.map(c => c.name);
        const found = this.findConceptsByNames(names);
        const foundNames = new Set(found.map(f => f.name));

        for (const c of concepts) {
            if (foundNames.has(c.name)) {
                const f = found.find(x => x.name === c.name)!;
                existingIds.push(f.id);
                notes.push({ type: "concept_exists", name: f.name, id: f.id, description: f.description });
            } else {
                trulyNew.push(c);
            }
        }
    }

    const result = await this.insertChunk(
        text,
        trulyNew,
        existingIds,
        Object.keys(props).length > 0 ? props : undefined,
    );

    return { ...result, notes: notes.length > 0 ? notes : undefined };
}
```

### Warning format returned to plugin

```
{ type: "concept_exists", name: "Gumroad", id: 3, description: "The Gumroad e-commerce platform" }
```

The plugin formats this into a user-visible note.

---

## Step 5 — Add concept dedup + existingConceptIds to `BaseWrapper.merge()`

Same pre-flight logic as `store()`, plus a new `existingConceptIds` parameter.

### Updated signature

```typescript
async merge(
    sourceIds: number[],
    targetText: string,
    targetConcepts?: Concept[],
    existingConceptIds?: number[],
): Promise<{
    chunk: ChunkResult;
    concepts: dbo.Concept[];
    notes?: { type: "concept_exists"; name: string; id: number; description: string }[];
}>
```

### Implementation

```typescript
async merge(
    sourceIds: number[],
    targetText: string,
    targetConcepts?: Concept[],
    existingConceptIds?: number[],
): Promise<{
    chunk: ChunkResult;
    concepts: dbo.Concept[];
    notes?: { type: "concept_exists"; name: string; id: number; description: string }[];
}> {
    const existingIds = [...(existingConceptIds || [])];
    const trulyNew: Concept[] = [];
    const notes: { type: "concept_exists"; name: string; id: number; description: string }[] = [];

    if (targetConcepts && targetConcepts.length > 0) {
        const names = targetConcepts.map(c => c.name);
        const found = this.findConceptsByNames(names);
        const foundNames = new Set(found.map(f => f.name));

        for (const c of targetConcepts) {
            if (foundNames.has(c.name)) {
                const f = found.find(x => x.name === c.name)!;
                existingIds.push(f.id);
                notes.push({ type: "concept_exists", name: f.name, id: f.id, description: f.description });
            } else {
                trulyNew.push(c);
            }
        }
    }

    return this.mergeChunks(sourceIds, targetText, trulyNew, existingIds)
        .then(result => ({
            ...result,
            notes: notes.length > 0 ? notes : undefined,
        }));
}
```

---

## Step 6 — Update `mergeChunks` in `DB` to accept `existingConceptIds`

### Current signature

```typescript
public async mergeChunks(sourceIds: number[], targetText: string, targetConcepts?: Concept[])
```

### New signature

```typescript
public async mergeChunks(sourceIds: number[], targetText: string, targetConcepts?: Concept[], existingConceptIds?: number[])
```

### Only change

In the call to `insertChunk`, pass `existingConceptIds`:

```typescript
// Before
const result = await this.insertChunk(targetText, targetConcepts || []);

// After
const result = await this.insertChunk(targetText, targetConcepts || [], existingConceptIds);
```

---

## Step 7 — Add `unlinkConcept` passthrough to `BaseWrapper`

```typescript
async unlinkConcept(chunkId: number, conceptId: number): Promise<number> {
    return this.removeConceptEdge(chunkId, conceptId);
}
```

One line. Wraps the DB method for the plugin.

---

## Step 8 — Update `store_memory` and `merge_memories` tool handlers in `coding-memory/plugin.ts`

### 8a. `store_memory` — format the dedup note

```typescript
async execute(args) {
    const concepts = (args.concepts || []).map(name => ({ name }));
    const result = await memory.store(args.text, concepts, args.existingConceptIds, args.sources, args.scope);

    let output = JSON.stringify({
        chunkId: Number(result.chunk.id),
        conceptIds: result.concepts.map(c => Number(c.id)),
    });

    if (result.notes && result.notes.length > 0) {
        const lines = result.notes.map(n =>
            `- "${n.name}" (ID: ${n.id}) — ${n.description}`
        );
        output += "\n\nNote: the following concepts already existed and were linked automatically:";
        output += "\n" + lines.join("\n");
        output += "\n\nIf any of these are incorrect, use `unlink_concept(chunk_id, concept_id)` to detach them.";
    }

    return { output };
}
```

### 8b. `merge_memories` — add `existingConceptIds` arg + format the dedup note

Before:
```typescript
args: {
    sourceIds: tool.schema.array(tool.schema.number()).describe("Chunk IDs to merge"),
    targetText: tool.schema.string().describe("Consolidated text"),
    concepts: tool.schema.array(tool.schema.string()).optional().describe("Tag concepts"),
}
```

After:
```typescript
args: {
    sourceIds: tool.schema.array(tool.schema.number()).describe("Chunk IDs to merge"),
    targetText: tool.schema.string().describe("Consolidated text"),
    concepts: tool.schema.array(tool.schema.string()).optional().describe("Concept names"),
    existingConceptIds: tool.schema.array(tool.schema.number()).optional().describe("IDs of existing concepts to link"),
}
```

Execute handler:
```typescript
async execute(args) {
    const concepts = (args.concepts || []).map(name => ({ name }));
    const result = await memory.merge(args.sourceIds, args.targetText, concepts, args.existingConceptIds);

    let output = JSON.stringify({ newChunkId: Number(result.chunk.id) });

    if (result.notes && result.notes.length > 0) {
        const lines = result.notes.map(n =>
            `- "${n.name}" (ID: ${n.id}) — ${n.description}`
        );
        output += "\n\nNote: the following concepts already existed and were linked automatically:";
        output += "\n" + lines.join("\n");
        output += "\n\nIf any of these are incorrect, use `unlink_concept(chunk_id, concept_id)` to detach them.";
    }

    return { output };
}
```

---

## Step 9 — Add `unlink_concept` tool to `coding-memory/plugin.ts`

### Tool definition

```typescript
const unlink_concept = tool({
    description: "Detach a concept from a chunk without deleting the chunk. Use when a chunk was linked to the wrong concept and you want to fix the tag without losing the stored information.",
    args: {
        chunk_id: tool.schema.number().describe("ID of the chunk to unlink from"),
        concept_id: tool.schema.number().describe("ID of the concept to detach"),
    },
    async execute(args) {
        const deleted = await memory.unlinkConcept(args.chunk_id, args.concept_id);
        if (deleted === 0) {
            return { output: "No such edge exists. The chunk may already be unlinked from this concept, or the IDs may be wrong." };
        }
        return { output: `Concept ${args.concept_id} unlinked from chunk ${args.chunk_id}. To link a replacement concept, use \`store_memory\` with \`existingConceptIds\` or \`merge_memories\`.` };
    },
});
```

### Export

Add `unlink_concept` to the returned `tool` object.

---

## Step 10 — Update `store_memory` and `merge_memories` descriptions (phase-3 delta)

Add the dedup note to the end of `store_memory`:

```
If a concept name already exists, it is linked automatically. The response will
include a note with the existing concept's ID and description. If the wrong
concept was linked, use `unlink_concept(chunk_id, concept_id)` to detach it.
```

Add to `merge_memories`:

```
If a concept name already exists, it is linked automatically (same dedup behavior
as `store_memory`). Use `existingConceptIds` to pass pre-looked-up concept IDs.
```

---

## Step 11 — Mirror changes in `opencode/assistant-memory/plugin.ts`

Identical changes as Steps 8–10:
- Format dedup notes in `store_memory` and `merge_memories` handlers
- Add `existingConceptIds` parameter to `merge_memories`
- Add `unlink_concept` tool
- Update tool descriptions

The `AssistantWrapper` inherits from `BaseWrapper`, so Steps 2–7 apply automatically.

---

## Step 12 — Final validation

```bash
# 1. Type check
npx tsc --noEmit

# 2. All tests (some may need updating due to concept dedup behavior)
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

// Store first chunk with new concept
const a = await db.insertChunk('Gumroad handles payments', [{ name: 'Gumroad', description: 'The platform' }]);
console.log('Concept ID:', Number(a.concepts[0].id));

// findConceptsByNames should return the existing concept
const found = db.findConceptsByNames(['Gumroad']);
console.log('Found:', found.length === 1 ? 'OK' : 'FAIL');

// Store second chunk with same concept name via dedup (wrapper level)
const w = new (await import('./src/kb/wrappers/base')).default(e, r);
const result = await w.store('Gumroad pricing', [{ name: 'Gumroad' }], undefined, undefined, undefined);
console.log('Stored chunk:', Number(result.chunk.id));
console.log('Notes:', result.notes ? JSON.stringify(result.notes) : 'none');

// Verify no duplicate concept rows
const count = db.db.prepare('SELECT COUNT(*) as c FROM concepts WHERE name = ?').get('Gumroad') as any;
console.log('Concept count for Gumroad:', count.c, count.c === 1 ? 'OK' : 'FAIL');

// Test unlink
const edgeCount = db.removeConceptEdge(Number(result.chunk.id), found[0].id);
console.log('Unlinked edges:', edgeCount);
console.log('All smoke tests passed!');
"
```

---

## Summary of files changed

| File | Change |
|------|--------|
| `src/kb/sql/initialize.sql` | Add `UNIQUE` to concepts.name |
| `src/kb/db.ts` | Migration logic on init; add `findConceptsByNames`, `removeConceptEdge`; update `mergeChunks` signature |
| `src/kb/wrappers/base.ts` | Dedup logic in `store()` and `merge()`; add `unlinkConcept()` passthrough; return `notes` from both |
| `opencode/coding-memory/plugin.ts` | Format dedup notes in handlers; add `existingConceptIds` to `merge_memories`; add `unlink_concept` tool; update descriptions |
| `opencode/assistant-memory/plugin.ts` | Same as coding-memory |

## Test considerations

Existing tests that may need updating:
- **`db.test.ts:insertChunk`** — if tests re-use the same concept names across insert calls, they'll now hit the UNIQUE constraint on the second insert. Solution: use unique concept names per test case, or call `insertChunk` only via the wrapper's dedup-aware `store()`.
- **`base-wrapper.test.ts` / `coding-wrapper.test.ts`** — tests that call `store()` with repeated concept names will now receive `notes` in the return. Assertions may need updating.
- **`db.test.ts` shadow tests** — unaffected (they read, not write concepts).

No test should fail silently — type checker will catch signature changes, test assertions will mismatch on dedup notes.
