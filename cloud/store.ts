// クラウド版のデータ操作。ルータはここだけを呼ぶ（SQL をルータに散らかさない）。
//
// ローカル版との対応:
//   core/project.ts:listProjects / projectInfo  →  listProjects / projectInfo
//   server/routes/files.ts の GET/PUT           →  readDoc / writeDoc（ETag は rev-hash）
//   server/jobs.ts の JobQueue                  →  addJob / listJobs / …（実行は PC ワーカー）
import {randomUUID} from 'node:crypto';
import {and, asc, desc, eq, gt, inArray, isNull, or, sql} from 'drizzle-orm';
import {assertMetadataOnly, isLocalMediaPath} from '../shared/media';
import {stableHash} from '../shared/hash';
import {CONTRACT_FILES, DOC_NAMES, parseProjectMeta, withArchived, type DocName, type ProjectInfo, type ProjectMeta} from '../shared/project';
import {isReferencePresent} from '../shared/reference';
import {canStartJob, type JobType} from '../shared/jobs';
import {db, rowsOf} from './db/client';
import {assets, docs, jobLogs, jobs, kv, personas, projects, type ProjectSnapshot} from './db/schema';
import {REEL_DOC_NAMES, updateReelBundle, type ReelDocName} from '../shared/reel-bundle';
import {ReelCutsSchema} from '../shared/schema/reel-cuts';

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

const docColumns = {name: docs.name, data: docs.data, rev: docs.rev, hash: docs.hash, updatedBy: docs.updatedBy, updatedAt: docs.updatedAt};
export const readDocVersion = async (slug: string, name: DocName): Promise<string | null> => {
  const [row] = await db().select({rev: docs.rev, hash: docs.hash}).from(docs).where(and(eq(docs.slug, slug), eq(docs.name, name))).limit(1);
  return row ? docEtag(row.rev, row.hash) : null;
};

export const readDoc = async (slug: string, name: DocName): Promise<DocRow | null> => {
  const [row] = await db().select(docColumns).from(docs).where(and(eq(docs.slug, slug), eq(docs.name, name))).limit(1);
  if (!row) return null;
  return {name, data: row.data, rev: row.rev, hash: row.hash, etag: docEtag(row.rev, row.hash), updatedBy: row.updatedBy, updatedAt: new Date(row.updatedAt).toISOString()};
};

