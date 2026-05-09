# Semantic Memory

A persistent memory backend for AI agents. Stores text chunks with vector embeddings for semantic search, FTS5 for keyword search, and a cross-encoder reranker for relevance fusion. Supports EAV metadata (scope, sources, memory type, etc.) and chunk-to-concept relationships.

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
       better-sqlite3   sqlite-vec      @huggingface/transformers
       (SQLite + FTS5)  (vector search)  (embeddings + reranker)
```

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
- **Embedding** — vector for semantic search (auto-generated)
- **created_at** — timestamp (auto-set)
- **access_count** — retrieval counter (auto-incremented)
- **outdated** — soft-delete flag

### Concepts
Named entities that can be linked to multiple chunks. Each concept has a name and optional description. Concepts are searchable via FTS5 and vector embeddings.

### EAV Properties (Entity-Attribute-Value)
Flexible metadata attached to chunks. Properties are free-form name-value pairs stored in a separate table. Common properties used by tool wrappers:

| Property | Type | Used by | Purpose |
|----------|------|---------|---------|
| `scope` | string | CodingWrapper | Filter by project area (backend, frontend) |
| `sources` | JSON string | Both | Source URLs backing the fact |
| `memory_type` | `"working"` / `"archival"` | AssistantWrapper | Memory tier |
| `created_at` | ISO timestamp | Auto-set | Creation time |
| `access_count` | string (number) | Auto-incremented | Times retrieved |

## API Reference

### Low-Level DB (`src/kb/db.ts`)

| Method | Description |
|--------|-------------|
| `insertChunk(text, concepts?, existingConceptIds?, properties?)` | Store a chunk |
| `semanticSearch(text, limit)` | Pure vector search |
| `keywordSearch(text, limit)` | FTS5 keyword search |
| `combinedSearch(text, limit, filters?)` | Vector + FTS + reranker fusion |
| `conceptCombinedSearch(name, description?)` | Find concepts by name or description |
| `getChunksByIds(ids)` | Batch fetch chunks |
| `getChunksByProperty(name, value)` | Filter chunks by EAV property |
| `getConceptChunks(conceptId, maxLen?)` | Get linked chunks for a concept |
| `getConceptsByIds(ids)` | Batch fetch concepts |
| `setChunkProperties(id, props)` | Set EAV properties |
| `getChunkProperties(id)` | Get all EAV properties |
| `deleteChunkProperty(id, name)` | Remove a property |
| `setChunkOutdated(id)` | Soft-delete a chunk |
| `editConcept(id, name, desc)` | Update a concept |
| `mergeChunks(sourceIds, targetText)` | Consolidate chunks |

### Wrappers

**BaseWrapper** — safe core API for any agent:
`search`, `store`, `getChunks`, `getPreviews`, `findConcept`, `setOutdated`, `editConcept`, `setProps`, `getProps`, `delProp`, `merge`

**CodingWrapper** — extends BaseWrapper, adds `scope` filtering and `sources` tracking. The `store()` method accepts an optional `sources` parameter.

**AssistantWrapper** — extends BaseWrapper, adds `memory_type` filtering. The `store()` method accepts optional `sources` and `memoryType` parameters. Also provides `promoteToWorking(id)` and `demoteToArchival(id)`.

### SearchOptions

All wrappers accept a `SearchOptions` object on `search()`:

```typescript
interface SearchOptions {
  filters?: { propertyName: string; value: string; required: boolean }[];
  scope?: string;       // CodingWrapper: filter by scope
  memoryType?: string;   // AssistantWrapper: filter by memory type
}
```

## Database Schema

The library uses SQLite with the following tables:

- **chunks** — text storage with native `created_at`, `access_count`, `outdated` columns
- **vec_chunks** — vector embeddings (via sqlite-vec vec0 virtual table)
- **concepts** — named entities with name/description
- **vec_concepts** — concept embeddings (via sqlite-vec)
- **edges** — many-to-many chunk↔concept links
- **properties** — EAV property name registry
- **chunk_properties** — EAV values linked to chunks
- **chunks_fts** — FTS5 full-text index on chunk text
- **concepts_fts** — FTS5 index on concept name + description

## OpenCode Plugins

This library is distributed with two OpenCode plugins:

- **@malaclyde/coding-memory-oc** — memory tools for coding agents (`opencode/coding-memory/`)
- **@malaclyde/assistant-memory-oc** — memory tools for personal assistant agents (`opencode/assistant-memory/`)

See their respective README files for usage and configuration.

## Testing

```bash
npm test                # Run all 109 tests
npm run test:watch      # Watch mode
npm run seed            # Populate test DB with sample data
```

## License

MIT
