// PC ワーカーとの窓口。**すべて発信は PC 側から**（PC のポートは開けない）。
// 認証は Authorization: Bearer <WORKER_TOKEN>（cloud/auth.ts:requireWorker）。
//
// やりとりの流れ:
//   hello   … 死活と環境を送り、Blob の書き込みトークンと「PC に反映すべき変更」を受け取る
//   claim   … いま始められるジョブを 1 つもらう
//   progress… 進捗とログを送る（返りの cancelRequested が true なら自分で中断する）
//   finish  … 結果を送る
//   docs    … 契約ファイルの取得（pull）と書き戻し（push。rev で衝突を検出）
//   assets  … 生成物（サムネ・軽量プロキシ・完成動画）の登録
import {Router} from 'express';
import type {SettingsView} from '../../shared/schema/settings';
import type {SfxLibrary} from '../../shared/sfx';
import {PersonaSchema, type Persona} from '../../shared/personas';
import {DOC_NAMES, normalizeSlug, type DocName} from '../../shared/project';
import type {BuildFacts} from '../../shared/build';
import {delBlob, isAssetKind, isAssetMode} from '../blob';
import {notifyJobFinished} from '../push';
import type {ProjectSnapshot} from '../db/schema';
import {
  claimJob,
  deleteAssets,
  finishJob,
  getJob,
  isDocName,
  kvGet,
  kvSet,
  listAssets,
  listPersonaRows,
  putAsset,
  readDocs,
  reportProgress,
  replacePersonas,
  softDeleteProject,
  upsertProject,
  writeDoc,
} from '../store';
import type {WorkerStatus} from '../worker-status';

export const workerRouter = Router();

// ───────────────────────── 死活と「PC に反映すべき変更」 ─────────────────────────

workerRouter.post('/hello', async (req, res) => {
  const b = (req.body ?? {}) as Partial<WorkerStatus>;
  const status: WorkerStatus = {
    lastSeen: new Date().toISOString(),
    host: b.host ?? null,
    node: b.node ?? null,
    ffmpeg: b.ffmpeg ?? null,
    ffprobe: b.ffprobe ?? null,
    claude: !!b.claude,
    claudeBin: b.claudeBin ?? null,
    claudeVersion: b.claudeVersion ?? null,
    tts: !!b.tts,
    freeMemMB: b.freeMemMB ?? 0,
    totalMemMB: b.totalMemMB ?? 0,
    uploadsFolders: b.uploadsFolders ?? [],
    mosaic: b.mosaic ?? null,
    running: b.running ?? [],
  };
  await kvSet('worker', status);
  const [patch, personasRev, sfx] = await Promise.all([
    kvGet<{rev: number; patch: Record<string, unknown>}>('settings-patch'),
    kvGet<{rev: number}>('personas-rev'),
    kvGet<{rev: number; lib: SfxLibrary; updatedBy?: string}>('sfx'),
  ]);
  res.json({
    // Blob への書き込みトークンは PC に置かせない（TLS 越しに毎回渡す）
    blobToken: process.env.BLOB_READ_WRITE_TOKEN ?? null,
    settingsPatch: patch ?? null,
    personasRev: personasRev?.rev ?? 0,
    sfx: sfx && sfx.updatedBy === 'cloud' ? {rev: sfx.rev, lib: sfx.lib} : null,
  });
});

/** 画面で変えた設定を PC が適用し終えたら、この番号まで済んだと伝える */
workerRouter.post('/settings', async (req, res) => {
  const view = req.body?.view as SettingsView | undefined;
  if (view) await kvSet('settings-view', view);
  if (typeof req.body?.appliedPatchRev === 'number') {
    const cur = await kvGet<{rev: number; patch: Record<string, unknown>}>('settings-patch');
    // 適用済みの番号に追いついていれば、溜めていた変更を捨てる
    if (cur && cur.rev <= req.body.appliedPatchRev) await kvSet('settings-patch', {rev: cur.rev, patch: {}});
  }
  res.json({ok: true});
});

/** 画面で編集された人格。PC の ~/.reel-studio/personas.json をこれに合わせる */
workerRouter.get('/personas', async (_req, res) => {
  res.json({personas: await listPersonaRows()});
});

/** PC の personas.json をクラウドに載せる（初回・PC 側で編集したとき） */
workerRouter.post('/personas', async (req, res) => {
  const list = Array.isArray(req.body?.personas) ? (req.body.personas as unknown[]) : [];
  const parsed: Persona[] = [];
  for (const p of list) {
    const r = PersonaSchema.safeParse(p);
    if (r.success) parsed.push(r.data);
  }
  if (parsed.length) await replacePersonas(parsed.map((p) => ({id: p.id, data: p})));
  res.json({ok: true, count: parsed.length});
});

workerRouter.post('/sfx', async (req, res) => {
  const lib = req.body?.lib as SfxLibrary | undefined;
  if (!lib) return res.status(400).json({error: 'lib が必要'});
  const cur = await kvGet<{rev: number}>('sfx');
  await kvSet('sfx', {rev: (cur?.rev ?? 0) + 1, lib, updatedBy: 'worker'});
  res.json({ok: true});
});

// ───────────────────────── ジョブ ─────────────────────────

workerRouter.post('/claim', async (req, res) => {
  const running = Array.isArray(req.body?.running) ? (req.body.running as {slug: string; type: string}[]) : [];
  const max = Number(req.body?.maxConcurrent ?? 2) || 2;
  res.json({job: await claimJob(running, max)});
});

