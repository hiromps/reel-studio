// クラウド版のログイン（Auth.js / Google）。Google 本体には繋がず、こちら側の振る舞いだけを見る。
import type {AddressInfo} from 'node:net';
import {encode} from '@auth/core/jwt';
import {afterAll, beforeAll, expect, it, vi} from 'vitest';
import {isAllowedEmail} from '../cloud/auth';
import {createApp} from '../cloud/app';

const SECRET = 'test-auth-secret-for-cloud-auth-only-123456';
const SALT = 'authjs.session-token';
let server: ReturnType<ReturnType<typeof createApp>['listen']>, base: string;

beforeAll(async () => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('AUTH_GOOGLE_ID', 'test-client-id.apps.googleusercontent.com');
  vi.stubEnv('AUTH_GOOGLE_SECRET', 'test-client-secret');
  vi.stubEnv('AUTH_ALLOWED_EMAILS', 'Owner@Example.com, second@example.com');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllEnvs();
});

const sessionCookie = async (iatSecondsAgo = 0) => {
  const now = Math.floor(Date.now() / 1000);
  const value = await encode({token: {email: 'owner@example.com', name: 'owner', iat: now - iatSecondsAgo}, secret: SECRET, salt: SALT});
  return `${SALT}=${value}`;
};

it('許可リストのメールアドレスだけ入れる（大文字小文字は無視、未確認メールは不可）', () => {
  expect(isAllowedEmail('owner@example.com', true)).toBe(true);
  expect(isAllowedEmail('OWNER@example.com', undefined)).toBe(true);
  expect(isAllowedEmail('second@example.com', true)).toBe(true);
  expect(isAllowedEmail('stranger@example.com', true)).toBe(false);
  expect(isAllowedEmail('owner@example.com', false)).toBe(false);
  expect(isAllowedEmail(undefined, true)).toBe(false);
});

it('許可リストが空なら誰も入れない', () => {
  vi.stubEnv('AUTH_ALLOWED_EMAILS', '');
  try {
    expect(isAllowedEmail('owner@example.com', true)).toBe(false);
  } finally {
    vi.stubEnv('AUTH_ALLOWED_EMAILS', 'Owner@Example.com, second@example.com');
  }
});

it('未ログインなら /api/auth/session は null、画面用 API は 401', async () => {
  const s = await fetch(`${base}/api/auth/session`);
  expect(s.status).toBe(200);
  expect(await s.json()).toBeNull();
  expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  expect((await fetch(`${base}/api/projects`, {headers: {cookie: `${SALT}=broken`}})).status).toBe(401);
});

it('ログイン中は user が返り、開くたびにセッション Cookie が 400 日で出し直される', async () => {
  const r = await fetch(`${base}/api/auth/session`, {headers: {cookie: await sessionCookie(3 * 24 * 60 * 60)}});
  const body = (await r.json()) as {user?: {email?: string}; expires?: string};
  expect(body.user?.email).toBe('owner@example.com');
  const days = (new Date(body.expires!).getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(399);
  expect(r.headers.get('set-cookie') ?? '').toContain(`${SALT}=`);
});

it('Google でログインを押すと、正しい戻り先付きで Google の画面へ送る', async () => {
  const csrf = await fetch(`${base}/api/auth/csrf`);
  const {csrfToken} = (await csrf.json()) as {csrfToken: string};
  const csrfCookie = (csrf.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const r = await fetch(`${base}/api/auth/signin/google`, {
    method: 'POST',
    redirect: 'manual',
    headers: {'content-type': 'application/x-www-form-urlencoded', cookie: csrfCookie},
    body: new URLSearchParams({csrfToken, callbackUrl: `${base}/`}),
  });
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get('location')!);
  expect(to.origin).toBe('https://accounts.google.com');
  expect(to.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
  expect(to.searchParams.get('redirect_uri')).toBe(`${base}/api/auth/callback/google`);
});
