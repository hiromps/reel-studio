// メディアの配信。URL の形はローカル版（server/routes/media.ts）と完全に同じ
// `/p/<slug>/<mode>/<kind>/<パス>` にしてある。だから Remotion Player の staticFile() も
// 画面のサムネイル・プレビューも、クラウドとローカルで同じコードのまま動く。
//
// 実体は Blob にあるので 307 で飛ばす（Range 要求はリダイレクト先がそのまま扱う）。
// 原本 4K は上げていないので、mode=full が無ければ light（540x960 の軽量プロキシ）に落とす。
import {Router} from 'express';
import {getDownloadUrl} from '@vercel/blob';
import {isAssetKind, isAssetMode} from '../blob';
import {findAsset} from '../store';
import {normalizeSlug} from '../../shared/project';

export const mediaRouter = Router();

mediaRouter.get('/p/:slug/:mode/:kind/*', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const mode = req.params.mode;
  const kind = req.params.kind;
  const rel = (req.params as Record<string, string>)[0] ?? '';
  if (!isAssetMode(mode)) return res.status(400).end();

  // フォント（テロップの描画に使う）は案件ごとに持たない。
  // 自前フォントはワーカーが _global に上げているのでそれを、無ければ同梱の明朝（アプリの静的ファイル）を返す
  if (kind === 'fonts') {
    const font = await findAsset('_global', 'fonts', 'full', rel);
    if (font) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.redirect(307, font.url);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.redirect(308, `/fonts/${rel}`);
  }
  if (!isAssetKind(kind)) return res.status(404).end();

  const asset = (await findAsset(slug, kind, mode, rel)) ?? (mode === 'full' ? await findAsset(slug, kind, 'light', rel) : null);
  if (!asset) return res.status(404).end();
  // Blob の URL は差し替えのたびに変わるので、ここは短く持たせて毎回引き直させる
  res.setHeader('Cache-Control', 'private, max-age=30');
  // `?download=1` は「再生ではなく保存」。飛ばした先（Blob）に添付として返させる
  // —— 別オリジンなので <a download> は効かず、Content-Disposition でしか保存にできない
  res.redirect(307, req.query.download ? getDownloadUrl(asset.url) : asset.url);
});
