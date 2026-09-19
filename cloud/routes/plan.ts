// 構成プラン・タグ取り込み・並びの書き出し・仕上げの段取り・カットのサムネイル。
// ローカル版 server/routes/plan.ts / build.ts / frames.ts に対応する。
//
// PC でしかできないこと（素材の実ファイルを触る操作）は、ここではジョブに積んで PC に任せる:
//   - slug の変更（public/uploads のリネームを伴う）→ catalog-import ジョブ
//   - alias の適用（ファイルのコピー）→ レンダーの preflight が PC 側で行う
import {Router, type Request} from 'express';
import {planCuts, PlanError} from '../../shared/plan';
import {checkOrder, orderFromCuts} from '../../shared/order';
import {planBuild, type BuildFacts} from '../../shared/build';
import {normalizeSlug} from '../../shared/project';
import {FATAL_CODES} from '../../shared/validate';
import {loadCtx, orderEnv, validate} from '../project-context';
import {addJob, findAsset, kvGet, listAssets, projectInfo, writeDoc} from '../store';

export const planRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => normalizeSlug((req.params as unknown as {slug: string}).slug);

// ───────────────────────── 構成プラン ─────────────────────────

planRouter.post('/plan', async (req, res) => {
  const slug = slugOf(req);
  const ctx = await loadCtx(slug);
  const brief = req.body?.brief ?? ctx.brief;
  if (!ctx.catalog) return res.status(400).json({error: 'catalog.json が無い（先にカタログ化）'});
  if (!brief) return res.status(400).json({error: 'brief.json が無い'});
  try {
    const r = planCuts({catalog: ctx.catalog, brief, existing: ctx.cuts, options: {allowReuse: req.body?.allowReuse !== false}});
    if (req.body?.write) await writeDoc(slug, 'cuts', r.cuts, {by: 'cloud'});
    // alias（同一素材の再参照を別名ファイルにコピーする回避策）は実ファイルの操作なので PC 側で行う。
    // レンダーの preflight が未適用分を必ず処理するため、ここでは数えるだけ
    res.json({
      cuts: r.cuts,
      aliases: r.aliases,
      table: r.table,
      warnings: r.warnings,
      markdown: r.markdown,
      written: !!req.body?.write,
      aliasesApplied: 0,
    });
  } catch (e) {
    if (e instanceof PlanError) return res.status(422).json({error: e.message, code: e.code});
    res.status(500).json({error: (e as Error).message});
  }
});

