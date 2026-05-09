# @malaclyde/assistant-memory-oc

Memory tools for personal assistant agents. Stores and retrieves memories with
working/archival memory tier support.

## Installation

```jsonc
// opencode.jsonc
{ "plugin": [["@malaclyde/assistant-memory-oc", { "dbPath": "project" }]] }
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
| `search_memory(query, limit?, memory_type?)` | Search memories, optionally by type |
| `store_memory(text, concepts?, existingConceptIds?, sources?, memory_type?)` | Store a memory |
| `find_concept(name, description?)` | Find a concept by name |
| `get_chunks(ids)` | Retrieve full chunk texts by IDs |
| `promote_to_working(id)` | Promote to working memory |
| `demote_to_archival(id)` | Demote to archival storage |
| `merge_memories(sourceIds, targetText, concepts?, memory_type?)` | Consolidate memories |
| `set_outdated(id)` | Mark as outdated |

## Dependencies

Automatically installed by OpenCode: `@malaclyde/knowledge-base`, `@opencode-ai/plugin`.
`@huggingface/transformers` (for embeddings and reranker) and `usearch` (for vector search)
are transitive dependencies.

## Prerequisites

Node.js 18+

## License

MIT
