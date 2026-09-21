// クラウド版のデータ操作。ルータはここだけを呼ぶ（SQL をルータに散らかさない）。
//
// ローカル版との対応:
//   core/project.ts:listProjects / projectInfo  →  listProjects / projectInfo
//   server/routes/files.ts の GET/PUT           →  readDoc / writeDoc（ETag は rev-hash）
//   server/jobs.ts の JobQueue                  →  addJob / listJobs / …（実行は PC ワーカー）
import {randomUUID} from 'node:crypto';
import {and, asc, desc, eq, gt, inArray, isNull, sql} from 'drizzle-orm';
import {stableHash} from '../shared/hash';
import {CONTRACT_FILES, DOC_NAMES, parseProjectMeta, withArchived, type DocName, type ProjectInfo, type ProjectMeta} from '../shared/project';
import {canStartJob, type JobType} from '../shared/jobs';
import {db} from './db/client';
import {assets, docs, jobLogs, jobs, kv, personas, projects, type ProjectSnapshot} from './db/schema';

export type Actor = 'cloud' | 'worker';

/** 画面が受け取るジョブの形（server/jobs.ts の publicJob と同じ） */
export type CloudJob = {
  id: string;
  type: string;
  slug: string;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  progress?: {phase: string; done: number; total: number};
  logTail?: string[];
  result?: Record<string, unknown>;
  error?: string;
};

const iso = (d: Date | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);

// ───────────────────────── 契約ファイル ─────────────────────────

/** ETag。rev が本体で、hash は「中身が本当に変わったか」をワーカーが見るために付ける */
export const docEtag = (rev: number, hash: string): string => `${rev}-${hash}`;
export const revOfEtag = (etag: string | null | undefined): number | null => {
  const m = /^(\d+)-/.exec(etag ?? '');
  return m ? Number(m[1]) : null;
};

export const isDocName = (v: string): v is DocName => (DOC_NAMES as readonly string[]).includes(v);

export type DocRow = {name: DocName; data: unknown; rev: number; hash: string; etag: string; updatedBy: string; updatedAt: string};

export const readDoc = async (slug: string, name: DocName): Promise<DocRow | null> => {
  const [row] = await db().select().from(docs).where(and(eq(docs.slug, slug), eq(docs.name, name))).limit(1);
  if (!row) return null;
  return {name, data: row.data, rev: row.rev, hash: row.hash, etag: docEtag(row.rev, row.hash), updatedBy: row.updatedBy, updatedAt: new Date(row.updatedAt).toISOString()};
};