export const readDocs = async (slug: string, known: Record<string, string> = {}): Promise<DocRow[]> => {
  const matches = Object.entries(known).filter(([name, hash]) => isDocName(name) && typeof hash === 'string').map(([name, hash]) => and(eq(docs.name, name), eq(docs.hash, hash))!);
  // CASE を DB で評価する。本文を取得してから JS で捨てると Egress は減らない。
  const data = matches.length ? sql`CASE WHEN ${or(...matches)} THEN NULL ELSE ${docs.data} END` : docs.data;
  const rows = await db().select({...docColumns, data}).from(docs).where(eq(docs.slug, slug));
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

export type WriteDocResult = {ok: true; etag: string; rev: number; hash: string; relatedEtags?: Record<string, {before: string | null; after: string}>} | {ok: false; conflict: DocRow};

/**
 * 契約ファイルを書く。expectRev を渡すと、その版から進んでいたら 409 相当（conflict）にする。
 * 1 文の UPSERT なので、同時に 2 つ来ても片方しか通らない。
 */
export const writeDoc = async (slug: string, name: DocName, data: unknown, opt: {expectRev?: number | null; by: Actor}): Promise<WriteDocResult> => {
  assertMetadataOnly(data);
  if (name === 'reelCuts' || (opt.by === 'cloud' && (REEL_DOC_NAMES as readonly string[]).includes(name) && await readDocVersion(slug, 'reelCuts'))) {
    return writeReelDoc(slug, name as ReelDocName, data, opt);
  }
  const hash = stableHash(data);
  const expect = opt.expectRev ?? null;
  const rows = rowsOf<{rev: number; hash: string}>(
    await db().execute(sql`
    INSERT INTO docs (slug, name, data, rev, hash, updated_by, updated_at)
    VALUES (${slug}, ${name}, ${JSON.stringify(data)}::jsonb, 1, ${hash}, ${opt.by}, now())
    ON CONFLICT (slug, name) DO UPDATE
      SET data = EXCLUDED.data, rev = docs.rev + 1, hash = EXCLUDED.hash, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE ${expect}::int IS NULL OR docs.rev = ${expect}::int
    RETURNING rev, hash
  `),
  );
  const row = rows[0];
  if (!row) {
    const current = await readDoc(slug, name);
    // WHERE が外れた＝誰かが先に書いた。現在値を返して画面に選ばせる
    return {ok: false, conflict: current!};
  }
  await touchProject(slug);
  return {ok: true, etag: docEtag(row.rev, row.hash), rev: row.rev, hash: row.hash};
};

/** Serialize the common array and its compatibility views in one transaction. */
const writeReelDoc = async (slug: string, name: ReelDocName, input: unknown, opt: {expectRev?: number | null; by: Actor}): Promise<WriteDocResult> => db().transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`reel-cuts:${slug}`}))`);
  const rows = await tx.select(docColumns).from(docs).where(and(eq(docs.slug, slug), inArray(docs.name, [...REEL_DOC_NAMES]))).for('update');
  const current = rows.find((r) => r.name === name);
  if (opt.expectRev !== undefined && opt.expectRev !== null && current && current.rev !== opt.expectRev) {
    return {ok: false, conflict: {name, data: current.data, rev: current.rev, hash: current.hash, etag: docEtag(current.rev, current.hash), updatedBy: current.updatedBy, updatedAt: new Date(current.updatedAt).toISOString()}};
  }
  const data = name === 'reelCuts' ? ReelCutsSchema.parse(input).map((c) => ({...c, id: c.id ?? randomUUID()})) : input;
  const bundle = updateReelBundle(name, data, Object.fromEntries(rows.map((r) => [r.name, r.data])));
  for (const key of REEL_DOC_NAMES) {
    const value = bundle[key];
    assertMetadataOnly(value);
    const hash = stableHash(value);
    await tx.execute(sql`
      INSERT INTO docs (slug, name, data, rev, hash, updated_by, updated_at)
      VALUES (${slug}, ${key}, ${JSON.stringify(value)}::jsonb, 1, ${hash}, ${opt.by}, now())
      ON CONFLICT (slug, name) DO UPDATE SET data = EXCLUDED.data, rev = docs.rev + 1,
        hash = EXCLUDED.hash, updated_by = EXCLUDED.updated_by, updated_at = now()
    `);
  }
  await tx.update(projects).set({updatedAt: new Date()}).where(eq(projects.slug, slug));
  const rev = (current?.rev ?? 0) + 1;
  const hash = stableHash(bundle[name]);
  const relatedEtags = Object.fromEntries(REEL_DOC_NAMES.map(key => {
    const old = rows.find(r => r.name === key);
    return [key, {before: old ? docEtag(old.rev, old.hash) : null, after: docEtag((old?.rev ?? 0) + 1, stableHash(bundle[key]))}];
  }));
  return {ok: true, rev, hash, etag: docEtag(rev, hash), relatedEtags};
});

export const deleteDocs = async (slug: string): Promise<void> => {
  await db().delete(docs).where(eq(docs.slug, slug));
};

/** Import media and its initial timeline together, preserving edits on any conflict. */
export async function writeModalMedia(slug: string, catalog: unknown, cuts: unknown, expected: {catalogEtag?: string | null; cutsEtag?: string | null}): Promise<boolean> {
  class Conflict extends Error {}
  try {
    return await db().transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`reel-cuts:${slug}`}))`);
      const rows = await tx.select(docColumns).from(docs).where(and(eq(docs.slug, slug), inArray(docs.name, ['catalog', ...REEL_DOC_NAMES]))).for('update');
      const before = (name: string) => rows.find(r => r.name === name);
      const etag = (name: string) => {const row = before(name); return row ? docEtag(row.rev, row.hash) : null;};
      if (etag('catalog') !== expected.catalogEtag || etag('cuts') !== expected.cutsEtag) return false;
      const values: Record<string, unknown> = {catalog, cuts};
      if (before('reelCuts')) Object.assign(values, updateReelBundle('cuts', cuts, Object.fromEntries(rows.map(r => [r.name, r.data]))));
      for (const [name, data] of Object.entries(values)) {
        assertMetadataOnly(data);
        const hash = stableHash(data), rev = before(name)?.rev ?? 0;
        const written = rowsOf(await tx.execute(sql`
          INSERT INTO docs (slug, name, data, rev, hash, updated_by, updated_at)
          VALUES (${slug}, ${name}, ${JSON.stringify(data)}::jsonb, 1, ${hash}, 'cloud', now())
          ON CONFLICT (slug, name) DO UPDATE SET data = EXCLUDED.data, rev = docs.rev + 1,
            hash = EXCLUDED.hash, updated_by = EXCLUDED.updated_by, updated_at = now()
            WHERE docs.rev = ${rev}
          RETURNING rev
        `));
        if (!written.length) throw new Conflict();
      }
      await tx.update(projects).set({updatedAt: new Date()}).where(eq(projects.slug, slug));
      return true;
    });
  } catch (e) {if (e instanceof Conflict) return false; throw e;}
}

