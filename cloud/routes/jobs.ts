// ジョブの投入・一覧・中断と、画面への通知（SSE）。
//
// ローカル版は EventEmitter をそのまま SSE に流すが、クラウドでは実行しているのが別のマシン（PC）なので、
// この接続が DB を一定間隔で見て差分を流す。Vercel の Function には実行時間の上限があるので
// 55 秒で自分から閉じる —— EventSource は自動で繋ぎ直し、`hello` を受けた画面が
// 取りこぼしたジョブを取り直す（src/state/store.tsx の実装がそうなっている）。
import {Router, type Request, type Response} from 'express';
import {JOB_TYPES, PROJECTLESS_JOBS, type JobType} from '../../shared/jobs';
import {normalizeSlug} from '../../shared/project';
import {addJob, failStaleJobs, getJob, jobLogLines, kvGet, listJobs, requestCancel, type CloudJob} from '../store';
import {docsChangedSince} from '../events-source';

export const jobsRouter = Router();

const isJobType = (v: unknown): v is JobType => typeof v === 'string' && (JOB_TYPES as readonly string[]).includes(v);

jobsRouter.get('/', async (_req, res) => {
  res.json(await listJobs());
});

jobsRouter.post('/', async (req, res) => {
  const {type, slug, params} = req.body ?? {};
  if (!isJobType(type)) return res.status(400).json({error: `知らないジョブです。\n  受け付けられる type: ${JOB_TYPES.join('|')}`});
  const active = (await kvGet<{slug: string | null}>('active-slug'))?.slug ?? null;
  const target = slug ? normalizeSlug(String(slug)) : (active ?? (PROJECTLESS_JOBS.has(type) ? '_studio' : null));
  if (!target) return res.status(400).json({error: 'slug が無い（active project も未設定）'});
  res.json(await addJob(type, target, (params ?? {}) as Record<string, unknown>));
});

jobsRouter.get('/:id', async (req, res) => {
  const j = await getJob(req.params.id);
  if (!j) return res.status(404).json({error: 'job が無い'});
  const {lines} = await jobLogLines(req.params.id, Number(req.query.since ?? 0) || 0);
  res.json({...j, log: lines});
});

jobsRouter.post('/:id/cancel', async (req, res) => {
  res.json({ok: await requestCancel(req.params.id)});
});

// ───────────────────────── SSE ─────────────────────────

const POLL_MS = 2000;
const MAX_MS = 55_000;

const isSame = (a: CloudJob | undefined, b: CloudJob): boolean =>
  !!a && a.status === b.status && a.progress?.done === b.progress?.done && a.progress?.phase === b.progress?.phase && a.progress?.total === b.progress?.total;

export const eventsHandler = async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Vercel / プロキシ側でバッファされると届かないので明示的に切る
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const active = (await kvGet<{slug: string | null}>('active-slug'))?.slug ?? null;
  send('hello', {activeSlug: active});

  const seen = new Map<string, CloudJob>();
  const logSeq = new Map<string, number>();
  let since = new Date(Date.now() - POLL_MS);
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const startedAt = Date.now();
  // 最初の 1 周は「いまの状態」を配るだけにして、既存ジョブの通知が溢れないようにする
  let first = true;
  while (!closed && Date.now() - startedAt < MAX_MS) {
    try {
      const jobs = await listJobs(30);
      for (const j of jobs) {
        if (first) {
          seen.set(j.id, j);
          if (j.status === 'running') logSeq.set(j.id, Math.max(0, (j.logTail?.length ?? 0) > 0 ? 0 : 0));
          continue;
        }
        if (isSame(seen.get(j.id), j)) continue;
        const prev = seen.get(j.id);
        seen.set(j.id, j);
        if (prev && prev.progress && j.progress && prev.status === j.status) send('job:progress', {jobId: j.id, ...j.progress});
        send('job:update', j);
      }
      // 動いているジョブのログを流す
      for (const j of jobs) {
        if (j.status !== 'running' && j.status !== 'done' && j.status !== 'failed') continue;
        if (!logSeq.has(j.id) && j.status !== 'running') continue;
        const from = logSeq.get(j.id) ?? 0;
        const {lines, seq} = await jobLogLines(j.id, from);
        if (lines.length) {
          for (const line of lines) send('job:log', {jobId: j.id, line});
          logSeq.set(j.id, seq);
        } else if (!logSeq.has(j.id)) logSeq.set(j.id, seq);
      }
      // PC が書き戻した契約ファイルを画面に知らせる（ローカル版の chokidar と同じ役割）
      if (!first) {
        const changed = await docsChangedSince(since);
        for (const c of changed) send('file:changed', {slug: c.slug, name: c.name, etag: c.etag});
      }
      since = new Date(Date.now() - 500);
      first = false;
      res.write(': ping\n\n');
    } catch (e) {
      send('job:log', {jobId: '-', line: `（通知の取得に失敗: ${(e as Error).message}）`});
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  // 落ちたワーカーが握ったままのジョブを失敗にする（接続が切れるついでの掃除）
  try {
    await failStaleJobs();
  } catch {
    /* 掃除に失敗しても画面には影響しない */
  }
  res.end();
};
