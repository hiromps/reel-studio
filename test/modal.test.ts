import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ModalConfigSchema, ModalJobInputSchema} from '../shared/modal';
import {modalConfig, modalSecrets, modalSettingsView, saveModalSettings} from '../core/modal-vault';
import {modalFetch, validateModalEndpoint} from '../core/modal-client';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-modal-'));
  vi.stubEnv('REEL_STUDIO_HOME', root);
  for (const k of ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'REEL_MODAL_PROXY_TOKEN_ID', 'REEL_MODAL_PROXY_TOKEN_SECRET']) vi.stubEnv(k, '');
});
afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(root, {recursive: true, force: true});});

describe('Modal credential protection', () => {
  it('uses safe defaults and no GPU opt-in by default', () => {
    expect(modalConfig()).toMatchObject({gpu: 'RTX-PRO-6000', monthlyBudgetUsd: 25, maxJobSeconds: 300});
    expect(ModalJobInputSchema.safeParse({kind: 'gpu-test', requestId: crypto.randomUUID()}).success).toBe(false);
    expect(ModalConfigSchema.safeParse({monthlyBudgetUsd: 26}).success).toBe(false);
  });
  it('encrypts credentials at rest and never returns their values', () => {
    saveModalSettings(ModalConfigSchema.parse({endpointUrl: 'https://test--api.us-east.modal.run'}), {tokenId: 'ak-test-secret', tokenSecret: 'as-test-secret', proxyTokenId: 'wk-proxy-id', proxyTokenSecret: 'ws-proxy-secret'});
    expect(modalSecrets().tokenSecret).toBe('as-test-secret');
    const disk = fs.readFileSync(path.join(root, 'modal-cloud.json'), 'utf8');
    expect(disk).not.toContain('as-test-secret');
    expect(disk).not.toContain('ws-proxy-secret');
    const view = JSON.stringify(modalSettingsView());
    expect(view).not.toContain('as-test-secret');
    expect(view).not.toContain('wk-proxy-id');
    expect(modalSettingsView().secrets.tokenSecret).toBe(true);
    expect(fs.existsSync(path.join(root, 'settings.json'))).toBe(false);
  });
  it('does not forward secrets to redirects, local IPs, userinfo, paths or lookalike domains', () => {
    expect(validateModalEndpoint('https://hiromps--api.us-east.modal.run')).toBe('https://hiromps--api.us-east.modal.run');
    for (const url of ['http://x.modal.run', 'https://127.0.0.1', 'https://x.modal.run.evil.test', 'https://user:password@x.modal.run', 'https://x.modal.run/path', 'https://x.modal.run?token=secret']) expect(() => validateModalEndpoint(url)).toThrow();
  });
  it('upstream failures cannot reflect credentials in client errors', async () => {
    saveModalSettings(ModalConfigSchema.parse({endpointUrl: 'https://test--api.modal.run'}), {proxyTokenId: 'wk-test', proxyTokenSecret: 'ws-secret'});
    const mocked = vi.fn().mockResolvedValue(new Response('secret ws-secret', {status: 500}));
    vi.stubGlobal('fetch', mocked);
    await expect(modalFetch('/health')).rejects.toThrow('HTTP 500');
    expect(mocked.mock.calls[0][1].redirect).toBe('error');
  });
});
