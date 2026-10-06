// 裏で走らせる claude の接続先（Claude / DeepSeek）。DeepSeek のときは環境変数で向き先を差し替える。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentProvider, deepseekApiKey, defaultSettings, loadSettings, mergeSettings, resetSettings, saveSettings, settingsView} from '../core/settings';
import {AgentError, DEEPSEEK_ANTHROPIC_URL, providerEnv} from '../core/agent';
import {studioConfig} from '../studio.config';
import {agentStatusOf} from '../shared/schema/settings';

let home: string;
const ENV_KEYS = ['REEL_STUDIO_AGENT_PROVIDER', 'REEL_STUDIO_AGENT_MODEL', 'DEEPSEEK_API_KEY'];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-agent-provider-'));
  process.env.REEL_STUDIO_HOME = home;
  for (const k of ENV_KEYS) delete process.env[k];
  resetSettings();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetSettings();
  fs.rmSync(home, {recursive: true, force: true});
});

describe('接続先の既定と切り替え', () => {
  it('既定は Claude で、子プロセスに何も足さない（ログイン中のアカウントを使う）', () => {
    expect(agentProvider()).toBe('claude');
    expect(providerEnv()).toEqual({});
    expect(studioConfig.agent.model).toBe('opus');
  });

  it('DeepSeek に切り替えると既定のモデルも DeepSeek になる', () => {
    saveSettings(mergeSettings(defaultSettings(), {agent: {provider: 'deepseek', deepseekApiKey: 'sk-test-12345678'}}));
    expect(agentProvider()).toBe('deepseek');
    expect(studioConfig.agent.model).toBe('deepseek-v4-pro');
    // Claude に戻したときの model は残っている
    expect(loadSettings().agent.model).toBe('opus');
  });

  it('環境変数 REEL_STUDIO_AGENT_PROVIDER が設定より優先、DEEPSEEK_API_KEY も同じ', () => {
    saveSettings(mergeSettings(defaultSettings(), {agent: {provider: 'claude', deepseekApiKey: 'sk-settings-1234'}}));
    process.env.REEL_STUDIO_AGENT_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'sk-env-98765432';
    expect(agentProvider()).toBe('deepseek');
    expect(deepseekApiKey()).toBe('sk-env-98765432');
    // 不正な値は無視して設定に従う
    process.env.REEL_STUDIO_AGENT_PROVIDER = 'gpt';
    expect(agentProvider()).toBe('claude');
  });

  it('鍵は空文字で消せる', () => {
    const cur = mergeSettings(defaultSettings(), {agent: {provider: 'deepseek', deepseekApiKey: 'sk-test-12345678', deepseekModel: 'deepseek-v4-flash'}});
    const next = mergeSettings(cur, {agent: {deepseekApiKey: '', deepseekModel: null}});
    expect(next.agent.deepseekApiKey).toBeUndefined();
    expect(next.agent.deepseekModel).toBe('deepseek-v4-pro');
    expect(next.agent.provider).toBe('deepseek');
  });
});

describe('providerEnv（DeepSeek の向き先）', () => {
  it('Anthropic 互換 API に向け、Claude のモデル名を DeepSeek に読み替える', () => {
    const env = providerEnv('deepseek', 'sk-test-12345678', 'deepseek-v4-pro');
    expect(env.ANTHROPIC_BASE_URL).toBe(DEEPSEEK_ANTHROPIC_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-12345678');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-pro');
  });

  it('鍵が無ければ claude を起動する前に止める', () => {
    expect(() => providerEnv('deepseek', null, 'deepseek-v4-pro')).toThrow(AgentError);
  });

  it('画面用の見え方に鍵の値は載らない', () => {
    saveSettings(mergeSettings(defaultSettings(), {agent: {provider: 'deepseek', deepseekApiKey: 'sk-secret-abcd9999', claudeCatalogApiKey: 'sk-ant-secret-1234'}}));
    const v = settingsView({bin: 'claude', available: false, source: 'none', version: null}, home);
    expect(JSON.stringify(v)).not.toContain('sk-secret-abcd9999');
    expect(JSON.stringify(v)).not.toContain('sk-ant-secret-1234');
    expect(v.settings.agent.deepseekApiKey).toEqual({present: true, masked: '••••9999', source: 'settings'});
    expect(v.settings.agent.claudeCatalogApiKey).toEqual({present: true, masked: '••••1234', source: 'settings'});
    expect(v.settings.agent.provider).toBe('deepseek');
  });
});

describe('agentStatusOf（上部バーの接続先表示）', () => {
  it('Claude で claude が見つかっていれば使える状態', () => {
    expect(agentStatusOf('claude', 'opus', {claude: true, deepseekKey: false})).toEqual({provider: 'claude', model: 'opus', ready: true, problem: null, issue: null});
  });
  it('DeepSeek で鍵が無ければ使えない状態として理由を出す', () => {
    const st = agentStatusOf('deepseek', 'deepseek-v4-pro', {claude: true, deepseekKey: false});
    expect(st.ready).toBe(false);
    expect(st.problem).toContain('API キー');
  });
  it('claude が無ければ接続先に関わらず使えない', () => {
    expect(agentStatusOf('deepseek', 'deepseek-v4-pro', {claude: false, deepseekKey: true}).problem).toContain('claude');
  });
  it('Codex は Claude が無くても CLI があれば使える', () => {
    expect(agentStatusOf('codex', 'gpt-codex', {claude: false, codex: true, deepseekKey: false}).ready).toBe(true);
    expect(agentStatusOf('codex', 'gpt-codex', {claude: true, codex: false, deepseekKey: false}).issue).toBe('no-codex');
    expect(agentStatusOf('codex', 'gpt-codex', {claude: true, codex: true, codexLoggedIn: false, deepseekKey: false}).issue).toBe('no-codex-login');
  });
});
