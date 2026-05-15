# @malaclyde/coding-memory-oc

Memory tools for coding agents. Stores and retrieves project knowledge with
semantic search, keyword search, and reranker fusion.

## Installation

```jsonc
// opencode.jsonc
{ "plugin": [["@malaclyde/coding-memory-oc", { "dbPath": "project" }]] }
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

Automatically installed by OpenCode: `@malaclyde/knowledge-base`, `@opencode-ai/plugin`.
`@huggingface/transformers` (for embeddings and reranker) and `usearch` (for vector search)
are transitive dependencies.

## Prerequisites

Node.js 18+

**macOS only:** If you see the following warning in the OpenCode TUI:

```
objc[XXXX]: Class GNotificationCenterDelegate is implemented in both
  .../node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib
and
  .../.config/opencode/node_modules/sharp/vendor/.../libvips-cpp.42.dylib
This may cause spurious casting failures and mysterious crashes.
One of the duplicates must be removed or renamed.
```

Set this environment variable before starting OpenCode:

```bash
export OBJC_DEBUG_DUPLICATE_CLASSES=NO
opencode
```

Or add it to your `~/.zshrc` (or `~/.bashrc`):

```bash
export OBJC_DEBUG_DUPLICATE_CLASSES=NO
```
## License

MIT
