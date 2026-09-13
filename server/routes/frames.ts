// カット頭のフレーム 1 枚（絵コンテ・カット行のサムネイル）。catalog を経由しないので、
// 手作りの cuts.json（src が catalog と一致しない案件）でもサムネイルが出る。
import {Router, type Request} from 'express';
import fs from 'node:fs';
import {ensureCutFrame} from '../../core/cut-frames';
import {resolveProjectDirStrict} from '../../core/project';

export const framesRouter = Router({mergeParams: true});

const slugOf = (req: Request): string => (req.params as unknown as {slug: string}).slug;

framesRouter.get('/frame', async (req, res) => {
  let dir: string;
  try {
    dir = resolveProjectDirStrict(slugOf(req));
  } catch (e) {
    return res.status(400).json({error: (e as Error).message});
  }
  if (!fs.existsSync(dir)) return res.status(404).json({error: '案件が無い'});
  const src = typeof req.query.src === 'string' ? req.query.src : '';
  const t = Number(req.query.t ?? 0);
  const width = Math.min(480, Math.max(80, Math.round(Number(req.query.w ?? 240)) || 240));
  if (!src) return res.status(400).json({error: 'src が必要'});
  try {
    const out = await ensureCutFrame(dir, src, t, width);
    if (!out) return res.status(404).json({error: `フレームを取れない: ${src}`});
    // URL は src+t で決まるが素材が差し替わることがあるので、ETag で毎回確認させる
    res.sendFile(out, {headers: {'Cache-Control': 'no-cache'}, etag: true, lastModified: true});
  } catch (e) {
    res.status(500).json({error: (e as Error).message});
  }
});
