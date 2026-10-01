// クラウド版の Express アプリ。Vercel Functions（api/[...path].ts）がこれを 1 本だけマウントする。
//
// ローカル版（server/index.ts）との違い:
// - ファイルシステムの代わりに Supabase の Postgres（契約ファイル・ジョブ）と Vercel Blob（メディア）を使う
// - 重い処理は自分でやらず、ジョブとして積んで PC のワーカーに実行させる
// - 公開されるので、すべての経路に認証が要る（画面は Cookie、ワーカーは Bearer）
import express from 'express';
// @ts-expect-error Express 内部モジュール（型定義が無い）。下の handle_request の差し替えで使う
import Layer from 'express/lib/router/layer.js';
import {clearSessionCookie, cookieValue, COOKIE_NAME, issueSession, readSession, requireUser, requireWorker, setSessionCookie, verifyPassword} from './auth';
import {ensurePersonas} from './personas-sync';
import {docsRouter} from './routes/docs';
import {eventsHandler, jobsRouter} from './routes/jobs';
import {mediaRouter} from './routes/media';
import {miscRouter} from './routes/misc';
import {planRouter} from './routes/plan';
import {projectsRouter} from './routes/projects';
import {workerRouter} from './routes/worker';

// Express 4 は async ハンドラの reject を拾わない。拾われないと Node が unhandledRejection でプロセスごと落ち、
// Vercel では同じインスタンスで動いている他のリクエストまで巻き添えで 60 秒後に 504 になる（原因もログに残らない）。
// Express 5 と同じ振る舞いになるよう、ハンドラの戻りが Promise なら catch して next(err) に流す。
type LayerLike = {handle: (...a: unknown[]) => unknown; handle_request: (req: unknown, res: unknown, next: (e?: unknown) => void) => void};
const layerProto = (Layer as {prototype: LayerLike}).prototype;
if (!(layerProto as {__asyncPatched?: boolean}).__asyncPatched) {
  (layerProto as {__asyncPatched?: boolean}).__asyncPatched = true;
  layerProto.handle_request = function (this: LayerLike, req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const ret = fn(req, res, next);
      if (ret && typeof (ret as Promise<unknown>).catch === 'function') (ret as Promise<unknown>).catch((err: unknown) => next(err ?? new Error('unknown error')));
    } catch (err) {
      next(err);
    }
  };
}

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
  // どの経路で失敗しても、ハングせずに原因を返す（ログにも残す）。SSE のように送信済みなら閉じるだけ
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Drizzle は失敗した SQL を message に、Postgres の本当の理由（relation does not exist 等）を cause に入れる。両方出す
    const cause = (err as {cause?: unknown} | null)?.cause;
    const message = (err instanceof Error ? err.message : String(err)) + (cause instanceof Error ? `\n← ${cause.message}` : '');
    console.error(`[api] ${req.method} ${req.path} failed: ${message}`);
    if (res.headersSent) return res.end();
    // 入力の不備（案件名・必須項目・スキーマ検証）は 400、それ以外（DB・外部 API）は 500
    res.status(/案件名が不正です|が必要|検証に失敗/.test(message) ? 400 : 500).json({error: message});
  });

  return app;
};
