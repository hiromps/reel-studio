import {Router, type Request, type Response} from 'express';
import {jobs, JOB_TYPES, type JobType} from '../jobs';
import {PROJECTLESS_JOBS} from '../../shared/jobs';
import {state} from '../state';
import {watcher} from '../watch';

export const jobsRouter = Router();

const isJobType = (v: unknown): v is JobType => typeof v === 'string' && (JOB_TYPES as readonly string[]).includes(v);

jobsRouter.get('/', (_req, res) => res.json(jobs.list()));

jobsRouter.post('/', (req, res) => {
  const {type, slug, params} = req.body ?? {};
  if (!isJobType(type))
    return res.status(400).json({error: `この機能は起動中のサーバーにありません（画面だけ新しい状態です）。Reel Studio を再起動してください。\n  受け付けられる type: ${JOB_TYPES.join('|')}`});
  const target = slug ?? state.activeSlug ?? (PROJECTLESS_JOBS.has(type) ? '_studio' : null);
  if (!target) return res.status(400).json({error: 'slug が無い（active project も未設定）'});
  const job = jobs.add(type, target, params ?? {});
  res.json(jobs.publicJob(job));
});

jobsRouter.get('/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({error: 'job が無い'});
  res.json({...j});
});

jobsRouter.post('/:id/cancel', (req, res) => {
  res.json({ok: jobs.cancel(req.params.id)});
});

/** SSE: job:log / job:progress / job:done / file:changed */
export const eventsHandler = (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', {activeSlug: state.activeSlug});
  const onLog = (d: unknown) => send('job:log', d);
  const onProgress = (d: unknown) => send('job:progress', d);
  const onJob = (d: unknown) => send('job:update', d);
  const onFile = (d: unknown) => send('file:changed', d);
  jobs.on('log', onLog);
  jobs.on('progress', onProgress);
  jobs.on('job', onJob);
  watcher.on('changed', onFile);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    jobs.off('log', onLog);
    jobs.off('progress', onProgress);
    jobs.off('job', onJob);
    watcher.off('changed', onFile);
  });
};
