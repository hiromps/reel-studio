// Claude への再接続：ログイン状態の読み取りと、クラウド画面で反映待ちの接続先を戻さないこと
import {describe, expect, it} from 'vitest';
import {parseClaudeAuthStatus} from '../core/claude-auth';
import {overlayPendingAgent, type SettingsView} from '../shared/schema/settings';

const now = new Date('2026-11-08T07:00:00Z');

describe('claude auth status の読み取り', () => {
  it('ログイン済みならプランと期限を返し、メールアドレスは持たない', () => {
    const out = JSON.stringify({loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', subscriptionType: 'max', planTier: 'max_5x', loginExpiresAt: '2026-12-03T19:53:08.263Z'});
    const auth = parseClaudeAuthStatus(out, now);
    expect(auth).toMatchObject({loggedIn: true, method: 'claude.ai', plan: 'max_5x', expiresAt: '2026-12-03T19:53:08.263Z'});
    expect(JSON.stringify(auth)).not.toContain('example.com');
  });

  it('期限切れのログインは未ログイン扱いにする', () => {
    const auth = parseClaudeAuthStatus(JSON.stringify({loggedIn: true, loginExpiresAt: '2026-11-01T00:00:00Z'}), now);
    expect(auth?.loggedIn).toBe(false);
    expect(auth?.error).toContain('期限');
  });

  it('未ログイン・JSON 以外を見分ける', () => {
    expect(parseClaudeAuthStatus('{"loggedIn": false}', now)?.loggedIn).toBe(false);
    expect(parseClaudeAuthStatus('Warning: something\n{"loggedIn": true}', now)?.loggedIn).toBe(true);
    expect(parseClaudeAuthStatus('error: unknown command auth', now)).toBeNull();
  });
});

describe('クラウドの反映待ちの AI 設定', () => {
  const agent = {provider: 'codex', model: 'sonnet', deepseekModel: 'deepseek-v4-flash', codexModel: 'gpt-x', tagBatchSize: 8, tagConcurrency: 3, timeoutMin: 20} as unknown as SettingsView['settings']['agent'];

  it('保存した接続先とモデルを見え方に重ね、反映待ちと分かるようにする', () => {
    const r = overlayPendingAgent(agent, {provider: 'claude', model: 'opus', codexModel: 'gpt-x'});
    expect(r.pending).toBe(true);
    expect(r.agent).toMatchObject({provider: 'claude', model: 'opus', codexModel: 'gpt-x'});
  });

  it('鍵や空の値は重ねない。変化が無ければ反映待ちにしない', () => {
    const r = overlayPendingAgent(agent, {provider: 'codex', deepseekApiKey: 'sk-should-not-appear', codexBin: ''});
    expect(r.pending).toBe(false);
    expect(JSON.stringify(r.agent)).not.toContain('sk-should-not-appear');
    expect(overlayPendingAgent(agent, undefined)).toEqual({agent, pending: false});
  });
});
