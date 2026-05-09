# KB Library — Feature Registry

All features of the knowledge base library, grouped by domain.

---

## A. Core Storage

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| A1 | `insertChunk(text, concepts, existingConceptIds?)` | ✅ Done | Store a text chunk with optional new concepts and links to existing concepts |
| A2 | `setChunkOutdated(id)` | ✅ Done | Soft-delete a chunk (filtered from all queries, data preserved) |
| A3 | `editConcept(id, name, description)` | ✅ Done | Update concept name/description, re-embed, sync FTS |

## B. Retrieval

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| B1 | `semanticSearch(text, limit)` | ✅ Done | Pure vector (cosine) search on chunk embeddings |
| B2 | `keywordSearch(text, limit)` | ✅ Done | Pure FTS5 keyword search on chunk text (returns rowid, text, rank) |
| B3 | `combinedSearch(text, limit)` | ✅ Done | Vector + FTS → RRF merge → reranker → sorted by relevance |
| B4 | `conceptCombinedSearch(name, desc, limit?)` | ✅ Done | Name-only FTS fast path, falls back to vector+FTS+reranker on concepts |

## C. Relationships

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| C1 | Chunk ↔ Concept edges | ✅ Done | Edges table with INSERT OR IGNORE dedup |
| C2 | `getChunksByIds(ids)` | 🔷 Discussing | Batch fetch chunks by IDs |
| C3 | `getConceptChunks(conceptId)` | ✅ Done | Fetch linked chunks for a concept (first 100 chars, non-outdated) — currently `#getConceptChunks`, to be made public |
| C4 | `getConceptsByIds(ids)` | ✅ Done | Batch fetch concepts by IDs (currently `#getConceptsByIds`, to be made public) |

## D. Scoping (NEW)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| D1 | `agent_id` field | ❌ Plan | Isolate memories by agent identity |
| D2 | `session_id` field | ❌ Plan | Group memories by conversation/run session |
| D3 | `user_id` field | ❌ Plan | Scope memories to a specific user |

## E. Temporal (NEW)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| E1 | `created_at` timestamp | ❌ Plan | When the memory was first stored |
| E2 | `updated_at` timestamp | ❌ Plan | When the memory was last modified |
| E3 | `accessed_at` timestamp | ❌ Plan | When the memory was last retrieved (for decay) |
| E4 | Temporal queries | ❌ Plan | Filter/search by time range ("what did I learn yesterday?") |

## F. Provenance (NEW)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| F1 | Source URLs on chunks | ❌ Plan | Links to backing sources (web pages, files, etc.) |
| F2 | Source metadata | ❌ Plan | Title, author, domain of the source |

## G. Quality Signals (NEW)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| G1 | `importance` score (0–1) | ❌ Plan | Intrinsic priority of a memory (set on insert, decays over time) |
| G2 | `confidence` score (0–1) | ❌ Plan | Reliability: direct observation > LLM summary > inferred |
| G3 | `access_count` on chunks | ❌ Plan | Incremented every time a chunk is returned in a search result (primary result + linked concepts' chunks) |
| G4 | `access_count` on concepts | ❌ Plan | Incremented every time a concept is returned in a search result (primary result + linked chunks' concepts) |

## H. Memory Lifecycle (NEW)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| H1 | Working memory promotion | ❌ Plan | Mark a memory as "always in context" (promoted from archival) |
| H2 | Archival memory demotion | ❌ Plan | Demote from working to archival |
| H3 | `consolidate()` — merge similar chunks | ❌ Plan | LLM-driven compression of related chunks into concise summaries |
| H4 | `decay()` — deprioritize stale memories | ❌ Plan | Lower importance of unaccessed memories over time |
| H5 | Batch insert (`insertMany`) | ❌ Plan | Bulk store multiple chunks + concepts in one operation |

## I. Agent Tool Wrappers

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| I1 | Coding agent facade | ❌ Plan | Simplified tools: search_knowledge, store_finding, find_concept |
| I2 | Personal assistant facade | ❌ Plan | Rich tools: remember, recall, update_belief, consolidate |
| I3 | Feature toggle matrix | ❌ Plan | Table mapping which features are exposed to which agent type |

## J. Infrastructure

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| J1 | `src/seed.ts` — 75 chunks from Crawl4AI docs | ✅ Done | Test data |
| J2 | `viewer/` — graph visualization | ✅ Done | Force-directed graph of chunks + concepts + edges |
| J3 | `implementation-plan.md` | ✅ Done | Design document |

---

**Legend**: ✅ Done — ❌ Plan — 🔷 Discussing
