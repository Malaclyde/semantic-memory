# Phase 5: Bug fixes identified in plugin test report

## Rationale

Two bugs discovered during manual testing of the published v0.1.2 plugin:

1. `search_memory` fails with `"datatype mismatch"` when `limit` uses the `.default(5)` value (parameter becomes `undefined` instead of `5`)
2. `older_than` date filter returns false positives when user passes ISO 8601 `T`-separator format — stored dates use space separator, and SQL string comparison breaks at position 10 (`' '` < `'T'`)

Both are in `opencode/coding-memory/plugin.ts` (tool parameter handling) and `src/kb/db.ts` (date filter SQL).

---

## Bug 1 — Default value not applied for `limit` parameter

### Root cause

In `opencode/coding-memory/plugin.ts:29`:

```typescript
limit: tool.schema.number().default(5).describe("Max results"),
```

The opencode plugin SDK does not apply `.default()` correctly. When the caller omits `limit`, `args.limit` is `undefined` instead of `5`. This propagates to `src/kb/db.ts:378`:

```typescript
const ftsResults = this.#ftsSearch().all(
  this.#ftsQuery(text),
  Math.max(10 * args.limit, FTS_SEARCH_LIMIT)  // args.limit is undefined → NaN
);
```

`Math.max(10 * undefined, 50)` = `NaN`. SQLite rejects `NaN` as a LIMIT value with `"datatype mismatch"`.

### Fix

**File**: `opencode/coding-memory/plugin.ts:35-48`

Replace the bare `args.limit` usage with a safe fallback:

```typescript
async execute(args) {
  const effectiveLimit = args.limit ?? 5;     // <-- add this
  const filters: { propertyName: string; value: string; required: boolean }[] = [];
  // ...
  const results = await memory.search(args.query, effectiveLimit, {  // <-- use it
    filters: filters.length > 0 ? filters : undefined,
    olderThan: args.older_than,
    youngerThan: args.younger_than,
  });
```

Alternatively, leave `.default(5)` in the schema (it's correct for documentation/UI) but always guard in code.

### Verification

```bash
# Test without explicit limit
search_memory(query="test")
# Must return results, not "datatype mismatch"

# Test with explicit limit
search_memory(query="test", limit=1)
search_memory(query="test", limit=100)
# Both must work
```

---

## Bug 2 — `older_than` date format mismatch

### Root cause

In `src/kb/db.ts:429-437`:

```typescript
if (olderThan) { dateSql += ' AND created_at < ?'; dateParams.push(olderThan); }
if (youngerThan) { dateSql += ' AND created_at > ?'; dateParams.push(youngerThan); }
```

Stored dates use SQLite `datetime('now')` → `"2026-05-15 15:12:59"` (space separator).
When user passes ISO 8601 like `"2026-05-15T15:10:00"` (T separator), SQL compares as strings:

```
"2026-05-15 15:12:59" < "2026-05-15T15:10:00"
```

At position 10: `' '` (0x20) < `'T'` (0x54) → always true, even for chunks created before or after the specified time.

`younger_than` with `>` is not affected because it correctly excludes everything (since `space < T` means all `created_at` < filter value, so none are > filter value — overshoots in the safe direction of returning fewer results).

### Fix

**File**: `src/kb/db.ts:429-437`

Normalize `T` → space before comparing:

```typescript
// Date filtering
if (olderThan || youngerThan) {
  let dateSql = 'SELECT id FROM chunks WHERE 1=1';
  const dateParams: any[] = [];
  if (olderThan) {
    dateSql += ' AND created_at < ?';
    dateParams.push(olderThan.replace('T', ' '));     // <-- normalize T
  }
  if (youngerThan) {
    dateSql += ' AND created_at > ?';
    dateParams.push(youngerThan.replace('T', ' '));    // <-- normalize T
  }
  const validIds = (this.db.prepare(dateSql).all(...dateParams) as { id: number }[]).map(r => r.id);
  candidates = candidates.filter(id => validIds.includes(id));
  if (candidates.length === 0) return [];
}
```

This handles both `"2026-05-15T15:10:00"` → `"2026-05-15 15:10:00"` and bare date `"2026-01-01"` (no `T` → `.replace` no-op).

### Verification

```bash
# Test older_than with T format (was broken)
search_memory(query="compaction", older_than="2026-05-15T15:10:00")
# Must NOT return chunks created at 15:12 (excluded because 15:12 > 15:10)

# Test older_than without T format (should still work)
search_memory(query="compaction", older_than="2026-05-15 15:10:00")

# Test younger_than with T format (should still work)
search_memory(query="compaction", younger_than="2026-05-15T15:20:00")
# Must return chunks created before 15:20 (i.e. still works)
```

---

## Files changed

| File | Change |
|------|--------|
| `opencode/coding-memory/plugin.ts` | Add `effectiveLimit = args.limit ?? 5` fallback |
| `src/kb/db.ts` | Normalize `T` → space in `olderThan`/`youngerThan` params |

## Test procedure

1. Apply both fixes
2. Run `npm test` — must pass all existing tests
3. Publish: `npm publish`
4. Restart opencode and run the verification queries above
