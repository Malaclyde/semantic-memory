# Migration Plan: Tool Files → Plugin Packages

## Overview

Split the monolithic `opencode/` folder into two standalone npm plugin packages, each using the Plugin format with proper dependency management and DB path configuration.

## Current Structure

```
semantic-memory/                    ← npm: semantic-memory (core library)
├── package.json                    ← dependencies: better-sqlite3, @huggingface/transformers, sqlite-vec
├── src/kb/                         ← All classes (DB, wrappers, embedder, reranker)
├── opencode/
│   ├── coding-memory.ts            ← Standalone tool file (multiple tool() exports)
│   └── assistant-memory.ts         ← Standalone tool file (multiple tool() exports)
```

## Target Structure

```
semantic-memory/                    ← npm: semantic-memory (core library, unchanged)
├── package.json
├── src/kb/
└── opencode/
    ├── coding-memory/              ← npm: @semantic-memory/coding
    │   ├── package.json            ← depends on semantic-memory + @opencode-ai/plugin
    │   ├── tsconfig.json
    │   ├── README.md               ← placeholder
    │   └── plugin.ts               ← CodingMemoryPlugin → exports tools
    │
    └── assistant-memory/           ← npm: @semantic-memory/assistant
        ├── package.json            ← depends on semantic-memory + @opencode-ai/plugin
        ├── tsconfig.json
        ├── README.md               ← placeholder
        └── plugin.ts               ← AssistantMemoryPlugin → exports tools
```

## Step 1 — DB constructor: accept dbPath

**File:** `src/kb/db.ts`

**Change:** Add optional `dbPath` to constructor, remove module-level `DB_PATH` constant.

```typescript
// Before
const DB_PATH = process.env.SEMANTIC_MEMORY_DB_PATH || './test.db';
export default class DB {
  constructor(public embedder: Embedder, public reranker: Reranker) {}
  #init() { new Database(DB_PATH); }
}

// After
export default class DB {
  #dbPath: string;
  constructor(public embedder: Embedder, public reranker: Reranker, options?: { dbPath?: string }) {
    this.#dbPath = options?.dbPath || process.env.SEMANTIC_MEMORY_DB_PATH || './test.db';
  }
  #init() { new Database(this.#dbPath); }
}
```

**Impact:** Wrapper classes inherit the constructor — no changes to `base.ts`, `coding.ts`, `assistant.ts`.

### Validation

1. **Default path (no args):** `new DB(embedder, reranker)` → DB created at `./test.db`
2. **Custom path:** `new DB(embedder, reranker, { dbPath: '/tmp/test.db' })` → DB created at `/tmp/test.db`
3. **Env var still works:** `SEMANTIC_MEMORY_DB_PATH=/tmp/env.db` + no options → DB at `/tmp/env.db`
4. **Wrappers inherit:** `new CodingWrapper(embedder, reranker, { dbPath: '/tmp/wrapper.db' })` → DB at `/tmp/wrapper.db`
5. **All 109 existing tests pass:** `npx vitest run`

---

## Step 2 — Plugin file: `opencode/coding-memory/plugin.ts`

**Create new files:**
- `opencode/coding-memory/package.json`
- `opencode/coding-memory/tsconfig.json`
- `opencode/coding-memory/plugin.ts`
- `opencode/coding-memory/README.md` (placeholder)

### Validation

1. **Compile:** `npx tsx --eval "import './opencode/coding-memory/plugin'; console.log('OK')"` — succeeds
2. **Default dbPath:** Call plugin with no options → DB created at `<cwd>/.opencode/semantic-memory/memory.db`
3. **Global dbPath:** Call plugin with `{ dbPath: 'global' }` → DB created at `~/.cache/opencode/semantic-memory/memory.db`
4. **Tool count:** Plugin returns at least 6 tools (search, store, find, get, merge, set_outdated)

---

## Step 3 — Plugin file: `opencode/assistant-memory/plugin.ts`

**Create new files:**
- `opencode/assistant-memory/package.json`
- `opencode/assistant-memory/tsconfig.json`
- `opencode/assistant-memory/plugin.ts`
- `opencode/assistant-memory/README.md` (placeholder)

### Validation

1. **Compile:** `npx tsx --eval "import './opencode/assistant-memory/plugin'; console.log('OK')"` — succeeds
2. **Tools count:** Plugin returns at least 8 tools (including promote_to_working, demote_to_archival)
3. **Memory type filtering works:** Store with memory_type, search with memoryType filter → correct results

---

## Step 4 — Plugin README files

Create `opencode/coding-memory/README.md` and `opencode/assistant-memory/README.md`. Each should describe:
- What the plugin does
- Installation (via `opencode.jsonc`)
- Configuration options (`dbPath`: `"project"` or `"global"`)
- Complete list of tools exported with descriptions
- Prerequisites (Node.js 18+)
- Link back to the main `semantic-memory` library

### Coding plugin README

```markdown
# @semantic-memory/coding

Memory tools for coding agents. Stores and retrieves project knowledge with
semantic search, keyword search, and reranker fusion.

## Installation

```jsonc
// opencode.jsonc
{ "plugin": [{ "name": "@semantic-memory/coding", "options": { "dbPath": "project" } }] }
```

## Configuration

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `dbPath` | `"project"` or `"global"` | `"project"` | Where to store the database |

- **project**: `<project-root>/.opencode/semantic-memory/memory.db`
- **global**: `~/.cache/opencode/semantic-memory/memory.db`

## Tools

| Tool | Description |
|------|-------------|
| `search_memory(query, limit?, scope?)` | Search stored knowledge |
| `store_memory(text, concepts?, existingConceptIds?, sources?)` | Store a fact with optional tags and source URLs |
| `find_concept(name, description?)` | Find a concept by name |
| `get_chunks(ids)` | Retrieve full chunk texts by IDs |
| `merge_memories(sourceIds, targetText, concepts?)` | Consolidate multiple chunks |
| `set_outdated(id)` | Mark a chunk as outdated |

## Dependencies

Automatically installed by OpenCode: `semantic-memory`, `@opencode-ai/plugin`,
`better-sqlite3`, `@huggingface/transformers`, `sqlite-vec`.
```

### Assistant plugin README

Same structure, different tool list:

```markdown
# @semantic-memory/assistant

Memory tools for personal assistant agents. Stores and retrieves memories with
working/archival memory tier support.

## Installation

```jsonc
// opencode.jsonc
{ "plugin": [{ "name": "@semantic-memory/assistant", "options": { "dbPath": "project" } }] }
```

## Configuration

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `dbPath` | `"project"` or `"global"` | `"project"` | Where to store the database |

## Tools

| Tool | Description |
|------|-------------|
| `search_memory(query, limit?, memory_type?)` | Search memories, optionally by type |
| `store_memory(text, concepts?, existingConceptIds?, sources?, memory_type?)` | Store a memory |
| `find_concept(name, description?)` | Find a concept by name |
| `get_chunks(ids)` | Retrieve full chunk texts by IDs |
| `promote_to_working(id)` | Promote to working memory |
| `demote_to_archival(id)` | Demote to archival storage |
| `merge_memories(sourceIds, targetText, concepts?, memory_type?)` | Consolidate memories |
| `set_outdated(id)` | Mark as outdated |

## Dependencies

Same as coding plugin.
```

---

## Step 5 — Cleanup old tool files

**Delete:**
- `opencode/coding-memory.ts`
- `opencode/assistant-memory.ts`

### Validation

1. **grep for old tool exports:** No remaining `export const search_memory = tool(` outside the plugin directories
2. **Full test suite passes:** `npx vitest run` — all 109 tests still pass
