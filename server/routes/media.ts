// 静的配信：uploads / fonts（案件の public/）、studio（.studio/）、out、qc。Range 対応は sendFile が行う。
//
// URL は `/p/<slug>/<mode>/<kind>/<パス>`（mode = full | light）。**案件を URL に持たせている**のは、
// タブごとに違う案件を開けるようにするため（サーバー側の「いまの案件」1 つで解決すると、
// タブを 2 枚開いた時に片方の素材がもう片方に出てしまう）。
// Remotion Player の staticFile() には window.remotion_staticBase = `/p/<slug>/<mode>` を渡している。
import {Router, type Request, type Response} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {activeDir, resolveInProject, resolvePublic, resolveStudio, state} from '../state';
import {resolveProjectDirStrict} from '../../core/project';
import {fontsDir} from '../../core/fonts';
import {isFontFileName, safeFontFile} from '../../shared/schema/fonts';

export const mediaRouter = Router();

const serve = (res: Response, abs: string | null, cache: string, downloadAs?: string) => {
  if (!abs) return res.status(404).end();
  const headers: Record<string, string> = {'Cache-Control': cache};
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.mov' || ext === '.mp4' || ext === '.m4v') headers['Content-Type'] = 'video/mp4';
  if (ext === '.ttf') headers['Content-Type'] = 'font/ttf';
  if (ext === '.otf') headers['Content-Type'] = 'font/otf';
  if (ext === '.ttc') headers['Content-Type'] = 'font/collection';
  if (ext === '.woff') headers['Content-Type'] = 'font/woff';
  if (ext === '.woff2') headers['Content-Type'] = 'font/woff2';
  if (ext === '.wav') headers['Content-Type'] = 'audio/wav';
  // 再生ではなく保存させる。案件名に日本語が入るので RFC 5987 の形で書く
  if (downloadAs) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadAs)}`;
  res.sendFile(abs, {headers, acceptRanges: true, etag: true, lastModified: true});
};

const rel = (req: Request) => (req.params as Record<string, string>)[0] ?? '';
/** `?download=1` が付いていたら保存名を返す（スマホから完成品を持ち出すため） */
const downloadAs = (req: Request): string | undefined => {
  if (!req.query.download) return undefined;
  const slug = (req.params as Record<string, string>).slug ?? 'reel';
  return `${slug}_${path.basename(rel(req))}`;
};
const dirOf = (req: Request): string | null => {
  try {
    return resolveProjectDirStrict((req.params as Record<string, string>).slug);
  } catch {
    return null; // work/ の外を指す slug は 404（URL に案件が入るので、ここで必ず閉じる）
  }
};
const isLight = (req: Request) => (req.params as Record<string, string>).mode === 'light';

// ── 案件に属さないもの（_global）。クラウド版と URL の形を揃えてある ──────
// 取り込んだフォントの原本（<設定の置き場>/fonts/）。Settings の見本表示が読む
// （案件が 1 つも無くても開ける画面なので、案件に依らない URL を用意してある）
mediaRouter.get('/p/_global/:mode/fonts/*', (req, res) => {
  const file = safeFontFile(rel(req));
  if (!file || !isFontFileName(file)) return res.status(404).end();
  const abs = path.join(fontsDir(), file);
  serve(res, fs.existsSync(abs) ? abs : null, 'no-cache');
});

// ── 案件を URL に持つ形（いまの画面はこちらを使う） ────────────────
mediaRouter.get('/p/:slug/:mode/uploads/*', (req, res) => serve(res, resolvePublic(dirOf(req), `uploads/${rel(req)}`, isLight(req)), 'no-cache'));
// フォントは案件の public/fonts/ が本体。まだ配られていない（cuts.json を保存する前に
// Timeline で選んだ直後）ときは置き場から出す＝選んだ瞬間にプレビューへ反映される。
// 差し替え（同じ名前で中身が変わる）があるので immutable にはしない（ETag で 304 になる）
mediaRouter.get('/p/:slug/:mode/fonts/*', (req, res) => {
  const inProject = resolvePublic(dirOf(req), `fonts/${rel(req)}`);
  if (inProject) return serve(res, inProject, 'no-cache');
  const file = safeFontFile(rel(req));
  const abs = file && isFontFileName(file) ? path.join(fontsDir(), file) : null;
  serve(res, abs && fs.existsSync(abs) ? abs : null, 'no-cache');
});
mediaRouter.get('/p/:slug/:mode/studio/*', (req, res) => serve(res, resolveStudio(dirOf(req), rel(req)), 'no-cache'));
mediaRouter.get('/p/:slug/:mode/out/*', (req, res) => serve(res, resolveInProject(dirOf(req), 'out', rel(req)), 'no-cache', downloadAs(req)));
mediaRouter.get('/p/:slug/:mode/qc/*', (req, res) => serve(res, resolveInProject(dirOf(req), 'qc', rel(req)), 'no-cache'));
// 生成済みのナレーション音声（GUI の試聴ボタン）
mediaRouter.get('/p/:slug/:mode/narration/*', (req, res) => serve(res, resolveInProject(dirOf(req), 'narration', rel(req)), 'no-cache'));

// ── 案件を持たない旧 URL（古いビルドの画面が残っている場合の保険。既定の案件で解決する） ──
mediaRouter.get('/uploads/*', (req, res) => serve(res, resolvePublic(activeDir(), `uploads/${rel(req)}`), `no-cache, slug=${state.activeSlug}`));
mediaRouter.get('/fonts/*', (req, res) => serve(res, resolvePublic(activeDir(), `fonts/${rel(req)}`), 'public, max-age=31536000, immutable'));
mediaRouter.get('/studio/*', (req, res) => serve(res, resolveStudio(activeDir(), rel(req)), 'no-cache'));
mediaRouter.get('/out/*', (req, res) => serve(res, resolveInProject(activeDir(), 'out', rel(req)), 'no-cache'));
mediaRouter.get('/qc/*', (req, res) => serve(res, resolveInProject(activeDir(), 'qc', rel(req)), 'no-cache'));
