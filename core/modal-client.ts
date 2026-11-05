import {spawn} from 'node:child_process';
import {modalConfig, modalSecrets} from './modal-vault';
import type {ModalConfig, ModalSecrets} from '../shared/modal';

export class ModalError extends Error {constructor(message: string, public status = 502) {super(message);}}
export const validateModalEndpoint = (value: string): string => {
  if (!value) return '';
  let u: URL;
  try {u = new URL(value);} catch {throw new ModalError('Modal Web Endpoint URLが不正です', 400);}
  if (u.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)?\.modal\.run$/.test(u.hostname) || u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new ModalError('URLには https://…modal.run のエンドポイントを指定してください', 400);
  return u.origin;
};
export const modalFetchWith = async (config: ModalConfig, secrets: ModalSecrets, route: string, opt: {method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string>} = {}): Promise<Response> => {
  const url = validateModalEndpoint(config.endpointUrl);
  if (!url || !secrets.proxyTokenId || !secrets.proxyTokenSecret) throw new ModalError('ModalのURLとHTTP Proxy Tokenを設定してください', 503);
  let response: Response;
  try {
    response = await fetch(`${url}${route}`, {method: opt.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(opt.timeoutMs ?? 30_000), headers: {'Content-Type': 'application/json', ...opt.headers, 'Modal-Key': secrets.proxyTokenId, 'Modal-Secret': secrets.proxyTokenSecret}, ...(opt.body !== undefined ? {body: JSON.stringify(opt.body)} : {})});
  } catch {throw new ModalError('Modalに接続できませんでした。URL・接続状態を確認し、ジョブ送信時は履歴で受付状況を確認してください', 504);}
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ModalError('ModalのHTTP Proxy Tokenで認証できませんでした', 502);
    // Never reflect arbitrary upstream content or validation input (may contain credentials).
    const messages: Record<number, string> = {400: 'Modalの入力検証に失敗しました', 404: 'Modalのジョブまたは素材が見つかりません', 409: 'GPUジョブが実行中、素材の転送が未完了、または必要な素材・音声が不足しています', 410: 'クラウド素材の保存期限が切れました。素材を再アップロードしてください', 413: 'Modalの入力サイズ上限を超えています', 416: '動画の読込範囲が不正です', 422: 'Modalの入力形式が不正です', 429: 'Modalの月間予算・保存容量またはアクセス上限に達しました'};
    await response.body?.cancel();
    throw new ModalError(messages[response.status] ?? `Modal処理に失敗しました（HTTP ${response.status}）`, [400, 404, 409, 410, 413, 416, 422, 429].includes(response.status) ? response.status : 502);
  }
  return response;
};
export const modalFetch = (route: string, opt?: Parameters<typeof modalFetchWith>[3]): Promise<Response> => modalFetchWith(modalConfig(), modalSecrets(), route, opt);
export const modalJson = async <T>(route: string, opt?: Parameters<typeof modalFetch>[1]): Promise<T> => (await modalFetch(route, opt)).json() as Promise<T>;

/** Official Python SDK, credentials only via the child environment; no shell or secret CLI arguments. */
export const testModalSdk = async (): Promise<{ok: boolean; message: string}> => {
  const secrets = modalSecrets();
  if (!secrets.tokenId || !secrets.tokenSecret) return {ok: false, message: 'Modal API Token ID / Secretが未設定です（HTTP接続とは別のSDK認証）'};
  return new Promise(resolve => {
    const child = spawn(process.env.REEL_MODAL_PYTHON || 'python', ['-X', 'utf8', '-m', 'modal', 'token', 'info'], {windowsHide: true, stdio: 'ignore', shell: false, env: {...process.env, MODAL_TOKEN_ID: secrets.tokenId, MODAL_TOKEN_SECRET: secrets.tokenSecret}});
    const timer = setTimeout(() => {child.kill(); resolve({ok: false, message: 'SDK認証がタイムアウトしました'});}, 20_000);
    child.on('error', () => {clearTimeout(timer); resolve({ok: false, message: 'PythonとModal SDKを確認してください: python -m pip install modal'});});
    child.on('exit', code => {clearTimeout(timer); resolve({ok: code === 0, message: code === 0 ? 'Modal公式SDKでAPIトークンを確認しました' : 'APIトークンの認証に失敗しました'});});
  });
};
