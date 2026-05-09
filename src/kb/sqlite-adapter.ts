import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const _require = createRequire(import.meta.url);

export type Database = any;
export type Statement = any;

export function createDatabase(path: string): any {
  if (typeof Bun !== 'undefined') {
    return createBunDatabase(path);
  }
  return createNodeDatabase(path);
}

function createBunDatabase(path: string): any {
  const { Database } = _require('bun:sqlite');
  if (process.platform === 'darwin') {
    for (const p of [
      '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
      '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
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
