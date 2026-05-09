import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const _require = createRequire(import.meta.url);

export type Database = any;
export type Statement = any;

export function createDatabase(path: string): any {
  mkdirSync(dirname(path), { recursive: true });
  if (typeof Bun !== 'undefined') {
    const { Database } = _require('bun:sqlite');
    return new Database(path);
  }
  const Database = _require('better-sqlite3');
  return new Database(path);
}