export const readDocs = async (slug: string): Promise<DocRow[]> => {
  const rows = await db().select().from(docs).where(eq(docs.slug, slug));
  return rows.map((r) => ({
    name: r.name as DocName,
    data: r.data,
    rev: r.rev,
    hash: r.hash,
    etag: docEtag(r.rev, r.hash),
    updatedBy: r.updatedBy,
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
};

export type WriteDocResult = {ok: true; etag: string; rev: number; hash: string} | {ok: false; conflict: DocRow};

/**
 * 契約ファイルを書く。expectRev を渡すと、その版から進んでいたら 409 相当（conflict）にする。
 * 1 文の UPSERT なので、同時に 2 つ来ても片方しか通らない。
 */
export const writeDoc = async (slug: string, name: DocName, data: unknown, opt: {expectRev?: number | null; by: Actor}): Promise<WriteDocResult> => {
  const hash = stableHash(data);
  const expect = opt.expectRev ?? null;
  const rows = (await db().execute(sql`
    INSERT INTO docs (slug, name, data, rev, hash, updated_by, updated_at)
    VALUES (${slug}, ${name}, ${JSON.stringify(data)}::jsonb, 1, ${hash}, ${opt.by}, now())
    ON CONFLICT (slug, name) DO UPDATE
      SET data = EXCLUDED.data, rev = docs.rev + 1, hash = EXCLUDED.hash, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE ${expect}::int IS NULL OR docs.rev = ${expect}::int
    RETURNING rev, hash
  `)) as unknown as {rows: {rev: number; hash: string}[]};
  const row = rows.rows?.[0];
  if (!row) {
    const current = await readDoc(slug, name);
    // WHERE が外れた＝誰かが先に書いた。現在値を返して画面に選ばせる
    return {ok: false, conflict: current!};
  }
  await touchProject(slug);
  return {ok: true, etag: docEtag(row.rev, row.hash), rev: row.rev, hash: row.hash};
};

export const deleteDocs = async (slug: string): Promise<void> => {
  await db().delete(docs).where(eq(docs.slug, slug));
};

// ───────────────────────── 案件 ─────────────────────────

const EMPTY_SNAPSHOT: ProjectSnapshot = {dir: '', engine: {stale: true, family: 'unknown', files: []}, nodeModules: false, out: {draft: false, final: false, narration: false}};

const toProjectInfo = (row: typeof projects.$inferSelect, docRows: {name: string; updatedAt: Date}[], meta?: ProjectMeta | null): ProjectInfo => {
  const info = row.info ?? EMPTY_SNAPSHOT;
  const names = new Set(docRows.map((d) => d.name));
  const times = [new Date(row.updatedAt).getTime(), ...docRows.map((d) => new Date(d.updatedAt).getTime())];
  return {
    slug: row.slug,
    dir: info.dir || '',
    has: {catalog: names.has('catalog'), brief: names.has('brief'), cuts: names.has('cuts'), narration: names.has('narration')},
    out: info.out ?? EMPTY_SNAPSHOT.out,
    engine: info.engine ?? EMPTY_SNAPSHOT.engine,
    nodeModules: info.nodeModules ?? false,
    updatedAt: new Date(Math.max(...times)).toISOString(),
    persona: (row.persona ?? undefined) as ProjectInfo['persona'],
    format: row.format ?? undefined,
    archivedAt: meta?.archivedAt ?? undefined,
  };
};

export const listProjects = async (): Promise<ProjectInfo[]> => {
  const rows = await db().select().from(projects).where(isNull(projects.deletedAt));
  if (!rows.length) return [];
  const slugs = rows.map((r) => r.slug);
  const docRows = await db().select({slug: docs.slug, name: docs.name, updatedAt: docs.updatedAt}).from(docs).where(inArray(docs.slug, slugs));
  // 一覧から隠したかどうか。data を引くのはこの doc だけにする（catalog や cuts を一覧のたびに持ってこない）
  const metaRows = await db().select({slug: docs.slug, data: docs.data}).from(docs).where(and(eq(docs.name, 'meta'), inArray(docs.slug, slugs)));
  const metaBySlug = new Map(metaRows.map((m) => [m.slug, parseProjectMeta(m.data)]));
  const bySlug = new Map<string, {name: string; updatedAt: Date}[]>();
  for (const d of docRows) bySlug.set(d.slug, [...(bySlug.get(d.slug) ?? []), {name: d.name, updatedAt: d.updatedAt}]);
  return rows.map((r) => toProjectInfo(r, bySlug.get(r.slug) ?? [], metaBySlug.get(r.slug))).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
};

export const projectInfo = async (slug: string): Promise<ProjectInfo | null> => {
  const [row] = await db().select().from(projects).where(eq(projects.slug, slug)).limit(1);
  if (!row || row.deletedAt) return null;
  const docRows = await db().select({name: docs.name, updatedAt: docs.updatedAt}).from(docs).where(eq(docs.slug, slug));
  const meta = await readProjectMeta(slug);
  return toProjectInfo(row, docRows, meta);
};

// ── 一覧から隠す／戻す ──
// ローカル版の .studio/meta.json と同じものを docs に持つ。ワーカーの同期が双方向に流すので、
// PC で隠せばスマホでも、スマホで隠せば PC でも隠れる。

export const readProjectMeta = async (slug: string): Promise<ProjectMeta> => parseProjectMeta((await readDoc(slug, 'meta'))?.data);

export const setProjectArchived = async (slug: string, archived: boolean): Promise<ProjectMeta> => {
  const next = withArchived(await readProjectMeta(slug), archived);
  await writeDoc(slug, 'meta', next, {by: 'cloud'});
  return next;
};

export const upsertProject = async (slug: string, patch: {persona?: string | null; shopName?: string | null; format?: string | null; info?: ProjectSnapshot}): Promise<void> => {
  await db()
    .insert(projects)
    .values({slug, persona: patch.persona ?? null, shopName: patch.shopName ?? null, format: patch.format ?? null, info: patch.info ?? null})
    .onConflictDoUpdate({
      target: projects.slug,
      set: {
        // 明示的に渡ったものだけ更新する（ワーカーの info 報告で persona を消さない）
        ...(patch.persona !== undefined ? {persona: patch.persona} : {}),
        ...(patch.shopName !== undefined ? {shopName: patch.shopName} : {}),
        ...(patch.format !== undefined ? {format: patch.format} : {}),
        ...(patch.info !== undefined ? {info: patch.info} : {}),
        updatedAt: new Date(),
        deletedAt: null,
      },
    });
};

const touchProject = async (slug: string): Promise<void> => {
  await db().update(projects).set({updatedAt: new Date()}).where(eq(projects.slug, slug));
};

export const softDeleteProject = async (slug: string): Promise<void> => {
  await db().update(projects).set({deletedAt: new Date()}).where(eq(projects.slug, slug));
};

// ───────────────────────── ジョブ ─────────────────────────

const toCloudJob = (row: typeof jobs.$inferSelect, logTail: string[] = []): CloudJob => ({
  id: row.id,
  type: row.type,
  slug: row.slug,
  params: (row.params ?? {}) as Record<string, unknown>,
  status: row.status as CloudJob['status'],
  createdAt: new Date(row.createdAt).toISOString(),
  startedAt: iso(row.startedAt),
  endedAt: iso(row.endedAt),
  progress: row.progress ?? undefined,
  result: (row.result ?? undefined) as Record<string, unknown> | undefined,
  error: row.error ?? undefined,
  logTail,
});

const JOB_KEEP = 50;

export const addJob = async (type: JobType, slug: string, params: Record<string, unknown> = {}): Promise<CloudJob> => {
  const id = randomUUID().slice(0, 8);
  const [row] = await db().insert(jobs).values({id, slug, type, params}).returning();
  return toCloudJob(row);
};

export const listJobs = async (limit = JOB_KEEP): Promise<CloudJob[]> => {
  const rows = await db().select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
  if (!rows.length) return [];
  // 一覧に出す末尾ログ（5 行）だけまとめて引く
  const tails = await db().execute(sql`
    SELECT job_id, line FROM (
      SELECT job_id, line, row_number() OVER (PARTITION BY job_id ORDER BY seq DESC) AS rn
      FROM job_logs WHERE job_id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})
    ) t WHERE rn <= 5 ORDER BY job_id, rn DESC
  `);
  const byJob = new Map<string, string[]>();
  for (const r of (tails as unknown as {rows: {job_id: string; line: string}[]}).rows ?? []) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r.line]);
  return rows.map((r) => toCloudJob(r, byJob.get(r.id) ?? []));
};

export const getJob = async (id: string): Promise<CloudJob | null> => {
  const [row] = await db().select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ? toCloudJob(row) : null;
};

export const jobLogLines = async (id: string, since = 0): Promise<{lines: string[]; seq: number}> => {
  const rows = await db()
    .select({seq: jobLogs.seq, line: jobLogs.line})
    .from(jobLogs)
    .where(and(eq(jobLogs.jobId, id), gt(jobLogs.seq, since)))
    .orderBy(asc(jobLogs.seq))
    .limit(2000);
  return {lines: rows.map((r) => r.line), seq: rows.length ? rows[rows.length - 1].seq : since};
};

/** 画面の「中断」。実際に止めるのはワーカー（進捗報告のたびに cancelRequested を見る） */
export const requestCancel = async (id: string): Promise<boolean> => {
  const rows = await db().update(jobs).set({cancelRequested: true}).where(eq(jobs.id, id)).returning({id: jobs.id, status: jobs.status});
  if (!rows.length) return false;
  // まだ動き出していないものはその場で終わらせる
  if (rows[0].status === 'queued') await db().update(jobs).set({status: 'cancelled', endedAt: new Date()}).where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
  return true;
};

/** ジョブ履歴の刈り込み（古いものからログごと消す） */
export const pruneJobs = async (keep = JOB_KEEP * 4): Promise<void> => {
  await db().execute(sql`
    WITH old AS (SELECT id FROM jobs ORDER BY created_at DESC OFFSET ${keep}),
         l AS (DELETE FROM job_logs WHERE job_id IN (SELECT id FROM old))
    DELETE FROM jobs WHERE id IN (SELECT id FROM old)
  `);
};

// ───────────────────────── ワーカーとのやり取り ─────────────────────────

/**
 * ワーカーが「いま始められるジョブ」を 1 つ取る。
 * 同時実行の可否は **ローカル版と同じ `canStartJob`**（shared/jobs.ts）で判定する。
 * 取得は `WHERE status='queued'` 付きの UPDATE なので、二重取得は起きない。
 */
export const claimJob = async (running: {slug: string; type: string}[], maxConcurrent: number): Promise<CloudJob | null> => {
  const candidates = await db().select().from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.createdAt)).limit(20);
  for (const c of candidates) {
    if (!canStartJob({slug: c.slug, type: c.type}, running, maxConcurrent)) continue;
    const [row] = await db()
      .update(jobs)
      .set({status: 'running', startedAt: new Date(), claimedAt: new Date(), heartbeatAt: new Date()})
      .where(and(eq(jobs.id, c.id), eq(jobs.status, 'queued')))
      .returning();
    if (row) return toCloudJob(row);
  }
  return null;
};

