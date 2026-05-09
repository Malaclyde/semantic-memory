# Extending Semantic Memory — Custom Tool Wrappers

You can create your own opencode tools powered by semantic-memory without modifying the library itself. Write a `plugin.ts` that imports the wrappers, adds your custom logic, and exports tools.

---

## Minimal example — a `remember` tool

```typescript
// ~/.config/opencode/tools/my-memory.ts
import { tool } from "@opencode-ai/plugin";
import { BaseWrapper } from "semantic-memory";
import { Embedder } from "semantic-memory/kb/embedder";
import { Reranker } from "semantic-memory/kb/reranker";

// Instantiate once — model loading is expensive
const embedder = new Embedder("Xenova/all-MiniLM-L6-v2", 384);
const reranker = new Reranker("Xenova/bge-reranker-base", "Xenova/bge-reranker-base");
const memory = new BaseWrapper(embedder, reranker, { dbPath: './memory.db' });

export default tool({
  description: "Store a fact into long-term memory",
  args: {
    fact: tool.schema.string().describe("The fact to remember"),
    tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags"),
  },
  async execute(args) {
    const concepts = (args.tags || []).map(tag => ({ name: tag }));
    await memory.store(args.fact, concepts);
    return "Stored.";
  },
});
```

Register it in `opencode.jsonc`:

```jsonc
{
  "plugin": ["./.opencode/tools/my-memory.ts"]
}
```

---

## Adding your own properties

```typescript
export default tool({
  description: "Store knowledge scoped to a project",
  args: {
    text: tool.schema.string(),
    project: tool.schema.string(),
  },
  async execute(args) {
    const result = await memory.store(args.text);
    await memory.setProps(Number(result.chunk.id), {
      project: args.project,
    });
    return `Stored under project "${args.project}".`;
  },
});
```

---

## Combining search with custom logic

```typescript
export default tool({
  description: "Search memory but exclude outdated topics",
  args: {
    query: tool.schema.string(),
  },
  async execute(args) {
    const results = await memory.search(args.query, 5);
    return results
      .filter(r => r.rerankerScore > 0.5)
      .map(r => ({ text: r.text, score: r.rerankerScore }));
  },
});
```

---

## Key points

| Rule | Why |
|------|-----|
| Create `Embedder` + `Reranker` + `Wrapper` **once** at module scope | Models are ~200MB each — loading them on every tool call would be seconds of latency |
| Export `default` from your `tool()` call | Opencode expects the tool as the default export |
| Register via `"plugin"` in `opencode.jsonc` | Supports both local paths and npm packages |
| All wrapper methods return Promises | `execute` is async, so `await` everything |
| You never touch `src/kb/` | Your plugin is a separate file — clean separation, survives library updates |
