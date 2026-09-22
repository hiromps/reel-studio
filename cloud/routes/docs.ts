// 契約ファイル（catalog / brief / cuts / narration）と、案件直下のテキスト（caption.txt / script.md / hooks.json）。
// ローカル版の server/routes/files.ts / caption.ts / script.ts / hooks.ts と同じ形を返す。
// ETag は「rev-hash」。If-Match が合わなければ 409 + 現在値、という挙動もローカルと同じ。
import {Router, type Request} from 'express';
import type {ZodTypeAny} from 'zod';
import {BriefSchema, CatalogSchema, NarrationSchema, ReelDataSchema} from '../../shared/schema';
import {HooksSchema, checkHooks, hookCutIndices} from '../../shared/hooks';
import {checkCaption} from '../../shared/caption';
import {getPersona} from '../../shared/personas';
import {parseSections, reviewScriptProposal, scriptPlanToNarration, scriptTotalSec} from '../../shared/script';
import {normalizeSlug, type ContractName, type DocName} from '../../shared/project';
import {emptyReference} from '../../shared/reference';
import {loadCtx, scriptEnv, scriptProposalView, validate, type Ctx} from '../project-context';
import {addJob, readDoc, revOfEtag, upsertProject, writeDoc} from '../store';

export const docsRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => normalizeSlug((req.params as unknown as {slug: string}).slug);

const schemas: Record<ContractName, ZodTypeAny> = {catalog: CatalogSchema, brief: BriefSchema, cuts: ReelDataSchema, narration: NarrationSchema};
const isContract = (v: string): v is ContractName => v in schemas;

const noCache = (res: import('express').Response) => res.setHeader('Cache-Control', 'no-cache');

// ───────────────────────── 契約ファイル 4 つ ─────────────────────────

docsRouter.get('/files/:name', async (req, res) => {
  const name = req.params.name;
  if (!isContract(name)) return res.status(400).json({error: 'name は catalog|brief|cuts|narration'});
  const row = await readDoc(slugOf(req), name);
  noCache(res);
  // 無いものは 404 ではなく data:null（narration が無いのは普通。ブラウザのコンソールを汚さない）
  if (!row) return res.json({etag: null, data: null});
  res.setHeader('ETag', row.etag);
  res.json({etag: row.etag, data: row.data});
});

docsRouter.put('/files/:name', async (req, res) => {
  const name = req.params.name;
  if (!isContract(name)) return res.status(400).json({error: 'name は catalog|brief|cuts|narration'});
  const slug = slugOf(req);
  const parsed = schemas[name].safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 20)});
  const r = await writeDoc(slug, name, parsed.data, {expectRev: revOfEtag(req.header('If-Match')), by: 'cloud'});
  if (!r.ok) return res.status(409).json({error: 'ファイルが外部で変更された', etag: r.conflict.etag, data: r.conflict.data});
  res.setHeader('ETag', r.etag);
  // brief の人格・型は一覧に出るので projects 行にも写す
  if (name === 'brief') {
    const b = parsed.data as {persona?: string; format?: string; shop?: {name?: string}};
    await upsertProject(slug, {persona: b.persona ?? null, format: b.format ?? null, shopName: b.shop?.name ?? null});
  }
  const validation = name === 'cuts' ? validate(await loadCtx(slug), {cuts: parsed.data}) : undefined;
  res.json({etag: r.etag, validation});
});

// ───────────────────────── caption.txt ─────────────────────────

const captionIssues = (ctx: Ctx, text: string) => {
  // brief が無い・人格が未登録の案件でも 500 にしない（点検だけ諦める）
  if (!ctx.brief) return [];
  try {
    return checkCaption(text, getPersona(ctx.brief.persona), {pr: ctx.brief.shop.pr});
  } catch {
    return [];
  }
};

docsRouter.get('/caption', async (req, res) => {
  const ctx = await loadCtx(slugOf(req));
  const row = ctx.rows.get('caption');
  noCache(res);
  if (row?.etag) res.setHeader('ETag', row.etag);
  res.json({etag: row?.etag ?? null, data: ctx.caption, issues: ctx.caption ? captionIssues(ctx, ctx.caption) : []});
});

docsRouter.put('/caption', async (req, res) => {
  const slug = slugOf(req);
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({error: 'text（文字列）が必要'});
  const r = await writeDoc(slug, 'caption', {text}, {expectRev: revOfEtag(req.header('If-Match')), by: 'cloud'});
  if (!r.ok) return res.status(409).json({error: 'ファイルが外部で変更された', etag: r.conflict.etag, data: (r.conflict.data as {text?: string})?.text ?? null});
  res.setHeader('ETag', r.etag);
  res.json({etag: r.etag, issues: captionIssues(await loadCtx(slug), text)});
});

// ───────────────────────── script.md（自然言語の台本） ─────────────────────────

/** 台本から読み取れた区間も返す（画面で「ちゃんと読めているか」を見せるため） */
const scriptInfo = (text: string | null) => {
  const sections = text ? parseSections(text) : [];
  return {sections, totalSec: scriptTotalSec(sections) ?? null};
};

docsRouter.get('/script', async (req, res) => {
  const ctx = await loadCtx(slugOf(req));
  const row = ctx.rows.get('script');
  noCache(res);
  if (row?.etag) res.setHeader('ETag', row.etag);
  res.json({etag: row?.etag ?? null, data: ctx.script, ...scriptInfo(ctx.script)});
});

docsRouter.put('/script', async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string') return res.status(400).json({error: 'text（文字列）が必要'});
  const r = await writeDoc(slugOf(req), 'script', {text}, {expectRev: revOfEtag(req.header('If-Match')), by: 'cloud'});
  if (!r.ok) return res.status(409).json({error: 'ファイルが外部で変更された', etag: r.conflict.etag, data: (r.conflict.data as {text?: string})?.text ?? null});
  res.json({etag: r.etag, ...scriptInfo(text)});
});

