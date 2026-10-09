import {Router, type Request} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {loadCatalog, saveCatalog} from '../../core/catalog';
import {resolveProjectDirStrict} from '../../core/project';
import type {Clip} from '../../shared/schema';

export const clipboardRouter = Router({mergeParams: true});

const safeFile = (root: string, rel: string): string => {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('素材のパスが不正です');
  return file;
};

clipboardRouter.post('/clipboard/import-clips', (req: Request, res) => {
  try {
    const toDir = resolveProjectDirStrict((req.params as {slug: string}).slug);
    const from = req.body?.from;
    const ids = req.body?.ids;
    if (typeof from !== 'string' || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || ids.length > 100) return res.status(400).json({error: 'コピー元と素材 ID が必要です'});
    const fromDir = resolveProjectDirStrict(from);
    const source = loadCatalog(fromDir);
    const target = loadCatalog(toDir);
    if (!source || !target) return res.status(400).json({error: '両方の案件に catalog.json が必要です'});
    const imported: Record<string, Clip> = {};
    const next = {...target, clips: [...target.clips]};
    const copyAsset = (folder: 'public' | '.studio', rel: string, prefix: string): string => {
      const src = safeFile(path.join(fromDir, folder), rel);
      if (!fs.existsSync(src)) throw new Error(`素材ファイルがありません: ${rel}`);
      const ext = path.extname(rel);
      const destRel = path.posix.join(folder === 'public' ? 'uploads' : 'clipboard', `${prefix}_${path.basename(rel, ext)}${ext}`);
      const dest = safeFile(path.join(toDir, folder), destRel);
      fs.mkdirSync(path.dirname(dest), {recursive: true});
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      return destRel;
    };
    for (const id of [...new Set(ids)] as string[]) {
      const clip = source.clips.find((c) => c.id === id);
      if (!clip) throw new Error(`コピー元の素材がありません: ${id}`);
      const prefix = `copy_${from.replace(/[^a-zA-Z0-9_-]/g, '_')}_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const existing = next.clips.find((c) => c.id === prefix);
      if (existing) { imported[id] = existing; continue; }
      const src = copyAsset('public', clip.src, prefix);
      const proxyOf = clip.proxyOf ? copyAsset('public', clip.proxyOf, `${prefix}_original`) : undefined;
      const sheet = copyAsset('.studio', clip.thumbs.sheet, `${prefix}_sheet`);
      const strip = clip.thumbs.strip.map((rel, i) => copyAsset('.studio', rel, `${prefix}_strip_${i}`));
      const mosaic = clip.mosaic?.original ? {...clip.mosaic, original: copyAsset('.studio', clip.mosaic.original, `${prefix}_mosaic_original`)} : clip.mosaic;
      const copied: Clip = {...clip, id: prefix, src, proxyOf, thumbs: {sheet, strip}, mosaic, user: {...clip.user, ng: false}};
      next.clips.push(copied);
      imported[id] = copied;
    }
    saveCatalog(toDir, {...next, updatedAt: new Date().toISOString()});
    res.json({clips: imported});
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});

clipboardRouter.post('/clipboard/copy-narration-audio', (req: Request, res) => {
  try {
    const toDir = resolveProjectDirStrict((req.params as {slug: string}).slug);
    const from = req.body?.from;
    const pairs = req.body?.pairs;
    if (typeof from !== 'string' || !Array.isArray(pairs) || pairs.length > 100 || pairs.some((p) => !/^[a-zA-Z0-9_-]+$/.test(p?.from ?? '') || !/^[a-zA-Z0-9_-]+$/.test(p?.to ?? ''))) return res.status(400).json({error: 'コピー元と音声 ID が必要です'});
    const fromDir = resolveProjectDirStrict(from);
    const target = path.join(toDir, 'narration');
    fs.mkdirSync(target, {recursive: true});
    const copied: boolean[] = pairs.map(({from: sourceId, to: targetId}: {from: string; to: string}) => {
      const source = path.join(fromDir, 'narration', `${sourceId}.wav`);
      if (!fs.existsSync(source)) return false;
      const destination = path.join(target, `${targetId}.wav`);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      return true;
    });
    res.json({copied});
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});
