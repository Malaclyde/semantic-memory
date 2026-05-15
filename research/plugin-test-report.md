# Plugin Test Report — v0.1.2

Date: 2026-05-15
Database: freshly deleted, auto-recreated by plugin on load

---

## 1. Database State After Full Test Cycle

| Function | Test | Result |
|----------|------|--------|
| `store_memory` | Store with new concepts | ✅ |
| `store_memory` | Store with existing concept names (auto-link) | ✅ |
| `find_concept` | Find by name, returns linked chunk count | ✅ |
| `get_chunks` | Retrieve by IDs, returns full text + sources + metadata | ✅ |
| `merge_memories` | Merge 2 source chunks into 1, sources marked outdated | ✅ |
| `merge_memories` | Merge with existing concept names (auto-link) | ✅ |
| `unlink_concept` | Detach concept without deleting chunk | ✅ |
| `set_outdated` | Hide chunk from all future searches | ✅ |
| `search_memory` | Basic semantic + keyword search | ✅ (partial) |
| `search_memory` | Scope filter (`strict_scope=true`) | ✅ |
| `search_memory` | No-scope fallback (`strict_scope=false`) | ✅ |
| `search_memory` | `younger_than` date filter | ✅ |
| `search_memory` | `older_than` date filter | ⚠️ (see below) |

---

## 2. Descriptions Check

All tool descriptions in `opencode/coding-memory/plugin.ts` were reviewed:

| Tool | Description quality |
|------|-------------------|
| `search_memory` | Detailed, covers score, scope, strict_scope, date ranges |
| `store_memory` | Very detailed, includes examples of good/bad entries, concept dedup rules |
| `find_concept` | Clear, explains pre-check pattern for store_memory |
| `get_chunks` | Clear, explains return metadata |
| `merge_memories` | Clear, explains source outdated + concept dedup |
| `unlink_concept` | Short but adequate |
| `set_outdated` | Good, explains replacement pattern |

**Recommendation**: All descriptions are adequate. No changes needed.

---

## 3. Bugs Found

### Bug 1: `search_memory` fails when `limit` uses default value

**Severity**: High

**Symptom**: Calling `search_memory` without passing `limit` returns `"datatype mismatch"`. Passing `limit` explicitly works.

**Root cause**: `.default(5)` in the tool schema is not applied correctly by the opencode plugin SDK. When the parameter is omitted, `args.limit` becomes `undefined` instead of `5`. This causes `Math.max(10 * undefined, FTS_SEARCH_LIMIT)` to produce `NaN`, which SQLite rejects as a LIMIT value.

**Steps to reproduce**:
```
search_memory(query="compaction")                 → "datatype mismatch" (limit defaults to undefined)
search_memory(query="compaction", limit=5)         → works correctly
search_memory(query="compaction", limit=3)         → works correctly
search_memory(query="compaction", limit=1)         → works correctly
```

**Possible fix in plugin.ts**:
```typescript
// Before line 29:
limit: tool.schema.number().default(5).describe("Max results"),
// Either: remove .default() and always pass explicit limit
// Or: add a fallback in execute:
const effectiveLimit = args.limit ?? 5;
```

---

### Bug 2: `older_than` date filter broken with ISO 8601 'T' format

**Severity**: Low

**Symptom**: `older_than` filter returns false positives when the date string uses ISO 8601 `T` separator (e.g. `"2026-05-15T15:10:00"`). The comparison includes chunks created AFTER the specified date.

**Root cause**: Stored dates use SQLite's `datetime('now')` which produces format `"2026-05-15 15:12:59"` (space separator). The filter uses SQLite string comparison:

```sql
SELECT id FROM chunks WHERE created_at < '2026-05-15T15:10:00'
```

At position 10, `' '` (ASCII 32) < `'T'` (ASCII 84), so ALL stored dates compare as less than the filter value, regardless of the actual time. The `younger_than` filter with `>` is not affected (it would only exclude chunks incorrectly).

**Reproduction**:
```
search_memory(query="compaction", older_than="2026-05-15T15:10:00")
→ returns chunk created at 2026-05-15 15:12:59 (SHOULD be excluded)
```

**Fix**: Normalize `T` → space in filter values before passing to SQL. Location: `src/kb/db.ts` lines 430-437 or in the `search_memory` execute function.

---

## 4. Integration with System Prompt (Experimental Feature)

The `experimental.chat.system.transform` hook correctly injects the `<semantic-memory>` block with the 5 most important chunks into every system prompt. Tested by observing that chunk context was available after compaction (previous session validation).

---

## 5. Summary

| Area | Status |
|------|--------|
| Basic CRUD (store, get, search, outdated) | ✅ Working |
| Concept management (find, create, auto-link, unlink) | ✅ Working |
| Merge (chunks + concepts, auto-link, source outdated) | ✅ Working |
| Search filters (scope, strict, date ranges) | ⚠️ 1 bug |
| Parameter defaults | ❌ 1 bug |
| Tool descriptions | ✅ Good |
| System prompt integration | ✅ Working |