workerRouter.post('/jobs/:id/progress', async (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? (req.body.lines as string[]).slice(0, 500) : undefined;
  const progress = req.body?.progress as {phase: string; done: number; total: number} | undefined;
  res.json(await reportProgress(req.params.id, {progress, lines}));
});

workerRouter.post('/jobs/:id/finish', async (req, res) => {
  const status = req.body?.status;
  if (status !== 'done' && status !== 'failed' && status !== 'cancelled') return res.status(400).json({error: 'status は done|failed|cancelled'});
  if (Array.isArray(req.body?.lines) && req.body.lines.length) await reportProgress(req.params.id, {lines: req.body.lines as string[]});
  const error = typeof req.body?.error === 'string' ? req.body.error : undefined;
  await finishJob(req.params.id, {status, result: req.body?.result, error});
  // 時間のかかるもの（レンダー・仕上げ・AI）が終わったらスマホに知らせる。
  // 送れなくてもジョブの完了は成立させる
  const job = await getJob(req.params.id);
  if (job) void notifyJobFinished({type: job.type, slug: job.slug, status, error}).catch(() => undefined);
  res.json({ok: true});
});

// ───────────────────────── 契約ファイル ─────────────────────────

workerRouter.get('/docs/:slug', async (req, res) => {
  const rows = await readDocs(normalizeSlug(req.params.slug));
  res.json({docs: rows.map((r) => ({name: r.name, data: r.data, rev: r.rev, hash: r.hash, updatedBy: r.updatedBy, updatedAt: r.updatedAt}))});
});

/**
 * PC からの書き戻し。baseRev を付けると、その版から進んでいたら conflict を返す
 * （ワーカーはそれを .studio/conflicts/ に退避してからクラウド側を採用する）。
 */
workerRouter.post('/docs/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const items = Array.isArray(req.body?.docs) ? (req.body.docs as {name: string; data: unknown; baseRev?: number | null}[]) : [];
  const results: {name: string; ok: boolean; rev?: number; hash?: string; conflict?: {rev: number; hash: string; data: unknown}}[] = [];
  for (const it of items) {
    if (!isDocName(it.name)) {
      results.push({name: it.name, ok: false});
      continue;
    }
    const r = await writeDoc(slug, it.name, it.data, {expectRev: it.baseRev ?? null, by: 'worker'});
    if (r.ok) results.push({name: it.name, ok: true, rev: r.rev, hash: r.hash});
    else results.push({name: it.name, ok: false, conflict: {rev: r.conflict.rev, hash: r.conflict.hash, data: r.conflict.data}});
  }
  res.json({results});
});

/** PC 側の案件の状態（engine の差分・node_modules・out/ の有無）と仕上げの事実 */
workerRouter.post('/project/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const info = req.body?.info as ProjectSnapshot | undefined;
  const facts = req.body?.buildFacts as BuildFacts | undefined;
  await upsertProject(slug, {
    ...(info ? {info} : {}),
    ...(typeof req.body?.persona === 'string' ? {persona: req.body.persona} : {}),
    ...(typeof req.body?.format === 'string' ? {format: req.body.format} : {}),
    ...(typeof req.body?.shopName === 'string' ? {shopName: req.body.shopName} : {}),
  });
  if (facts) await kvSet(`build:${slug}`, facts);
  res.json({ok: true});
});

/** PC で案件フォルダが消えていた場合（一覧から外す。ジョブ履歴は残す） */
workerRouter.delete('/project/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  await softDeleteProject(slug);
  const urls = await deleteAssets(slug);
  for (const u of urls) void delBlob(u, process.env.BLOB_READ_WRITE_TOKEN);
  res.json({ok: true, removedAssets: urls.length});
});

// ───────────────────────── メディア ─────────────────────────

/** 既に上がっているもの（hash 付き）。ワーカーはこれと突き合わせて差分だけ上げる */
workerRouter.get('/assets/:slug', async (req, res) => {
  res.json({assets: await listAssets(normalizeSlug(req.params.slug))});
});

workerRouter.post('/assets/:slug', async (req, res) => {
  const slug = req.params.slug === '_global' ? '_global' : normalizeSlug(req.params.slug);
  const items = Array.isArray(req.body?.assets) ? (req.body.assets as {kind: string; mode: string; relPath: string; url: string; bytes?: number; hash?: string; contentType?: string}[]) : [];
  const bad: string[] = [];
  let saved = 0;
  for (const a of items) {
    if (!isAssetKind(a.kind) || !isAssetMode(a.mode) || !a.relPath || !a.url) {
      bad.push(`${a.kind}/${a.mode}/${a.relPath}`);
      continue;
    }
    const {replacedUrl} = await putAsset({
      slug,
      kind: a.kind,
      mode: a.mode,
      relPath: a.relPath,
      url: a.url,
      bytes: a.bytes ?? 0,
      hash: a.hash ?? '',
      contentType: a.contentType ?? 'application/octet-stream',
    });
    // 差し替えた古い実体は消す（Blob は上書きせず毎回新しい URL になる）
    if (replacedUrl) void delBlob(replacedUrl, process.env.BLOB_READ_WRITE_TOKEN);
    saved++;
  }
  res.json({ok: true, saved, bad});
});

export const WORKER_DOC_NAMES: readonly DocName[] = DOC_NAMES;
