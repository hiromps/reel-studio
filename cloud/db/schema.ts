// クラウド版の永続層（Neon / Postgres）。
//
// 方針：
// - **契約ファイル（catalog / brief / cuts / narration / caption）はここが正**。PC 側の work/ は
//   ジョブを実行するための作業コピーで、ワーカーが着手前に引き寄せ、完了後に書き戻す。
// - **原本の素材（4K）はここに載せない**。載るのはサムネ・軽量プロキシ（540x960）・完成動画だけ
//   （assets）。素材そのものは PC の uploads/ にある。
// - PC でしか分からないこと（engine の差分・node_modules・out/ の有無）は projects.info に
//   ワーカーが置いたスナップショットを読む。
import {boolean, integer, jsonb, pgTable, primaryKey, text, timestamp} from 'drizzle-orm/pg-core';
import type {ProjectInfo} from '../../shared/project';

/** ワーカーが報告する「PC 側でしか分からない案件の状態」 */
export type ProjectSnapshot = Pick<ProjectInfo, 'dir' | 'engine' | 'nodeModules' | 'out'>;

export const projects = pgTable('projects', {
  /** 案件フォルダ名（<店名>-reel）。ローカルと同じものを使う */
  slug: text('slug').primaryKey(),
  persona: text('persona'),
  shopName: text('shop_name'),
  format: text('format'),
  /** ワーカーの最終報告（engine / nodeModules / out / dir） */
  info: jsonb('info').$type<ProjectSnapshot>(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  /** 論理削除（案件を消してもジョブ履歴の参照が壊れないように） */
  deletedAt: timestamp('deleted_at', {withTimezone: true}),
});

/** 契約ファイル。name = catalog | brief | cuts | narration | caption */
export const docs = pgTable(
  'docs',
  {
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** caption だけは {text: string} で入れる（他は該当スキーマそのもの） */
    data: jsonb('data'),
    /** ETag の実体。書くたびに +1 し、If-Match の突き合わせに使う */
    rev: integer('rev').notNull().default(1),
    /** 内容のハッシュ。ワーカーがローカルのファイルと突き合わせて「変わったか」を見る */
    hash: text('hash').notNull(),
    /** cloud（画面から） | worker（PC から） */
    updatedBy: text('updated_by').notNull().default('cloud'),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [primaryKey({columns: [t.slug, t.name]})],
);

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  type: text('type').notNull(),
  params: jsonb('params').notNull().default({}),
  /** queued | running | done | failed | cancelled */
  status: text('status').notNull().default('queued'),
  progress: jsonb('progress').$type<{phase: string; done: number; total: number}>(),
  result: jsonb('result'),
  error: text('error'),
  /** 画面が「これ以降のログをくれ」と言うための連番。job_logs.seq の最大値 */
  logSeq: integer('log_seq').notNull().default(0),
  /** 画面から中断が押された。ワーカーが進捗報告のたびに見て自分で止める */
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  startedAt: timestamp('started_at', {withTimezone: true}),
  endedAt: timestamp('ended_at', {withTimezone: true}),
  /** ワーカーが取得した時刻。一定時間更新が無ければ取りこぼしとみなして queued に戻す */
  claimedAt: timestamp('claimed_at', {withTimezone: true}),
  heartbeatAt: timestamp('heartbeat_at', {withTimezone: true}),
});

export const jobLogs = pgTable(
  'job_logs',
  {
    jobId: text('job_id').notNull(),
    seq: integer('seq').notNull(),
    line: text('line').notNull(),
  },
  (t) => [primaryKey({columns: [t.jobId, t.seq]})],
);

/**
 * Blob に上がっているメディアの索引。URL は `/p/<slug>/<mode>/<kind>/<relPath>` で引かれ、
 * 実体（Blob）へ 307 で飛ばす。mode=full が無ければ light にフォールバックする
 * （原本 4K は上げないので、素材は実質 light しか存在しない）。
 */
export const assets = pgTable(
  'assets',
  {
    slug: text('slug').notNull(),
    /** uploads | studio | out | qc | narration */
    kind: text('kind').notNull(),
    /** full | light */
    mode: text('mode').notNull().default('full'),
    relPath: text('rel_path').notNull(),
    url: text('url').notNull(),
    bytes: integer('bytes').notNull().default(0),
    hash: text('hash').notNull().default(''),
    contentType: text('content_type'),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [primaryKey({columns: [t.slug, t.kind, t.mode, t.relPath]})],
);

/** 人格。ローカルの ~/.reel-studio/personas.json をワーカーが同期する */
export const personas = pgTable('personas', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
});

/**
 * 小さな単発の値。
 * - `worker` … ワーカーの死活と環境（node / ffmpeg / claude / tts）。GET /api/config が読む
 * - `settings` … ワーカーが送る settingsView（鍵の値は入らない）
 * - `active-slug` … ?p= 無しで開いたタブの既定
 */
export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
});
