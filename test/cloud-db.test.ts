// クラウド版の DB 接続まわり（Supabase / postgres.js）。
// 実際に繋ぐテストではなく、「接続文字列の整え方」「生 SQL の結果の受け取り方」「migration がスキーマを
// 全部カバーしているか」という、繋がなくても確かめられる約束だけを見る。
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {DATABASE_URL_ENV_KEYS, databaseUrlFromEnv, normalizeDatabaseUrl, rowsOf} from '../cloud/db/client';
import * as schema from '../cloud/db/schema';
import {getTableName, is} from 'drizzle-orm';
import {PgTable} from 'drizzle-orm/pg-core';

const migrationsDir = path.resolve(__dirname, '..', 'cloud', 'db', 'migrations');
const migrationText = () =>
  fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n');

const tableNames = () => Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableName(t as PgTable));

describe('接続文字列の整え方', () => {
  it('Supabase の Transaction pooler の文字列はそのまま通る', () => {
    const u = 'postgresql://postgres.abcdefgh:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres';
    expect(normalizeDatabaseUrl(u)).toBe(u);
  });

  it('Vercel の Supabase 連携が付ける pgbouncer=true などのサーバーに送れないパラメータを落とす', () => {
    const u = 'postgres://postgres.x:pw@host.pooler.supabase.com:6543/postgres?pgbouncer=true&supa=base-pooler.x&connection_limit=1&sslmode=require';
    const out = new URL(normalizeDatabaseUrl(u));
    expect(out.searchParams.has('pgbouncer')).toBe(false);
    expect(out.searchParams.has('supa')).toBe(false);
    expect(out.searchParams.has('connection_limit')).toBe(false);
    // sslmode は postgres.js が理解するので残す
    expect(out.searchParams.get('sslmode')).toBe('require');
  });

  it('Neon の文字列（channel_binding 付き）も通る形になる', () => {
    const out = new URL(normalizeDatabaseUrl('postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require'));
    expect(out.searchParams.has('channel_binding')).toBe(false);
    expect(out.searchParams.get('sslmode')).toBe('require');
  });

  it('前後の空白は無視し、postgres で始まらないものは弾く', () => {
    expect(normalizeDatabaseUrl('  postgresql://u:p@h/db  ')).toBe('postgresql://u:p@h/db');
    expect(() => normalizeDatabaseUrl('mysql://u:p@h/db')).toThrow();
    expect(() => normalizeDatabaseUrl('')).toThrow();
  });

  it('環境変数は DATABASE_URL → POSTGRES_URL の順に見る', () => {
    expect(DATABASE_URL_ENV_KEYS[0]).toBe('DATABASE_URL');
    expect(databaseUrlFromEnv({DATABASE_URL: ' postgresql://a ', POSTGRES_URL: 'postgresql://b'})).toBe('postgresql://a');
    expect(databaseUrlFromEnv({POSTGRES_URL: 'postgresql://b'})).toBe('postgresql://b');
    expect(databaseUrlFromEnv({DATABASE_URL: '   '})).toBeNull();
    expect(databaseUrlFromEnv({})).toBeNull();
  });
});

describe('生 SQL の結果の受け取り方（rowsOf）', () => {
  it('postgres.js の配列（RowList）はそのまま行になる', () => {
    const rows = Object.assign([{rev: 1}, {rev: 2}], {count: 2, command: 'SELECT'});
    // 同じ配列をそのまま返す（コピーしない）
    expect(rowsOf<{rev: number}>(rows)).toBe(rows);
    expect([...rowsOf<{rev: number}>(rows)]).toEqual([{rev: 1}, {rev: 2}]);
  });

  it('{rows} の形（以前の HTTP ドライバ）も受けられる', () => {
    expect(rowsOf<{rev: number}>({rows: [{rev: 3}]})).toEqual([{rev: 3}]);
  });

  it('形が分からなければ空', () => {
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf({})).toEqual([]);
  });
});

describe('migration はスキーマの表を全部カバーする', () => {
  it('schema.ts の表はすべて CREATE TABLE されている', () => {
    const text = migrationText();
    const names = tableNames();
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const n of names) expect(text, n).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${n}\\b`));
  });

  it('Supabase の REST から見えないように、すべての表で RLS を有効にしている', () => {
    const text = migrationText();
    for (const n of tableNames()) expect(text, n).toMatch(new RegExp(`ALTER TABLE ${n}\\s+ENABLE ROW LEVEL SECURITY`));
  });
});
