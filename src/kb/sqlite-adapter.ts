import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const _require = createRequire(import.meta.url);

export type Database = any;
export type Statement = any;

// On Bun + macOS, setCustomSQLite() must run at module level before any
// Database is instantiated (Bun auto-loads SQLite on first new Database()).
if (typeof Bun !== 'undefined' && process.platform === 'darwin') {
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
}

export function createDatabase(path: string): any {
  if (typeof Bun !== 'undefined') {
    const { Database } = _require('bun:sqlite');
    return new Database(path);
  }
  const Database = _require('better-sqlite3');
  return new Database(path);
}
