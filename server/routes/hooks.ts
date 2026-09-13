// hooks.json（トライアルリールのフック候補）の GET / PUT。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import {readHooks, hooksPath, writeHooks} from '../../core/trial';
import {resolveProjectDirStrict, readCuts} from '../../core/project';
import {HooksSchema, checkHooks, hookCutIndices} from '../../shared/hooks';
import {fileEtag} from '../../core/json-io';

export const hooksRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

/** いまの cuts のフック区間（何カット目が差し替え対象か）も返す */
const hookInfo = (dir: string, cutCount?: number) => {
  try {
    const cuts = readCuts(dir);
    const idx = hookCutIndices(cuts, cutCount);
    return {
      hookCuts: idx.map((i) => i + 1),
      // 各カットの「いまの文言」。画面の初期値に使う
      current: idx.map((i) => ({cutId: cuts.cuts[i].id ?? `c${i + 1}`, telop: cuts.cuts[i].main?.text ?? '', badge: cuts.cuts[i].badge ?? '', src: cuts.cuts[i].src})),
    };
  } catch {
    return {hookCuts: [], current: []};
  }
};

hooksRouter.get('/hooks', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const data = readHooks(dir);
  const p = hooksPath(dir);
  const etag = fs.existsSync(p) ? fileEtag(p) : null;
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({etag, data, ...hookInfo(dir, data?.cutCount), issues: data ? checkHooks(data) : []});
});

hooksRouter.put('/hooks', (req, res) => {
  const dir = resolveProjectDirStrict(slugOf(req));
  const parsed = HooksSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: '検証に失敗', issues: parsed.error.issues.slice(0, 10)});
  writeHooks(dir, parsed.data);
  res.json({etag: fileEtag(hooksPath(dir)), ...hookInfo(dir, parsed.data.cutCount), issues: checkHooks(parsed.data)});
});