planRouter.post('/validate', async (req, res) => {
  const ctx = await loadCtx(slugOf(req));
  try {
    res.json(validate(ctx, {cuts: req.body?.cuts, strictProxy: !!req.body?.strictProxy}));
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

// ───────────────────────── 並び ─────────────────────────

planRouter.get('/order', async (req, res) => {
  try {
    const ctx = await loadCtx(slugOf(req));
    const env = orderEnv(ctx);
    if (!ctx.cuts) return res.json({order: [], check: null});
    const ids = orderFromCuts(ctx.cuts, env.catalog);
    res.json({order: ids, check: checkOrder(ids, {catalog: env.catalog, brief: env.brief, spec: env.spec})});
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

/**
 * ローカルでは「AI に渡す素材リスト」を PC のファイルに書き出す機能。
 * 手元の claude にそのファイルを読ませるための導線なので、クラウドからは使えない
 * （画面側もクラウドではボタンを出さない）。
 */
planRouter.post('/order/export', (_req, res) => {
  res.status(501).json({error: '並べ替え用の書き出しは PC 上の Reel Studio で行ってください（クラウドからはファイルを置けません）'});
});

// ───────────────────────── タグの取り込み ─────────────────────────

planRouter.post('/catalog/import', async (req, res) => {
  const slug = slugOf(req);
  const ctx = await loadCtx(slug);
  if (!ctx.catalog) return res.status(404).json({error: 'catalog.json が無い'});
  const body = req.body as {clips?: {id: string; slug?: string}[]; facts?: string[]; source?: string};
  const clips = body?.clips ?? [];
  // slug の変更は public/uploads の実ファイル名が変わる。PC でしかできないので丸ごと任せる
  const renames = clips.filter((c) => typeof c.slug === 'string' && c.slug.trim());
  const job = renames.length ? await addJob('catalog-import', slug, {clips, facts: body.facts, source: body.source === 'user' ? 'user' : 'claude'}) : null;
  if (renames.length) {
    return res.json({updated: [], skipped: renames.map((c) => `${c.id}: PC で名前を変更します`), jobId: job!.id});
  }
  // タグ・区間・メモ・facts だけなら catalog を直接書ける
  const {updated, skipped} = importTagsPure(ctx.catalog, body, body.source === 'user' ? 'user' : 'claude');
  await writeDoc(slug, 'catalog', ctx.catalog, {by: 'cloud'});
  res.json({updated, skipped});
});

/** core/catalog.ts:importTags の、ファイル名を触らない部分だけ（catalog を直接書き換える） */
const importTagsPure = (catalog: NonNullable<Awaited<ReturnType<typeof loadCtx>>['catalog']>, data: {clips?: {id: string; [k: string]: unknown}[]; facts?: string[]}, source: 'claude' | 'user') => {
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date().toISOString();
  for (const t of data.clips ?? []) {
    const clip = catalog.clips.find((x) => x.id === t.id);
    if (!clip) {
      skipped.push(`${t.id}: not found`);
      continue;
    }
    if (clip.user.lock) {
      skipped.push(`${t.id}: locked`);
      continue;
    }
    const tags = t.tags as (Partial<NonNullable<typeof clip.tags>> & {kind: NonNullable<typeof clip.tags>['kind']}) | undefined;
    if (tags) {
      clip.tags = {
        kind: tags.kind,
        signage: tags.signage ?? tags.kind === 'signage',
        signageSize: tags.signageSize ?? (tags.signage ? 'small' : 'none'),
        angle: tags.angle ?? 'mid',
        motion: tags.motion ?? 'handheld',
        sizzleScore: tags.sizzleScore ?? 3,
        quality: tags.quality ?? 3,
        hasSpeech: tags.hasSpeech ?? false,
        subject: tags.subject ?? '',
        description: tags.description ?? '',
        source: tags.source ?? source,
        taggedAt: tags.taggedAt ?? now,
      };
    }
    if (t.usableRanges) clip.usableRanges = t.usableRanges as typeof clip.usableRanges;
    if (t.speech) clip.speech = t.speech as typeof clip.speech;
    if (t.note !== undefined) clip.user.note = t.note as string;
    updated.push(t.id);
  }
  if (data.facts) catalog.facts = data.facts;
  return {updated, skipped};
};

// ───────────────────────── 仕上げの段取り ─────────────────────────

/**
 * PC でしか分からない事実（out/ の有無と古さ・未生成の音声・claude / Fish の可否）は
 * ワーカーが projects.info.buildFacts に置いたものを使い、
 * 画面で今まさに編集したぶん（カット数・検証・原稿・キャプション）は DB から上書きする。
 */
planRouter.get('/build', async (req, res) => {
  const slug = slugOf(req);
  const [ctx, info, pushed] = await Promise.all([loadCtx(slug), projectInfo(slug), kvGet<BuildFacts>(`build:${slug}`)]);
  const base: BuildFacts = pushed ?? {
    hasCuts: false,
    cutCount: 0,
    placeholders: 0,
    validationErrors: 0,
    fatalErrors: 0,
    hasNarration: false,
    segments: 0,
    needsTts: 0,
    hasFinal: false,
    finalStale: false,
    hasMixed: false,
    hasCaption: false,
    ttsAvailable: false,
    claudeAvailable: false,
  };
  let cutCount = 0;
  let placeholders = 0;
  let validationErrors = 0;
  let fatalErrors = 0;
  if (ctx.cuts) {
    try {
      const v = validate(ctx);
      cutCount = v.summary.cutCount;
      placeholders = v.summary.placeholders;
      fatalErrors = v.errors.filter((e) => FATAL_CODES.has(e.code)).length;
      validationErrors = v.errors.length - fatalErrors;
    } catch {
      fatalErrors = 1;
    }
  }
  const facts: BuildFacts = {
    ...base,
    hasCuts: !!ctx.cuts,
    cutCount,
    placeholders,
    validationErrors,
    fatalErrors,
    hasNarration: !!ctx.narration,
    segments: ctx.narration?.segments.length ?? 0,
    hasCaption: !!ctx.caption?.trim(),
    hasFinal: info?.out.final ?? base.hasFinal,
    hasMixed: info?.out.narration ?? base.hasMixed,
  };
  res.json({facts, steps: planBuild(facts)});
});

/**
 * スマホで映像が見られる状態か。
 * クラウドには原本 4K を上げないので、**軽量プロキシ（540x960）が上がっているぶんだけ**再生できる。
 * 足りなければ画面が「軽量プレビューを作る」を出す（preview-proxy ジョブ）。
 */
planRouter.get('/preview-status', async (req, res) => {
  const slug = slugOf(req);
  const [ctx, assets] = await Promise.all([loadCtx(slug), listAssets(slug)]);
  const light = new Set(assets.filter((a) => a.kind === 'uploads' && a.mode === 'light').map((a) => a.relPath));
  const clips = ctx.catalog?.clips ?? [];
  const missing = clips.filter((c) => !light.has(c.src.replace(/^.*\//, ''))).map((c) => c.id);
  res.json({clips: clips.length, ready: clips.length - missing.length, missing});
});

// ───────────────────────── カット頭のサムネイル ─────────────────────────

/**
 * ローカルでは ffmpeg でその場で切り出すが、クラウドでは素材そのものが無い。
 * 代わりに catalog のストリップ（1 秒刻みの静止画。Blob に上がっている）から一番近いコマを返す。
 * 見つからなければ 404 —— 画面（CutThumb）はコンタクトシートに落ちる作りになっている。
 */
planRouter.get('/frame', async (req, res) => {
  const slug = slugOf(req);
  const src = typeof req.query.src === 'string' ? req.query.src : '';
  const t = Math.max(0, Number(req.query.t ?? 0) || 0);
  if (!src) return res.status(400).json({error: 'src が必要'});
  const ctx = await loadCtx(slug);
  const clip = ctx.catalog?.clips.find((c) => c.src === src || c.proxyOf === src);
  const strip = clip?.thumbs.strip ?? [];
  if (!strip.length) return res.status(404).json({error: `フレームを取れない: ${src}`});
  const rel = strip[Math.min(strip.length - 1, Math.max(0, Math.round(t)))];
  const asset = await findAsset(slug, 'studio', 'full', rel);
  if (!asset) return res.status(404).json({error: 'まだ PC から上がっていません'});
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.redirect(307, asset.url);
});
