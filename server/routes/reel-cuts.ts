import {Router, type Request} from 'express';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {resolveProjectDirStrict} from '../../core/project';
import {loadReelCutsConfig, readReelCuts, reelCutsPath, writeReelCuts} from '../../core/reel-cuts';
import {ReelCutsSchema} from '../../shared/schema/reel-cuts';

export const reelCutsRouter = Router({mergeParams: true});
const dirOf = (req: Request) => resolveProjectDirStrict((req.params as unknown as {slug: string}).slug);
const etagOf = (dir: string): string | null => fs.existsSync(reelCutsPath(dir)) ? createHash('sha256').update(fs.readFileSync(reelCutsPath(dir))).digest('hex') : null;

reelCutsRouter.get('/reel-cuts', (req, res) => {
  const dir = dirOf(req);
  const etag = etagOf(dir);
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({etag, data: readReelCuts(dir), config: loadReelCutsConfig()});
});

reelCutsRouter.put('/reel-cuts', (req, res) => {
  const dir = dirOf(req);
  const current = etagOf(dir);
  const expected = req.header('If-Match');
  if (expected && expected !== current) return res.status(409).json({error: '共通JSONが外部で変更されました', etag: current, data: readReelCuts(dir)});
  const parsed = ReelCutsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: 'カット配列の検証に失敗', issues: parsed.error.issues});
  try {
    const data = writeReelCuts(dir, parsed.data);
    const etag = etagOf(dir)!;
    res.setHeader('ETag', etag);
    res.json({etag, data});
  } catch (e) {res.status(400).json({error: (e as Error).message});}
});
