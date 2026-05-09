# Bugfix: Native SQLite bindings in OpenCode's Bun runtime

## Symptoms

OpenCode runs on **Bun**, not Node.js. When loading the `@malaclyde/coding-memory-oc` plugin:

1. **Before any fix:** `better-sqlite3` fails with `"Could not locate the bindings file"` — OpenCode installs npm plugins via `@npmcli/arborist` with `ignoreScripts: true`, which skips `better-sqlite3`'s `install` script (normally `prebuild-install || node-gyp rebuild`).

2. **After `ensureNativeBinding()` fix:** The binary is compiled, but Bun can't load it — `"'better-sqlite3' is not yet supported in Bun"` (tracked at oven-sh/bun#4290). Bun's runtime does not support native Node.js `.node` addons.

## Root Cause

Two layers:

| Layer | Problem |
|-------|---------|
| **OpenCode install** | `ignoreScripts: true` in Arborist skips all lifecycle scripts, so `better-sqlite3`'s native binary never gets built |
| **Bun runtime** | Even if built, Bun can't `dlopen` Node.js `.node` addons |

## Components Investigated

### `better-sqlite3` (v12.9.0)
- **Status:** NOT compatible with Bun
- **Fix:** Replace with `bun:sqlite` (Bun's built-in SQLite module)

### `sqlite-vec` (v0.1.9)
- **Status:** FULLY compatible with Bun
- **Nature:** NOT a Node.js addon — thin JS wrapper that calls `db.loadExtension(path)` to load a platform-specific `.dylib`/`.so`/`.dll`. Both `bun:sqlite` and `better-sqlite3` expose `loadExtension()` with the same signature.
- **Evidence:** sqlite-vec docs have a [dedicated Bun example](https://github.com/asg017/sqlite-vec/blob/main/examples/simple-bun/demo.ts)
- **No changes needed** to the sqlite-vec integration

### `node:sqlite` (Node.js built-in)
- **Status:** 🔴 Not implemented in Bun (per Bun's compat docs)
- **Rejected:** Cannot use `node:sqlite` as a bridge

## Decision

Replace `better-sqlite3` with `bun:sqlite`. Accept macOS dependency on `brew install sqlite` because Apple's system SQLite is compiled with `SQLITE_OMIT_LOAD_EXTENSION`, which blocks sqlite-vec's `loadExtension()` call. This is a macOS-only issue — Linux and Windows work out of the box.

## Verification Phase (macOS)

After each implementation step, validate with:

```bash
# 1. db.ts compiles and sqlite-vec loads correctly
npm test -- --run src/kb/__tests__/embedder.test.ts 2>/dev/null \
  && npx tsx -e "
    import { Database } from 'bun:sqlite';
    import * as sqliteVec from 'sqlite-vec';
    import { existsSync } from 'fs';

    if (process.platform === 'darwin') {
      for (const p of ['/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', '/usr/local/opt/sqlite/lib/libsqlite3.dylib']) {
        if (existsSync(p)) { Database.setCustomSQLite(p); break; }
      }
    }

    const db = new Database(':memory:');
    sqliteVec.load(db);
    const { vec_version } = db.prepare('select vec_version() as vec_version;').get() as any;
    console.log('sqlite-vec version:', vec_version);
    db.close();
  "

# 2. Full test suite passes
npm test

# 3. Seed script runs cleanly
npm run seed
```

## Design

The library must work on **both** runtimes:
- **Node.js** — local dev (`vitest`, `tsx` scripts)
- **Bun** — OpenCode plugin deployment

Both `better-sqlite3` and `bun:sqlite` expose the same API (`prepare`, `run`, `get`, `all`, `exec`, `transaction`, `loadExtension`). A thin adapter selects the right driver at runtime.

## Required Changes

### 1. `src/kb/sqlite-adapter.ts` — dual-runtime adapter (NEW)

Detects the runtime and creates the appropriate database instance:

```typescript
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const _require = createRequire(import.meta.url);

export function createDatabase(path: string): any {
  if (typeof Bun !== 'undefined') {
    return createBunDatabase(path);
  }
  return createNodeDatabase(path);
}

function createBunDatabase(path: string): any {
  const { Database } = _require('bun:sqlite');
  if (process.platform === 'darwin') {
    // Apple's system SQLite disables loadExtension().
    // A Homebrew SQLite is needed for sqlite-vec.
    for (const p of [
      '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',  // Apple Silicon
      '/usr/local/opt/sqlite/lib/libsqlite3.dylib',      // Intel
    ]) {
      if (existsSync(p)) {
        Database.setCustomSQLite(p);
        break;
      }
    }
  }
  return new Database(path);
}

function createNodeDatabase(path: string): any {
  const Database = _require('better-sqlite3');
  return new Database(path);
}
```

### 2. `src/kb/db.ts` — use adapter

Replace `import Database from 'better-sqlite3'` with the adapter:

```typescript
import { createDatabase } from './sqlite-adapter';
import type { Database, Statement } from './sqlite-adapter';
```

Change `new Database(...)` → `createDatabase(...)`.

### 3. `package.json` — keep better-sqlite3

`better-sqlite3` stays in dependencies — it's still needed for Node.js local dev and tests.

`@types/better-sqlite3` stays as devDependency (for type-checking the adapter).

### 4. Plugins: remove `ensureNativeBinding()`

Revert `opencode/coding-memory/plugin.ts` and `opencode/assistant-memory/plugin.ts` back to static imports. The `ensureNativeBinding()` hack is no longer needed — `bun:sqlite` has no native addon to build, and `better-sqlite3` is only used on Node.js where the native binary is already compiled by `npm install`.

### 5. READMEs — document macOS dependency

Add to `README.md`, `opencode/coding-memory/README.md`, and `opencode/assistant-memory/README.md`:

> **macOS only:** Apple's system SQLite disables extension loading, which is required by sqlite-vec. Install a vanilla SQLite via Homebrew:
> ```bash
> brew install sqlite
> ```
> Linux and Windows users need no additional setup.

## No other changes needed

- `sqlite-vec` — works unchanged with `bun:sqlite`
- FTS5 — built into SQLite, works in bun:sqlite
- Schema (SQL init files) — identical
- Embedder, Reranker — pure JS via Transformers.js, unaffected
- Wrappers, tool definitions — unchanged