// ───────────────────────── 案件 ─────────────────────────

const projectColumns = {slug: projects.slug, persona: projects.persona, shopName: projects.shopName, format: projects.format, info: projects.info, createdAt: projects.createdAt, updatedAt: projects.updatedAt, deletedAt: projects.deletedAt};

const EMPTY_SNAPSHOT: ProjectSnapshot = {dir: '', engine: {stale: true, family: 'unknown', files: []}, nodeModules: false, out: {draft: false, final: false, narration: false}};

const toProjectInfo = (row: typeof projects.$inferSelect, docRows: {name: string; updatedAt: Date}[], meta?: ProjectMeta | null, reference = false): ProjectInfo => {
  const info = row.info ?? EMPTY_SNAPSHOT;
  const names = new Set(docRows.map((d) => d.name));
  const times = [new Date(row.updatedAt).getTime(), ...docRows.map((d) => new Date(d.updatedAt).getTime())];
  return {
    slug: row.slug,
    dir: info.dir || '',
    has: {catalog: names.has('catalog'), brief: names.has('brief'), cuts: names.has('cuts'), narration: names.has('narration'), reference},
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
  const rows = await db().select(projectColumns).from(projects).where(isNull(projects.deletedAt));
  if (!rows.length) return [];
  const slugs = rows.map((r) => r.slug);
  const docRows = await db().select({slug: docs.slug, name: docs.name, updatedAt: docs.updatedAt}).from(docs).where(inArray(docs.slug, slugs));
  // 一覧から隠したかどうか・参考動画があるか。data を引くのはこの 2 つの doc だけにする
  // （catalog や cuts を一覧のたびに持ってこない。reference は墓標＝source: null を「無い」と数えるため中身が要る）
  const smallRows = await db()
    .select({slug: docs.slug, name: docs.name, data: sql`CASE WHEN ${docs.name} = 'reference' THEN jsonb_build_object('source', ${docs.data}->'source') ELSE jsonb_build_object('archivedAt', ${docs.data}->'archivedAt') END`})
    .from(docs)
    .where(and(inArray(docs.name, ['meta', 'reference']), inArray(docs.slug, slugs)));
  const metaBySlug = new Map(smallRows.filter((m) => m.name === 'meta').map((m) => [m.slug, parseProjectMeta(m.data)]));
  const referenceBySlug = new Set(smallRows.filter((m) => m.name === 'reference' && isReferencePresent(m.data)).map((m) => m.slug));
  const bySlug = new Map<string, {name: string; updatedAt: Date}[]>();
  for (const d of docRows) bySlug.set(d.slug, [...(bySlug.get(d.slug) ?? []), {name: d.name, updatedAt: d.updatedAt}]);
  return rows.map((r) => toProjectInfo(r, bySlug.get(r.slug) ?? [], metaBySlug.get(r.slug), referenceBySlug.has(r.slug))).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
};

export const projectInfo = async (slug: string): Promise<ProjectInfo | null> => {
  const [row] = await db().select(projectColumns).from(projects).where(eq(projects.slug, slug)).limit(1);
  if (!row || row.deletedAt) return null;
  const docRows = await db().select({name: docs.name, updatedAt: docs.updatedAt}).from(docs).where(eq(docs.slug, slug));
  const meta = await readProjectMeta(slug);
  const [referenceRow] = await db().select({present: sql<boolean>`jsonb_typeof(${docs.data}->'source') = 'object'`}).from(docs).where(and(eq(docs.slug, slug), eq(docs.name, 'reference'))).limit(1);
  const reference = referenceRow?.present === true;
  return toProjectInfo(row, docRows, meta, reference);
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

const jobColumns = {id: jobs.id, type: jobs.type, slug: jobs.slug, params: jobs.params, status: jobs.status, createdAt: jobs.createdAt, startedAt: jobs.startedAt, endedAt: jobs.endedAt, progress: jobs.progress, result: jobs.result, error: jobs.error};
const toCloudJob = (row: Pick<typeof jobs.$inferSelect, keyof typeof jobColumns>, logTail: string[] = []): CloudJob => ({
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
  assertMetadataOnly(params);
  const id = randomUUID().slice(0, 8);
  const [row] = await db().insert(jobs).values({id, slug, type, params}).returning();
  return toCloudJob(row);
};

export const listJobs = async (limit = JOB_KEEP): Promise<CloudJob[]> => {
  const rows = await db().select(jobColumns).from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
  if (!rows.length) return [];
  // 一覧に出す末尾ログ（5 行）だけまとめて引く
  const tails = await db().execute(sql`
    SELECT job_id, line FROM (
      SELECT job_id, line, row_number() OVER (PARTITION BY job_id ORDER BY seq DESC) AS rn
      FROM job_logs WHERE job_id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})
    ) t WHERE rn <= 5 ORDER BY job_id, rn DESC
  `);
  const byJob = new Map<string, string[]>();
  for (const r of rowsOf<{job_id: string; line: string}>(tails)) byJob.set(r.job_id, [...(byJob.get(r.job_id) ?? []), r.line]);
  return rows.map((r) => toCloudJob(r, byJob.get(r.id) ?? []));
};

export const getJob = async (id: string): Promise<CloudJob | null> => {
  const [row] = await db().select(jobColumns).from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ? toCloudJob(row) : null;
};

/** SSE の毎回の問い合わせは状態とログ連番だけ。詳細 JSON は変化したジョブのみ取得する。 */
export const listJobStates = async (limit = 30) => db().select({id: jobs.id, status: jobs.status, progress: jobs.progress, logSeq: jobs.logSeq}).from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);

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
  const candidates = await db().select({id: jobs.id, slug: jobs.slug, type: jobs.type}).from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.createdAt)).limit(20);
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
  assertMetadataOnly(r.result);
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
  // 生 SQL に Date をそのまま渡さない（postgres.js ドライバは timestamptz の直列化を Drizzle に任せていて、列を通らない Date は送れない）
  const limit = new Date(Date.now() - staleMs).toISOString();
  const rows = await db()
    .update(jobs)
    .set({status: 'failed', endedAt: new Date(), error: 'ワーカーとの通信が途切れました（PC が落ちた・スリープした可能性があります）'})
    .where(and(eq(jobs.status, 'running'), sql`coalesce(${jobs.heartbeatAt}, ${jobs.startedAt}) < ${limit}::timestamptz`))
    .returning({id: jobs.id});
  return rows.length;
};

