// Modal secrets are never stored in settings.json or returned by an API.
import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {settingsDir} from './settings';
import {writeJsonAtomic} from './json-io';
import {ModalConfigSchema, MODAL_SECRET_KEYS, type ModalConfig, type ModalSecrets, type ModalSettingsView} from '../shared/modal';

const file = () => path.join(settingsDir(), 'modal-cloud.json');
type Stored = {config: ModalConfig; encrypted?: string};
const read = (): Stored => {
  if (!fs.existsSync(file())) return {config: ModalConfigSchema.parse({})};
  try {const v = JSON.parse(fs.readFileSync(file(), 'utf8')); return {config: ModalConfigSchema.parse(v.config), encrypted: v.encrypted};}
  catch {throw new Error('Modal設定を読み込めません。設定ファイルを確認してください');}
};
const dpapi = (value: string, decrypt: boolean): string => {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${operation}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {input: value, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe']}).trim();}
  catch {throw new Error('Windowsユーザーの資格情報を復号・保存できません');}
};
const aesKey = (): Buffer => {
  const env = process.env.REEL_MODAL_ENCRYPTION_KEY;
  if (env) {const key = Buffer.from(env, 'base64'); if (key.length !== 32) throw new Error('REEL_MODAL_ENCRYPTION_KEYは32バイトのBase64鍵にしてください'); return key;}
  const target = path.join(settingsDir(), 'modal-vault.key');
  fs.mkdirSync(settingsDir(), {recursive: true, mode: 0o700});
  if (!fs.existsSync(target)) fs.writeFileSync(target, randomBytes(32), {mode: 0o600, flag: 'wx'});
  return fs.readFileSync(target);
};
const encrypt = (value: ModalSecrets): string => {
  const plain = Buffer.from(JSON.stringify(value));
  if (process.platform === 'win32') return `dpapi:${dpapi(plain.toString('base64'), false)}`;
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `aes:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
};
const decrypt = (value?: string): ModalSecrets => {
  if (!value) return {};
  try {
    if (value.startsWith('dpapi:')) return JSON.parse(Buffer.from(dpapi(value.slice(6), true), 'base64').toString('utf8'));
    if (!value.startsWith('aes:')) throw new Error('format');
    const b = Buffer.from(value.slice(4), 'base64'), cipher = createDecipheriv('aes-256-gcm', aesKey(), b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'));
  } catch {throw new Error('Modalの秘密情報を復号できません。保存したOSユーザーと暗号鍵を確認してください');}
};
export const modalConfig = (): ModalConfig => read().config;
export const modalSecrets = (): ModalSecrets => {
  const saved = decrypt(read().encrypted);
  const env = {tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET, proxyTokenId: process.env.REEL_MODAL_PROXY_TOKEN_ID, proxyTokenSecret: process.env.REEL_MODAL_PROXY_TOKEN_SECRET};
  for (const k of MODAL_SECRET_KEYS) if (env[k]?.trim()) saved[k] = env[k]!.trim();
  return saved;
};
export const modalSettingsView = (): ModalSettingsView => {
  const secrets = modalSecrets();
  return {...modalConfig(), secrets: Object.fromEntries(MODAL_SECRET_KEYS.map(k => [k, !!secrets[k]])) as ModalSettingsView['secrets'], encryption: process.platform === 'win32' ? 'Windows DPAPI（現在のユーザー）' : 'AES-256-GCM', configured: !!modalConfig().endpointUrl && !!secrets.proxyTokenId && !!secrets.proxyTokenSecret};
};
export const saveModalSettings = (config: ModalConfig, secrets: ModalSecrets, clear = false): ModalSettingsView => {
  const previous = read();
  const merged = clear ? {} : {...decrypt(previous.encrypted), ...secrets};
  writeJsonAtomic(file(), {config: ModalConfigSchema.parse(config), encrypted: encrypt(merged)}, {mode: 0o600});
  return modalSettingsView();
};