export type ProgressReport = {progress?: {phase: string; done: number; total: number}; lines?: string[]};

/** 進捗・ログの報告。返り値の cancelRequested が true ならワーカーは自分で中断する */
export const reportProgress = async (id: string, r: ProgressReport): Promise<{cancelRequested: boolean}> => {
  const lines = (r.lines ?? []).filter((l) => typeof l === 'string');
  const [row] = await db()
    .update(jobs)
    .set({heartbeatAt: new Date(), ...(r.progress ? {progress: r.progress} : {}), ...(lines.length ? {logSeq: sql`${jobs.logSeq} + ${lines.length}`} : {})})
    .where(eq(jobs.id, id))
    .returning({logSeq: jobs.logSeq, cancelRequested: jobs.cancelRequested});
  if (!row) return {cancelRequested: false};
  if (lines.length) {
    const first = row.logSeq - lines.length + 1;
    await db()
      .insert(jobLogs)
      .values(lines.map((line, i) => ({jobId: id, seq: first + i, line})))
      .onConflictDoNothing();
  }
  return {cancelRequested: row.cancelRequested};
};

export const finishJob = async (id: string, r: {status: 'done' | 'failed' | 'cancelled'; result?: unknown; error?: string}): Promise<void> => {
  await db()
    .update(jobs)
    .set({status: r.status, endedAt: new Date(), result: (r.result ?? null) as object | null, error: r.error ?? null})
    .where(eq(jobs.id, id));
};

