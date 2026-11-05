// DB はローカルファイルの索引のみ。旧 Storage URL へのフォールバックは行わない。
import {Router} from 'express';
import path from 'node:path';
import {isAssetKind, isAssetMode} from '../../shared/media';
import {requireLocalMedia} from '../../core/local-media';
import {findAsset} from '../store';
import {normalizeSlug} from '../../shared/project';
import {serveModalRenderMedia} from '../../core/modal-render-router';
import {cloudModalRender} from '../modal-render';

export const mediaRouter = Router();
mediaRouter.get('/p/:slug/:mode/:kind/*', async (req, res) => {
  if (req.params.slug !== '_global' && await serveModalRenderMedia(req, res, cloudModalRender)) return;
  if (process.env.VERCEL) return res.status(409).json({error: 'メディアは PC にあります。PC の Reel Studio で開いてください'});
  const slug = req.params.slug === '_global' ? '_global' : normalizeSlug(req.params.slug);
  const {mode, kind} = req.params;
  const rel = (req.params as Record<string, string>)[0] ?? '';
  if (!isAssetMode(mode) || !isAssetKind(kind) || !rel || rel.split(/[\\/]/).includes('..')) return res.status(400).end();
  const asset = (await findAsset(slug, kind, mode, rel)) ?? (mode === 'full' ? await findAsset(slug, kind, 'light', rel) : null);
  if (!asset) return res.status(404).end();
  try {
    const file = requireLocalMedia(asset.url);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
    res.sendFile(file, {acceptRanges: true, etag: true, lastModified: true});
  } catch {
    res.status(409).json({error: 'ローカルファイルがありません。既存メディアを移行してから開いてください'});
  }
});
