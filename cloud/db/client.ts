// Neon への接続。Vercel Functions（サーバーレス）なので HTTP ドライバを使う
// （TCP プールはリクエストをまたげない）。
import {neon} from '@neondatabase/serverless';
import {drizzle} from 'drizzle-orm/neon-http';
import * as schema from './schema';

export type Db = ReturnType<typeof makeDb>;

const makeDb = (url: string) => drizzle(neon(url), {schema});

let cached: {url: string; db: Db} | null = null;

/** 接続。DATABASE_URL が無ければここで止める（後続で分かりにくい失敗になるより良い） */
export const db = (): Db => {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL が未設定です（Vercel の環境変数、またはローカルの .env.local）');
  if (cached?.url === url) return cached.db;
  cached = {url, db: makeDb(url)};
  return cached.db;
};

export {schema};
export * from './schema';
