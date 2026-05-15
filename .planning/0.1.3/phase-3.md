# Phase 3: Clip shadow chunk text + inject top-5 chunks into system prompt

## Rationale

Phase 2 added shadow retrieval operations that return full chunk text. For system prompt injection, full text is a token budget risk — a single architectural document stored as a chunk could burn thousands of tokens every turn. The solution has two parts:

1. **Clip shadow chunk text at 200 characters** so any consumer of `getImportantChunks` / `getRecentChunks` / `getMostAccessedChunks` gets bounded output
2. **Add a `"experimental.chat.system.transform"` hook** to both OpenCode plugins that injects the 5 most important chunks into the system prompt, framed with a concise description and usage hint

The system prompt is rebuilt fresh every agent loop iteration (`prompt.ts:1770-1832`), including after compaction. Injection via `experimental.chat.system.transform` therefore survives compaction without any special compaction hook logic.

---

## Step 1 — Clip chunk text at 200 characters in shadow queries

All three shadow methods (`getRecentChunks`, `getMostAccessedChunks`, `getImportantChunks`) currently select full `text`. Add `substr(text, 1, 200)` to each SQL query.

### Files changed

| File | Change |
|------|--------|
| `src/kb/db.ts` | Modify 3 SQL queries |

### 1a. `getRecentChunks`

**Before:**
```sql
SELECT id, text FROM chunks WHERE outdated = 0 ORDER BY created_at DESC LIMIT ?
```

**After:**
```sql
SELECT id, substr(text, 1, 200) as text FROM chunks WHERE outdated = 0 ORDER BY created_at DESC LIMIT ?
```

### 1b. `getMostAccessedChunks`

**Before:**
```sql
SELECT id, text FROM chunks WHERE outdated = 0 ORDER BY access_count DESC LIMIT ?
```

**After:**
```sql
SELECT id, substr(text, 1, 200) as text FROM chunks WHERE outdated = 0 ORDER BY access_count DESC LIMIT ?
```

### 1c. `getImportantChunks`

**Before:**
```sql
SELECT id, text FROM chunks WHERE id IN (${placeholders})
```

**After:**
```sql
SELECT id, substr(text, 1, 200) as text FROM chunks WHERE id IN (${placeholders})
```

### Edge cases

- `substr()` returns the full string if shorter than 200 chars — no broken slices
- Existing tests compare against `total` count and check shape properties, not text length — no test breakage
- `#assembleShadowResults` is unchanged — it processes the already-clipped rows

### Verification

```bash
npx tsc --noEmit && npm test
```

---

## Step 2 — Add `"experimental.chat.system.transform"` hook to `opencode/coding-memory/plugin.ts`

### Location

In the returned `Hooks` object, after the `tool` block (line 152), before the closing `}`.

### Implementation

```typescript
"experimental.chat.system.transform": async (_input, output) => {
    const chunks = memory.getImportantChunks(5)
    if (chunks.length === 0) return

    const header = [
        "<semantic-memory>",
        "The 5 most important facts from the project knowledge base, selected by recency and access frequency.",
        "Use `search_memory` to find additional context by keyword, concept, or date range.",
        "",
    ].join("\n")

    const body = chunks
        .map((c, i) => `${i + 1}. [ID: ${c.id}] ${c.text}`)
        .join("\n")

    output.system.push(header + body + "\n</semantic-memory>")
}
```

### Result in system prompt

```
<semantic-memory>
The 5 most important facts from the project knowledge base, selected by recency and access frequency.
Use `search_memory` to find additional context by keyword, concept, or date range.

1. [ID: 15] The authentication module uses JWT tokens with 24-hour expiry; refresh tokens stored in Redis
2. [ID: 42] Database migrations run via golang-migrate; never edit applied migrations — always add new ones
...
</semantic-memory>
```

### Guardrail: no-op on empty DB

`getImportantChunks(5)` returns an empty array when no chunks exist. The `if (chunks.length === 0) return` guard prevents an empty `<semantic-memory></semantic-memory>` block from appearing. Nothing is pushed to `output.system`.

### Token budget estimate

Worst-case token count (assuming ~English text, ~0.75 tokens/word):
- Fixed header: ~30 tokens
- 5 chunks x 200 chars each = ~1000 chars → ~150 tokens
- `<semantic-memory>` wrapper: ~5 tokens
**Total: ~185 tokens per turn**, well within acceptable bounds.

### Verification

```bash
npx tsc --noEmit
```

No runnable test — hook behavior requires a live OpenCode session. Manual verification: start a session, store a chunk via `store_memory`, then check that the next agent turn includes the `<semantic-memory>` block in its system prompt. Trigger `/compact` and confirm the block persists after compaction.

---

## Step 3 — Add `"experimental.chat.system.transform"` hook to `opencode/assistant-memory/plugin.ts`

### Location

In the returned `Hooks` object, after the `tool` block (line 149), before the closing `}`.

### Implementation

Identical to Step 2 — same code block, since `AssistantWrapper` also inherits `getImportantChunks` from `DB`.

### Verification

```bash
npx tsc --noEmit
```

---

## Step 4 — Overhaul tool descriptions in `opencode/coding-memory/plugin.ts`

Current descriptions are one-liners with no quality guidance, examples, or trigger-action pairs. Replace all six tool descriptions with usage-focused versions that together present a complete picture of how to use the coding-memory plugin.