// ───────────────────────── メディア索引 ─────────────────────────

export const findAsset = async (slug: string, kind: string, mode: string, relPath: string): Promise<{url: string; hash: string; bytes: number} | null> => {
  const [row] = await db()
    .select({url: assets.url, hash: assets.hash, bytes: assets.bytes})
    .from(assets)
    .where(and(eq(assets.slug, slug), eq(assets.kind, kind), eq(assets.mode, mode), eq(assets.relPath, relPath)))
    .limit(1);
  return row ?? null;
};

export const listAssets = async (slug: string): Promise<{kind: string; mode: string; relPath: string; hash: string; bytes: number; url: string}[]> =>
  db().select({kind: assets.kind, mode: assets.mode, relPath: assets.relPath, hash: assets.hash, bytes: assets.bytes, url: assets.url}).from(assets).where(eq(assets.slug, slug));

export const putAsset = async (a: {slug: string; kind: string; mode: string; relPath: string; url: string; bytes: number; hash: string; contentType: string}): Promise<void> => {
  if (!isLocalMediaPath(a.url)) throw new Error('メディアには絶対ローカルパスが必要です');
  await db()
    .insert(assets)
    .values(a)
    .onConflictDoUpdate({
      target: [assets.slug, assets.kind, assets.mode, assets.relPath],
      set: {url: a.url, bytes: a.bytes, hash: a.hash, contentType: a.contentType, updatedAt: new Date()},
    });
};

export const deleteAssets = async (slug: string): Promise<string[]> => {
  const rows = await db().delete(assets).where(eq(assets.slug, slug)).returning({url: assets.url});
  return rows.map((r) => r.url);
};

// ───────────────────────── 人格・単発の値 ─────────────────────────

export const listPersonaRows = async (): Promise<unknown[]> => (await db().select({data: personas.data}).from(personas)).map((r) => r.data);

export const replacePersonas = async (list: {id: string; data: unknown}[]): Promise<void> => {
  for (const item of list) assertMetadataOnly(item.data);
  await db().delete(personas);
  if (list.length) await db().insert(personas).values(list.map((p) => ({id: p.id, data: p.data as object})));
};

export const kvGet = async <T>(key: string): Promise<T | null> => {
  const [row] = await db().select({data: kv.data}).from(kv).where(eq(kv.key, key)).limit(1);
  return (row?.data as T) ?? null;
};

export const kvSet = async (key: string, data: unknown): Promise<void> => {
  assertMetadataOnly(data);
  await db()
    .insert(kv)
    .values({key, data: data as object})
    .onConflictDoUpdate({target: kv.key, set: {data: data as object, updatedAt: new Date()}});
};

export {CONTRACT_FILES, DOC_NAMES};
