// クラウド版のデータを、別の Postgres（Neon など）から Supabase に写す。
//
//   npm run cloud:copy-db -- --from "postgresql://…neon…" --to "postgresql://…supabase…"
//   npm run cloud:copy-db -- --from "$NEON_DATABASE_URL"        （--to を省くと DATABASE_URL）
//   npm run cloud:copy-db -- … --dry-run                          件数を見るだけ
//
// 何を写すか: cloud/db/schema.ts にある表のすべて（projects / docs / jobs / job_logs / assets /
// personas / kv / push_subs）。Vercel Blob の実体は URL が変わらないので触らない（assets は索引だけ）。
//
// どう写すか: 表ごとに全行を読み、主キーで UPSERT する。何度流しても同じ結果になる（途中で落ちたら
// もう一度流せばよい）。先に `npm run cloud:migrate` で写し先にスキーマを作っておくこと。
// psql が使える環境なら `pg_dump --data-only | psql` でも同じことができる（docs/supabase-migration.md）。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSql} from './cloud-migrate.mjs';

/** 表の定義。pk は ON CONFLICT に使う列。列の型は写し元の information_schema から読む */
const TABLES = [
  {name: 'projects', pk: ['slug'], cols: ['slug', 'persona', 'shop_name', 'format', 'info', 'created_at', 'updated_at', 'deleted_at']},
  {name: 'docs', pk: ['slug', 'name'], cols: ['slug', 'name', 'data', 'rev', 'hash', 'updated_by', 'updated_at']},
  {
    name: 'jobs',
    pk: ['id'],
    cols: ['id', 'slug', 'type', 'params', 'status', 'progress', 'result', 'error', 'log_seq', 'cancel_requested', 'created_at', 'started_at', 'ended_at', 'claimed_at', 'heartbeat_at'],
  },
  {name: 'job_logs', pk: ['job_id', 'seq'], cols: ['job_id', 'seq', 'line']},
  {name: 'assets', pk: ['slug', 'kind', 'mode', 'rel_path'], cols: ['slug', 'kind', 'mode', 'rel_path', 'url', 'bytes', 'hash', 'content_type', 'updated_at']},
  {name: 'personas', pk: ['id'], cols: ['id', 'data', 'updated_at']},
  {name: 'kv', pk: ['key'], cols: ['key', 'data', 'updated_at']},
  {name: 'push_subs', pk: ['endpoint'], cols: ['endpoint', 'keys', 'label', 'created_at', 'last_sent']},
];

const BATCH = 200;
const q = (s) => `"${s}"`;

/**
 * 値はすべて **文字列（Postgres の text 表現）** で運ぶ。
 * postgres.js に jsonb や timestamptz を JS の値として渡すと、JSON を二重に文字列化したり
 * マイクロ秒が落ちたりする。読むときに `col::text`、書くときに `$n::text::<元の型>` とすれば、
 * Postgres 同士の往復になって 1 バイトも変わらない。
 */
const columnTypes = async (sql, table) => {
  const rows = await sql.unsafe(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return Object.fromEntries(rows.map((r) => [r.column_name, r.udt_name]));
};

/** 1 表ぶんの UPSERT 文（VALUES は行数ぶん並べる） */
const upsertText = (t, types, rowCount) => {
  const width = t.cols.length;
  const values = Array.from({length: rowCount}, (_, r) => `(${t.cols.map((c, i) => `$${r * width + i + 1}::text::${q(types[c])}`).join(', ')})`).join(',\n');
  const updates = t.cols
    .filter((c) => !t.pk.includes(c))
    .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
    .join(', ');
  return `INSERT INTO ${q(t.name)} (${t.cols.map(q).join(', ')}) VALUES\n${values}\nON CONFLICT (${t.pk.map(q).join(', ')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`;
};

export const copyTable = async (from, to, t, {dryRun = false} = {}) => {
  const types = await columnTypes(from, t.name);
  const missing = t.cols.filter((c) => !types[c]);
  if (missing.length) throw new Error(`写し元の ${t.name} に列がありません: ${missing.join(', ')}（写し元にも migration を当ててありますか）`);
  const rows = await from.unsafe(`SELECT ${t.cols.map((c) => `${q(c)}::text AS ${q(c)}`).join(', ')} FROM ${q(t.name)}`);
  if (dryRun || rows.length === 0) return rows.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await to.unsafe(upsertText(t, types, chunk.length), chunk.flatMap((row) => t.cols.map((c) => row[c] ?? null)));
  }
  return rows.length;
};

export const copyAll = async (fromUrl, toUrl, {dryRun = false, log = () => {}} = {}) => {
  const from = await openSql(fromUrl);
  const to = await openSql(toUrl);
  const counts = {};
  try {
    for (const t of TABLES) {
      counts[t.name] = await copyTable(from, to, t, {dryRun});
      log(`${dryRun ? '（確認）' : '✔'} ${t.name}: ${counts[t.name]} 行`);
    }
  } finally {
    await Promise.all([from.end({timeout: 5}), to.end({timeout: 5})]);
  }
  return counts;
};

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fromUrl = argValue('--from') || process.env.NEON_DATABASE_URL || process.env.SOURCE_DATABASE_URL;
  const toUrl = argValue('--to') || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const dryRun = process.argv.includes('--dry-run');
  if (!fromUrl || !toUrl) {
    console.error('写し元と写し先の接続文字列が要ります:');
    console.error('  npm run cloud:copy-db -- --from "postgresql://…（Neon）" --to "postgresql://…（Supabase）"');
    console.error('  （--to を省くと DATABASE_URL、--from を省くと NEON_DATABASE_URL を使います）');
    process.exit(1);
  }
  if (normalizeHost(fromUrl) === normalizeHost(toUrl)) {
    console.error('写し元と写し先が同じ DB です。');
    process.exit(1);
  }
  copyAll(fromUrl, toUrl, {dryRun, log: console.log})
    .then((c) => console.log(`${dryRun ? '件数を確認しました（まだ写していません）' : '写し終えました'}: 合計 ${Object.values(c).reduce((a, b) => a + b, 0)} 行`))
    .catch((e) => {
      console.error(`✖ ${e instanceof Error ? e.message : e}`);
      console.error('  先に `npm run cloud:migrate -- "<写し先の接続文字列>"` でスキーマを作ってあるか確かめてください。');
      process.exitCode = 1;
    });
}

function normalizeHost(u) {
  try {
    const x = new URL(u);
    return `${x.hostname}:${x.port || 5432}${x.pathname}`;
  } catch {
    return u;
  }
}
