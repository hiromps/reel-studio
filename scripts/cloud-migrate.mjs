// クラウド版の DB（Supabase / Postgres）にスキーマを当てる。
//
//   npm run cloud:migrate                     DATABASE_URL（または POSTGRES_URL）に当てる
//   npm run cloud:migrate -- "postgresql://…"  接続文字列を直接渡す
//
// cloud/db/migrations/*.sql を名前順にすべて流す。各ファイルは冪等（IF NOT EXISTS 等）に書いてあるので、
// 新しいデプロイにも、すでに動いているデプロイ（新しい migration だけ足したいとき）にも、そのまま使える。
// `npm run cloud:setup` の中からも同じ関数を呼ぶ。
//
// 接続文字列は Supabase の「Connect」にある **Transaction pooler**（ポート 6543）でも
// Session pooler / Direct connection（5432）でも構わない。1 ファイルを 1 回の simple query として
// 送るので、DO $$ … $$ のような ; を含むブロックもそのまま通る。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'cloud', 'db', 'migrations');

/** Prisma / PgBouncer 向けなど、Postgres サーバーの設定値ではないパラメータ（cloud/db/client.ts と同じ） */
const NON_SERVER_PARAMS = ['pgbouncer', 'supa', 'connection_limit', 'pool_timeout', 'channel_binding', 'sslcert', 'sslkey', 'sslrootcert', 'schema', 'workaround'];

export const normalizeDatabaseUrl = (raw) => {
  const trimmed = String(raw ?? '').trim();
  if (!/^postgres(ql)?:\/\//.test(trimmed)) throw new Error('接続文字列の形が違います（postgresql://… で始まります）');
  const url = new URL(trimmed);
  for (const k of NON_SERVER_PARAMS) url.searchParams.delete(k);
  return url.toString();
};

export const listMigrations = () =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({name: f, text: fs.readFileSync(path.join(dir, f), 'utf8')}));

/** 接続を開く。postgres.js。プーラーのトランザクションモードでも通るように prepare: false */
export const openSql = async (rawUrl) => {
  const {default: postgres} = await import('postgres');
  const url = normalizeDatabaseUrl(rawUrl);
  const mode = new URL(url).searchParams.get('sslmode');
  return postgres(url, {
    prepare: false,
    max: 1,
    connect_timeout: 20,
    // IF NOT EXISTS で「already exists, skipping」の NOTICE が表ごとに出て読みにくいので黙らせる（エラーは別経路で届く）
    onnotice: () => {},
    ssl: mode === 'disable' ? false : mode === 'verify-full' || mode === 'verify-ca' ? 'verify-full' : 'require',
  });
};

/**
 * すべての migration を順に当てる。onApplied(name) で 1 本ごとに知らせる。
 * 戻り値は当てたファイル名の一覧。
 */
export const applyMigrations = async (rawUrl, {onApplied} = {}) => {
  const sql = await openSql(rawUrl);
  const applied = [];
  try {
    for (const m of listMigrations()) {
      // パラメータ無しの unsafe は simple query protocol で送られ、複数文がそのまま通る
      await sql.unsafe(m.text);
      applied.push(m.name);
      onApplied?.(m.name);
    }
  } finally {
    await sql.end({timeout: 5});
  }
  return applied;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const url = arg || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error('接続文字列がありません。DATABASE_URL を設定するか、引数で渡してください:');
    console.error('  npm run cloud:migrate -- "postgresql://postgres.<ref>:<password>@<host>:6543/postgres"');
    process.exit(1);
  }
  applyMigrations(url, {onApplied: (n) => console.log(`✔ ${n}`)})
    .then((a) => console.log(`${a.length} 本の migration を当てました`))
    .catch((e) => {
      console.error(`✖ ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    });
}
