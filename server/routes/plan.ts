// plan / validate / aliases / タグ・並び替えの入出力。
import {Router, type Request} from 'express';
import {planCuts, PlanError} from '../../shared/plan';
import {loadCatalog, exportForTagging, importTags} from '../../core/catalog';
import {currentOrder, exportOrder, importOrder, loadOrderEnv} from '../../core/order';
import {readBrief, readCuts, resolveProjectDirStrict, writeCuts} from '../../core/project';
import {validateProject} from '../../core/render';
import {applyAliases, pendingAliases} from '../../core/alias';
import {loadSettings} from '../../core/settings';

export const planRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

planRouter.post('/validate', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  try {
    res.json(validateProject(dir, {cuts: req.body?.cuts, strictProxy: !!req.body?.strictProxy}));
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

planRouter.post('/plan', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const catalog = loadCatalog(dir);
  const brief = req.body?.brief ?? readBrief(dir);
  if (!catalog) return res.status(400).json({error: 'catalog.json が無い（先にカタログ化）'});
  if (!brief) return res.status(400).json({error: 'brief.json が無い'});
  let existing;
  try {
    existing = readCuts(dir);
  } catch {
    existing = undefined;
  }
  try {
    const r = planCuts({catalog, brief, existing, options: {allowReuse: req.body?.allowReuse !== false, font: loadSettings().telop.font}});
    let applied = 0;
    if (req.body?.write) {
      writeCuts(dir, r.cuts);
      if (req.body?.copy !== false) {
        applied = applyAliases(dir, r.cuts).length;
        if (applied) writeCuts(dir, r.cuts);
      }
    }
    res.json({cuts: r.cuts, aliases: r.aliases, table: r.table, warnings: r.warnings, markdown: r.markdown, written: !!req.body?.write, aliasesApplied: applied});
  } catch (e) {
    if (e instanceof PlanError) return res.status(422).json({error: e.message, code: e.code});
    res.status(500).json({error: (e as Error).message});
  }
});

planRouter.post('/aliases/apply', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const cuts = readCuts(dir);
  const pend = pendingAliases(dir, cuts);
  const done = applyAliases(dir, cuts);
  if (done.length || pend.length) writeCuts(dir, cuts);
  res.json({applied: done.map((a) => a.to), pending: pendingAliases(dir, cuts).map((a) => a.to)});
});

// ── 並び替え（AI に構成を決めてもらう） ──
planRouter.get('/order', (req, res) => {
  try {
    res.json(currentOrder(loadOrderEnv(resolveProjectDirStrict(slugOf(req)))) ?? {order: [], check: null});
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

planRouter.post('/order/export', (req, res) => {
  try {
    const {file, payload} = exportOrder(loadOrderEnv(resolveProjectDirStrict(slugOf(req))), typeof req.body?.out === 'string' ? req.body.out : undefined);
    res.json({file, payload});
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

planRouter.post('/order/import', (req, res) => {
  try {
    const env = loadOrderEnv(resolveProjectDirStrict(slugOf(req)));
    const r = importOrder(env, req.body?.proposal ?? req.body, {write: !!req.body?.write, copy: req.body?.copy !== false, force: !!req.body?.force});
    res.status(r.applied ? 200 : 422).json(r);
  } catch (e) {
    res.status(400).json({error: (e as Error).message});
  }
});

planRouter.get('/catalog/export', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const c = loadCatalog(dir);
  if (!c) return res.status(404).json({error: 'catalog.json が無い'});
  res.json(exportForTagging(dir, c));
});

planRouter.post('/catalog/import', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const c = loadCatalog(dir);
  if (!c) return res.status(404).json({error: 'catalog.json が無い'});
  const r = importTags(dir, c, req.body, req.body?.source === 'user' ? 'user' : 'claude');
  res.json(r);
});