### Files changed

| File | Change |
|------|--------|
| `opencode/coding-memory/plugin.ts` | Replace all 6 `description` strings |

### Design principles

- No implementation details — agents don't need "semantic + keyword + reranker"
- No prescriptive scope names ("frontend", "backend") — use "component, service, or subsystem" so the agent derives its own scheme from the project
- Quality rules live in `store_memory` (where chunks are created), cross-references in other tools
- Trigger-action pairs only where a specific event implies a specific tool call
- No duplicate triggers across tools

### 4a. `search_memory`

**Before:**
```
Search stored knowledge using semantic + keyword + reranker fusion. Supports scope filtering and date range limits.
```

**After:**
```
Search the knowledge base for stored facts, decisions, conventions, and research results. Results include relevance scores for each match. Filter by scope (component, service, or subsystem name) and optional date range. Set strict_scope=false to also include unscoped chunks alongside the scope match.
```

### 4b. `store_memory`

**Before:**
```
Store a new fact into knowledge base. Use scope to organize knowledge by project area (e.g. 'frontend', 'backend', 'api'). Unscoped chunks match all searches.
```

**After:**
```
Store a fact in persistent memory. Use scope to organize by component, service, or subsystem; unscoped entries appear in all searches.

Rules:
- 3–5 sentences per entry, covering ONE narrow topic only
- Focus on factual essence, not on changes to a specific plan
- Before calling, use `find_concept` to reuse existing concept names

Bad (too long, two unrelated topics, plan-specific calculation):
text: "Gumroad charges 10% + $0.50 plus 2.9% card processing, so a €29 product costs €4.48 in fees. Austrian side income for employees is taxed at marginal rate..." [cut 25 more lines]
concepts: ["Gumroad", "Austrian Tax"]

Good — split into focused chunks:
① text: "Gumroad operates as the Merchant of Record, handling EU VAT globally. Its direct-sale fee structure combines a 10% platform fee plus $0.50 with a separate 2.9% plus $0.30 card processing fee. Discover marketplace sales are a flat 30% rate including processing costs."
concepts: ["Gumroad", "Merchant of Record", "Platform Fees", "Payment Processing"]
sources: ["https://gumroad.com/pricing"]

② text: "In Austria the annual tax-free amount (Grundfreibetrag) applies to total income, not side income separately. For employees, all side business income is taxed at the highest marginal rate, as lower brackets are consumed by the primary salary."
concepts: ["Austrian Tax Law", "Marginal Tax Rate", "Grundfreibetrag", "Side Business"]
sources: ["https://bmf.gv.at"]

Triggers:
- Completed research → split findings into 3–5 sentence chunks, store each
- Discovered a fact/constraint/convention → store it
```

### 4c. `find_concept`

**Before:**
```
Find a concept by name or description
```

**After:**
```
Find existing concepts by name or description. Always call before `store_memory` to check if a concept already exists — reuse exact names to merge related chunks under shared concepts and avoid duplicates. Pass found concept IDs to `store_memory` via `existingConceptIds` to link to them.
```

### 4d. `get_chunks`

**Before:**
```
Retrieve full chunk texts by their IDs, including metadata
```

**After:**
```
Retrieve full chunk texts by their IDs. Use to load complete text for chunks referenced by ID in the system prompt or conversation context. Returns full text with created_at, access_count, and sources metadata.
```

### 4e. `merge_memories`

**Before:**
```
Merge multiple chunks into one consolidated chunk
```

**After:**
```
Merge multiple chunks covering the same narrow topic into one consolidated entry. Source chunks are marked outdated; the merged result replaces them. The merged text must still follow the 3–5 sentence rule.
```

### 4f. `set_outdated`

**Before:**
```
Mark a chunk as outdated (hidden from results)
```

**After:**
```
Mark a chunk as outdated, hiding it from all future searches. If replacing obsolete information: call `set_outdated` on the old chunk, then `store_memory` the corrected entry with appropriate concepts.

Trigger: you retrieved information that you know to be false → set it outdated, then store the corrected version.
```

### Verification

```bash
npx tsc --noEmit
```

Tool descriptions are strings within `tool()` calls — no types to break. A typecheck confirms no syntax errors.

Argument `describe()` strings are left unchanged (already sufficiently detailed).

---

## Step 5 — Final validation

```bash
# 1. Type check everything
npx tsc --noEmit

# 2. All tests
npm test
```

---

## Summary of files changed

| File | Change |
|------|--------|
| `src/kb/db.ts` | Clip `text` to 200 chars in `getRecentChunks`, `getMostAccessedChunks`, `getImportantChunks` SQL queries |
| `opencode/coding-memory/plugin.ts` | Replace all 6 tool descriptions; add `"experimental.chat.system.transform"` hook |
| `opencode/assistant-memory/plugin.ts` | Add `"experimental.chat.system.transform"` hook |

## How it survives compaction

The main agent loop at `prompt.ts:1770-1832` rebuilds the system prompt from scratch on every iteration — environment block, AGENTS.md, tool definitions, and plugin transforms. Compaction at `prompt.ts:1698-1708` injects a `continue` that goes back to the top of this loop. The `experimental.chat.system.transform` hook fires during each system prompt rebuild, regardless of whether the previous iteration was a compaction or a normal turn. No compaction-specific hook is needed.
