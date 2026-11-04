// Cloud settings are metadata plus encrypted credentials. No local filesystem,
// Python process, or plaintext credentials in the cloud database.
import {createCipheriv, createDecipheriv, hkdfSync, randomBytes} from 'node:crypto';
import {ModalConfigSchema, MODAL_SECRET_KEYS, type ModalConfig, type ModalSecrets, type ModalSettingsView} from '../shared/modal';
import {ModalError, modalFetchWith} from '../core/modal-client';
import {kvGet, kvSet} from './store';

type Stored = {config: ModalConfig; encrypted?: string};
const key = () => {
  const master = process.env.AUTH_JWT_SECRET;
  if (!master || master.length < 32) throw new ModalError('クラウドの暗号化設定がありません', 503);
  return Buffer.from(hkdfSync('sha256', master, 'reel-studio-modal-cloud', 'credentials-v1', 32));
};
const encrypt = (secrets: ModalSecrets): string => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
};
const decrypt = (encrypted?: string): ModalSecrets => {
  if (!encrypted) return {};
  try {
    const b = Buffer.from(encrypted, 'base64'), cipher = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'));
  } catch {throw new ModalError('Modalの暗号化済み設定を読み込めません。クラウド管理者が認証情報を再設定してください', 503);}
};
export const cloudModalConnection = async (): Promise<{config: ModalConfig; secrets: ModalSecrets}> => {
  const saved = await kvGet<Stored>('modal-cloud-settings');
  const config = ModalConfigSchema.parse(saved?.config ?? {endpointUrl: process.env.REEL_MODAL_ENDPOINT_URL ?? ''});
  const secrets = {...(process.env.REEL_MODAL_PROXY_TOKEN_ID ? {proxyTokenId: process.env.REEL_MODAL_PROXY_TOKEN_ID} : {}), ...(process.env.REEL_MODAL_PROXY_TOKEN_SECRET ? {proxyTokenSecret: process.env.REEL_MODAL_PROXY_TOKEN_SECRET} : {}), ...decrypt(saved?.encrypted)};
  return {config, secrets};
};
export const cloudModalView = async (): Promise<ModalSettingsView> => {
  const {config, secrets} = await cloudModalConnection();
  return {...config, secrets: Object.fromEntries(MODAL_SECRET_KEYS.map(k => [k, !!secrets[k]])) as ModalSettingsView['secrets'], encryption: 'AES-256-GCM（クラウドサーバー）', configured: !!config.endpointUrl && !!secrets.proxyTokenId && !!secrets.proxyTokenSecret};
};
export const saveCloudModal = async (config: ModalConfig, secrets: ModalSecrets, clear = false): Promise<ModalSettingsView> => {
  const current = await kvGet<Stored>('modal-cloud-settings');
  await kvSet('modal-cloud-settings', {config, encrypted: encrypt(clear ? {} : {...decrypt(current?.encrypted), ...secrets})});
  return cloudModalView();
};
export const cloudModalFetch = async (route: string, opt?: Parameters<typeof modalFetchWith>[3]): Promise<Response> => {
  const {config, secrets} = await cloudModalConnection();
  return modalFetchWith(config, secrets, route, opt);
};
export const cloudModalJson = async <T>(route: string, opt?: Parameters<typeof cloudModalFetch>[1]): Promise<T> => (await cloudModalFetch(route, opt)).json() as Promise<T>;