/** 「割り当てを見るだけ」の結果を、いまの台本・素材で見直したもの */
docsRouter.get('/script/plan', async (req, res) => {
  noCache(res);
  res.json({data: scriptProposalView(await loadCtx(slugOf(req)))});
});

/** 承認：保存してある案を cuts と narration に書き込む（AI は走らせない） */
docsRouter.post('/script/plan/apply', async (req, res) => {
  const slug = slugOf(req);
  const ctx = await loadCtx(slug);
  const proposal = ctx.scriptPlan;
  if (!proposal) return res.status(400).json({error: '書き込む割り当ての案がありません（先に「割り当てを見るだけ」を実行してください）', view: null});
  try {
    const env = scriptEnv(ctx);
    const cuts = env.toCuts(proposal.plan);
    const review = reviewScriptProposal(proposal, {scriptText: env.script, check: env.check, cuts});
    if (!review.canApply) throw new Error(`この案は書き込めません:\n${review.blockers.map((b) => `  ${b}`).join('\n')}`);
    await writeDoc(slug, 'cuts', cuts, {by: 'cloud'});
    const narration = scriptPlanToNarration(proposal.plan, env.persona.narration);
    if (narration) await writeDoc(slug, 'narration', narration, {by: 'cloud'});
    await writeDoc(slug, 'scriptPlan', {...proposal, appliedAt: new Date().toISOString()}, {by: 'cloud'});
    res.json({
      cuts: cuts.cuts.length,
      narration: proposal.plan.narration.length,
      totalSec: review.totalSec,
      issues: review.issues,
      view: scriptProposalView(await loadCtx(slug)),
    });
  } catch (e) {
    res.status(400).json({error: (e as Error).message, view: scriptProposalView(ctx)});
  }
});

// ───────────────────────── hooks.json（トライアルのフック候補） ─────────────────────────

/** いまの cuts のフック区間（何カット目が差し替え対象か）も返す */
const hookInfo = (ctx: Ctx, cutCount?: number) => {
  const cuts = ctx.cuts;
  if (!cuts) return {hookCuts: [], current: []};
  try {
    const idx = hookCutIndices(cuts, cutCount);
    return {
      hookCuts: idx.map((i) => i + 1),
      current: idx.map((i) => ({cutId: cuts.cuts[i].id ?? `c${i + 1}`, telop: cuts.cuts[i].main?.text ?? '', badge: cuts.cuts[i].badge ?? '', src: cuts.cuts[i].src})),
    };
  } catch {
    return {hookCuts: [], current: []};
  }
};

docsRouter.get('/hooks', async (req, res) => {
  const ctx = await loadCtx(slugOf(req));
  const row = ctx.rows.get('hooks');
  noCache(res);
  if (row?.etag) res.setHeader('ETag', row.etag);
  res.json({etag: row?.etag ?? null, data: ctx.hooks, ...hookInfo(ctx, ctx.hooks?.cutCount), issues: ctx.hooks ? checkHooks(ctx.hooks) : []});
});

docsRouter.put('/hooks', async (req, res) => {
  const slug = slugOf(req);
  const parsed = HooksSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 10)});
  const r = await writeDoc(slug, 'hooks', parsed.data, {expectRev: revOfEtag(req.header('If-Match')), by: 'cloud'});
  if (!r.ok) return res.status(409).json({error: 'ファイルが外部で変更された', etag: r.conflict.etag, data: r.conflict.data});
  res.json({etag: r.etag, ...hookInfo(await loadCtx(slug), parsed.data.cutCount), issues: checkHooks(parsed.data)});
});

// ───────────────────────── reference.json（参考動画の型の分析） ─────────────────────────
// 動画そのものは PC の .studio/reference/ にあり、クラウドには分析結果とコマだけが上がる。
// スマホからの取り込みは素材と同じ二段構え（Blob へ直接上げて ai-reference ジョブに url を渡す。cloud/routes/misc.ts の /uploads/token）。

docsRouter.get('/reference', async (req, res) => {
  const ctx = await loadCtx(slugOf(req));
  const row = ctx.rows.get('reference');
  noCache(res);
  if (row?.etag) res.setHeader('ETag', row.etag);
  res.json({etag: row?.etag ?? null, data: ctx.reference});
});

/** PC 上のファイルを指す取り込みは PC でしかできない */
docsRouter.post('/reference/import', (_req, res) => {
  res.status(501).json({error: '動画ファイルの指定は PC 上の Reel Studio で行ってください（スマホからは「動画を選ぶ」でアップロードできます）'});
});

/** 別の案件の分析を使う。コマの実体が PC にあるので、複製は PC のジョブで行う */
docsRouter.post('/reference/copy-from', async (req, res) => {
  const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
  if (!from) return res.status(400).json({error: 'from（元の案件）が必要'});
  res.json({job: await addJob('ai-reference', slugOf(req), {copyFrom: normalizeSlug(from)})});
});

/** 取り消し。ファイルを消す代わりに墓標（source: null）を書き、ワーカーの同期で PC 側も消える */
docsRouter.delete('/reference', async (req, res) => {
  const slug = slugOf(req);
  await writeDoc(slug, 'reference', emptyReference(), {by: 'cloud'});
  res.json({etag: null, data: null});
});

export const DOC_ROUTE_NAMES: readonly DocName[] = ['catalog', 'brief', 'cuts', 'narration', 'caption', 'script', 'hooks', 'scriptPlan', 'reference'];
