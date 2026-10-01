// Supabase（Postgres）への接続。
//
// Vercel Functions（サーバーレス）から繋ぐので、Supabase の **接続プーラー（Supavisor）の
// トランザクションモード**（ポート 6543）を使う。関数のインスタンスごとに 1 本だけ TCP を張り、
// プーラー側で束ねてもらう。トランザクションモードでは名前付きプリペアドステートメントが
// 使えないので `prepare: false` が必須（Supabase の Drizzle 向けの案内と同じ）。
//
// 接続文字列は DATABASE_URL（無ければ Vercel の Supabase 連携が入れる POSTGRES_URL）。
// Supabase のダッシュボード「Connect」→ Transaction pooler のものを貼る。
import postgres, {type Sql} from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export type Db = ReturnType<typeof makeDb>;

/** 環境変数から接続文字列を取る順番。DATABASE_URL を優先し、Vercel の Supabase 連携の名前も受ける */
export const DATABASE_URL_ENV_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'] as const;

/**
 * Prisma / PgBouncer / libpq 向けの URL パラメータで、Postgres サーバーの設定値ではないもの。
 * postgres.js は知らないクエリパラメータを**そのまま接続時の設定値として送る**ので、残しておくと
 * `unrecognized configuration parameter "pgbouncer"` で繋がらない。ここで落とす。
 */
const NON_SERVER_PARAMS = ['pgbouncer', 'supa', 'connection_limit', 'pool_timeout', 'channel_binding', 'sslcert', 'sslkey', 'sslrootcert', 'schema', 'workaround'];

/** 接続文字列を postgres.js に渡せる形に揃える。形が違えば例外 */
export const normalizeDatabaseUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!/^postgres(ql)?:\/\//.test(trimmed)) throw new Error('接続文字列の形が違います（postgresql://… で始まります）');
  const url = new URL(trimmed);
  for (const k of NON_SERVER_PARAMS) url.searchParams.delete(k);
  return url.toString();
};

/** URL の sslmode を postgres.js の ssl オプションに。無指定なら require（Supabase も Neon も TLS 必須にできる） */
const sslOption = (url: string): false | 'require' | 'prefer' | 'allow' | 'verify-full' => {
  const mode = new URL(url).searchParams.get('sslmode');
  if (mode === 'disable') return false;
  if (mode === 'verify-full' || mode === 'verify-ca') return 'verify-full';
  if (mode === 'prefer' || mode === 'allow') return mode;
  return 'require';
};

export const makeSql = (url: string): Sql => {
  const normalized = normalizeDatabaseUrl(url);
  return postgres(normalized, {
    // トランザクションモードのプーラーはプリペアドステートメントを跨げない
    prepare: false,
    // 1 関数インスタンスにつき数本。Vercel は 1 インスタンスで複数リクエストを同時にさばく（Fluid compute）ので、
    // SSE のポーリングと画面の読み込みが 1 本の接続を順番待ちしないようにする。束ねるのはプーラーの仕事
    max: 4,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: sslOption(normalized),
  });
};

const makeDb = (url: string) => drizzle(makeSql(url), {schema});

let cached: {url: string; db: Db} | null = null;

/** 環境変数から接続文字列を読む（無ければ null） */
export const databaseUrlFromEnv = (env: NodeJS.ProcessEnv = process.env): string | null => {
  for (const k of DATABASE_URL_ENV_KEYS) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return null;
};

/** 接続。DATABASE_URL が無ければここで止める（後続で分かりにくい失敗になるより良い） */
export const db = (): Db => {
  const url = databaseUrlFromEnv();
  if (!url) throw new Error('DATABASE_URL が未設定です（Supabase の Transaction pooler の接続文字列を Vercel の環境変数、またはローカルの .env.local に入れてください）');
  if (cached?.url === url) return cached.db;
  cached = {url, db: makeDb(url)};
  return cached.db;
};

/**
 * `db().execute(sql\`…\`)` の結果を行の配列に揃える。
 * postgres.js ドライバは配列（RowList）を返し、以前の Neon HTTP ドライバは `{rows}` を返していた。
 * 生 SQL を書く場所はこれを通して、ドライバの違いを store に漏らさない。
 */
export const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as {rows?: unknown} | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
};

export {schema};
export * from './schema';
