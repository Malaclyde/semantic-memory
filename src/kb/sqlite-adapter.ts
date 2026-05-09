import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const _require = createRequire(import.meta.url);

export type Database = any;
export type Statement = any;

// On Bun + macOS, setCustomSQLite() must run at module level before any
// Database is instantiated (Bun auto-loads SQLite on first new Database()).
// The try/catch prevents this from crashing the module if createRequire
// can't resolve bun:sqlite (a Bun built-in module).
if (typeof Bun !== 'undefined' && process.platform === 'darwin') {
  try {
    const { Database: BunDB } = _require('bun:sqlite');
    for (const p of [
      '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
      '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
    ]) {
      if (existsSync(p)) {
        BunDB.setCustomSQLite(p);
        break;
      }
    }
  } catch {}
}

export function createDatabase(path: string): any {
  mkdirSync(dirname(path), { recursive: true });
  if (typeof Bun !== 'undefined') {
    const { Database } = _require('bun:sqlite');
    return new Database(path);
  }
  const Database = _require('better-sqlite3');
  return new Database(path);
}