/**
 * ワーカーが落ちて放置された running を失敗にする。
 * 再実行にしないのは、レンダーのような重い処理が勝手に走り直すと分かりにくいため
 * （画面から押し直せばよい）。
 */
export const failStaleJobs = async (staleMs = 5 * 60_000): Promise<number> => {
  const limit = new Date(Date.now() - staleMs);
  const rows = await db()
    .update(jobs)
    .set({status: 'failed', endedAt: new Date(), error: 'ワーカーとの通信が途切れました（PC が落ちた・スリープした可能性があります）'})
    .where(and(eq(jobs.status, 'running'), sql`coalesce(${jobs.heartbeatAt}, ${jobs.startedAt}) < ${limit}`))
    .returning({id: jobs.id});
  return rows.length;
};

// ───────────────────────── メディア索引 ─────────────────────────

export const findAsset = async (slug: string, kind: string, mode: string, relPath: string): Promise<{url: string} | null> => {
  const [row] = await db()
    .select({url: assets.url})
    .from(assets)
    .where(and(eq(assets.slug, slug), eq(assets.kind, kind), eq(assets.mode, mode), eq(assets.relPath, relPath)))
    .limit(1);
  return row ?? null;
};

export const listAssets = async (slug: string): Promise<{kind: string; mode: string; relPath: string; hash: string; bytes: number}[]> =>
  db().select({kind: assets.kind, mode: assets.mode, relPath: assets.relPath, hash: assets.hash, bytes: assets.bytes}).from(assets).where(eq(assets.slug, slug));

export const putAsset = async (a: {slug: string; kind: string; mode: string; relPath: string; url: string; bytes: number; hash: string; contentType: string}): Promise<{replacedUrl: string | null}> => {
  const prev = await findAsset(a.slug, a.kind, a.mode, a.relPath);
  await db()
    .insert(assets)
    .values(a)
    .onConflictDoUpdate({
      target: [assets.slug, assets.kind, assets.mode, assets.relPath],
      set: {url: a.url, bytes: a.bytes, hash: a.hash, contentType: a.contentType, updatedAt: new Date()},
    });
  return {replacedUrl: prev && prev.url !== a.url ? prev.url : null};
};

export const deleteAssets = async (slug: string): Promise<string[]> => {
  const rows = await db().delete(assets).where(eq(assets.slug, slug)).returning({url: assets.url});
  return rows.map((r) => r.url);
};

// ───────────────────────── 人格・単発の値 ─────────────────────────

export const listPersonaRows = async (): Promise<unknown[]> => (await db().select({data: personas.data}).from(personas)).map((r) => r.data);

export const replacePersonas = async (list: {id: string; data: unknown}[]): Promise<void> => {
  await db().delete(personas);
  if (list.length) await db().insert(personas).values(list.map((p) => ({id: p.id, data: p.data as object})));
};

export const kvGet = async <T>(key: string): Promise<T | null> => {
  const [row] = await db().select({data: kv.data}).from(kv).where(eq(kv.key, key)).limit(1);
  return (row?.data as T) ?? null;
};

export const kvSet = async (key: string, data: unknown): Promise<void> => {
  await db()
    .insert(kv)
    .values({key, data: data as object})
    .onConflictDoUpdate({target: kv.key, set: {data: data as object, updatedAt: new Date()}});
};

export {CONTRACT_FILES, DOC_NAMES};
