// 認証。自分専用の 1 アカウント（パスワード 1 つ）と、PC ワーカー用の固定トークン。
//
// - 画面 … POST /api/auth/login でパスワードを照合し、署名付き Cookie（HttpOnly）を配る
// - ワーカー … Authorization: Bearer <WORKER_TOKEN>。Cookie は使わない（ブラウザではないため）
//
// パスワードは平文で持たず、AUTH_PASSWORD_HASH に `scrypt$<salt>$<hash>` の形で置く
// （生成は `node scripts/hash-password.mjs`）。
import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import type {NextFunction, Request, Response} from 'express';
import {SignJWT, jwtVerify} from 'jose';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const COOKIE_NAME = 'rs_session';
const SESSION_DAYS = 30;

/** `scrypt$<saltHex>$<hashHex>` を作る。scripts/hash-password.mjs から使う */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const jwtSecret = (): Uint8Array => {
  const s = process.env.AUTH_JWT_SECRET?.trim();
  if (!s || s.length < 32) throw new Error('AUTH_JWT_SECRET が未設定か短すぎます（32 文字以上）');
  return new TextEncoder().encode(s);
};

export const issueSession = async (): Promise<string> =>
  new SignJWT({sub: 'owner'}).setProtectedHeader({alg: 'HS256'}).setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(jwtSecret());

export const readSession = async (token: string): Promise<boolean> => {
  try {
    await jwtVerify(token, jwtSecret());
    return true;
  } catch {
    return false;
  }
};

/** Cookie ヘッダから 1 つ取り出す（cookie-parser を足さずに済ませる） */
export const cookieValue = (req: Request, name: string): string | null => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

export const setSessionCookie = (res: Response, token: string): void => {
  const attrs = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`];
  // ローカルの vercel dev（http）では Secure を付けると Cookie が保存されない
  if (process.env.VERCEL_ENV !== 'development' && process.env.NODE_ENV !== 'development') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
};

export const clearSessionCookie = (res: Response): void => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
};

/** 画面用。未ログインは 401（src/api.ts がこれを見てログイン画面に切り替える） */
export const requireUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = cookieValue(req, COOKIE_NAME);
  if (token && (await readSession(token))) return next();
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
