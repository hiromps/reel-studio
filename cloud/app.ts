// クラウド版の Express アプリ。Vercel Functions（api/[...path].ts）がこれを 1 本だけマウントする。
//
// ローカル版（server/index.ts）との違い:
// - ファイルシステムの代わりに Neon（契約ファイル・ジョブ）と Blob（メディア）を使う
// - 重い処理は自分でやらず、ジョブとして積んで PC のワーカーに実行させる
// - 公開されるので、すべての経路に認証が要る（画面は Cookie、ワーカーは Bearer）
import express from 'express';
import {clearSessionCookie, cookieValue, COOKIE_NAME, issueSession, readSession, requireUser, requireWorker, setSessionCookie, verifyPassword} from './auth';
import {ensurePersonas} from './personas-sync';
import {docsRouter} from './routes/docs';
import {eventsHandler, jobsRouter} from './routes/jobs';
import {mediaRouter} from './routes/media';
import {miscRouter} from './routes/misc';
import {planRouter} from './routes/plan';
import {projectsRouter} from './routes/projects';
import {workerRouter} from './routes/worker';

export const createApp = (): express.Express => {
  const app = express();
  app.set('trust proxy', true);
  // Vercel Functions の本文上限は 4.5MB。動画はブラウザから Blob へ直接上げるのでここは通らない
  app.use(express.json({limit: '4mb'}));

  // ── ログイン ──────────────────────────────────────────────
  app.post('/api/auth/login', async (req, res) => {
    const hash = process.env.AUTH_PASSWORD_HASH?.trim();
    if (!hash) return res.status(503).json({error: 'AUTH_PASSWORD_HASH が未設定です（node scripts/hash-password.mjs で作って Vercel に入れてください）'});
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !(await verifyPassword(password, hash))) {
      // 総当たりを少しだけ鈍らせる（1 アカウントなので、これで十分）
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({error: 'パスワードが違います'});
    }
    setSessionCookie(res, await issueSession());
    res.json({ok: true});
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ok: true});
  });

  /** 画面の起動時チェック。ログインしていなければ 200 + authenticated:false（401 を出さない） */
  app.get('/api/auth/session', async (req, res) => {
    const token = cookieValue(req, COOKIE_NAME);
    res.json({authenticated: !!token && (await readSession(token))});
  });

  // ── ワーカー（Bearer） ────────────────────────────────────
  app.use('/api/worker', requireWorker, workerRouter);

  // ── 画面（Cookie） ────────────────────────────────────────
  // 人格は判断（検証・キャプション点検・構成プラン）に要るので、先に DB から読んでレジストリに載せる
  app.use('/api', requireUser, (req, res, next) => void ensurePersonas().then(next).catch(next));
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects/:slug', docsRouter);
  app.use('/api/projects/:slug', planRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api', miscRouter);
  app.get('/events', requireUser, (req, res) => void eventsHandler(req, res));
  app.use(requireUser, mediaRouter);

  // ── まとめてのエラー処理 ──────────────────────────────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err?.message ?? String(err);
    res.status(/案件名が不正です|が必要|検証に失敗/.test(msg) ? 400 : 500).json({error: msg});
  });
  return app;
};
