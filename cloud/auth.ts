// 認証。画面は Auth.js（Google ログイン）、PC ワーカーは固定トークン。
//
// - 画面 … /api/auth/* を Auth.js が受ける（サインイン・コールバック・セッション）。
//          入れるのは AUTH_ALLOWED_EMAILS に書いたメールアドレスだけ（空なら誰も入れない）。
//          セッションは暗号化 Cookie（JWT）。400 日有効で、画面を開くたびに
//          （/api/auth/session を呼ぶたびに、前回から 1 日以上たっていれば）延長される。
// - ワーカー … Authorization: Bearer <WORKER_TOKEN>。Cookie は使わない（ブラウザではないため）
//
// 環境変数: AUTH_SECRET（無ければ AUTH_JWT_SECRET を使う）/ AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / AUTH_ALLOWED_EMAILS
import {timingSafeEqual} from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';
import {getSession, type ExpressAuthConfig} from '@auth/express';
import Google from '@auth/express/providers/google';

const SESSION_DAYS = 400;

/** 入れてよいメールアドレス（カンマ区切り・小文字で比べる） */
export const allowedEmails = (): Set<string> =>
  new Set((process.env.AUTH_ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

export const isAllowedEmail = (email: string | null | undefined, verified: boolean | undefined): boolean =>
  !!email && verified !== false && allowedEmails().has(email.trim().toLowerCase());

/** 呼ぶたびに作る（環境変数をその時点で読むため。ExpressAuth は basePath を書き換えるので共有しない） */
export const authConfig = (): ExpressAuthConfig => ({
  basePath: '/api/auth',
  trustHost: true,
  secret: process.env.AUTH_SECRET?.trim() || process.env.AUTH_JWT_SECRET?.trim(),
  providers: [Google],
  session: {strategy: 'jwt', maxAge: SESSION_DAYS * 24 * 60 * 60, updateAge: 24 * 60 * 60},
  // Auth.js 標準の英語ページは出さず、アプリの画面（ログイン画面）に戻す。失敗時は ?error=… が付く
  pages: {signIn: '/', error: '/'},
  callbacks: {
    signIn: ({user, profile}) => isAllowedEmail(profile?.email ?? user.email, profile?.email_verified as boolean | undefined),
  },
});

/** 画面用。未ログインは 401（src/api.ts がこれを見てログイン画面に切り替える） */
export const requireUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const session = await getSession(req, authConfig());
    if (session?.user) return next();
  } catch {
    // 秘密鍵の未設定や壊れた Cookie は「未ログイン」として扱う
  }
  res.status(401).json({error: 'ログインが必要です'});
};

/** ワーカー用。トークンは長さを揃えて時間差比較する */
export const requireWorker = (req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env.WORKER_TOKEN?.trim();
  if (!expected) {
    res.status(503).json({error: 'WORKER_TOKEN が未設定です'});
    return;
  }
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.status(401).json({error: 'ワーカーのトークンが違います'});
};
