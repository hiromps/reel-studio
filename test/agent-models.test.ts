import {afterEach, describe, expect, it, vi} from 'vitest';
import {listAgentModels} from '../core/agent-models';
import {codexArgs} from '../core/codex';
import {defaultSettings, mergeSettings} from '../core/settings';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('プロバイダーのモデル選択肢', () => {
  it('DeepSeek の API 応答に新しいモデルが増えたらそのまま候補に入る', async () => {
    const fetcher = vi.fn().mockResolvedValue({ok: true, json: async () => ({data: [
      {id: 'deepseek-future', name: 'Future'}, {id: 'deepseek-current', name: 'Current'},
    ]})});
    vi.stubGlobal('fetch', fetcher);
    const catalog = await listAgentModels('deepseek', {deepseekKey: 'sk-example'});
    expect(catalog.models.map((m) => m.id)).toEqual(['deepseek-future', 'deepseek-current']);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-example');
    expect(JSON.stringify(catalog)).not.toContain('sk-example');
  });

  it('Claude API キーがあれば公式のモデル一覧から選択肢を作る', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: true, json: async () => ({data: [{id: 'claude-future', display_name: 'Claude Future'}]})}));
    expect((await listAgentModels('claude')).models).toEqual([{id: 'claude-future', label: 'Claude Future（claude-future）'}]);
  });

  it('手入力なしで Codex のモデル ID と MCP を CLI に渡す', () => {
    const args = codexArgs({cwd: '.', prompt: 'test', schema: {}, model: 'gpt-codex', mcp: {
      config: {mcpServers: {instagram: {type: 'http', url: 'https://example.com/mcp', headers: {Authorization: 'Bearer ${SMARTGRAM_MCP_KEY}'}}}},
      env: {SMARTGRAM_MCP_KEY: 'secret'},
    }}, 'schema.json');
    expect(args).toContain('gpt-codex');
    expect(args).toContain('mcp_servers.instagram.bearer_token_env_var="SMARTGRAM_MCP_KEY"');
    expect(args.join(' ')).not.toContain('secret');
  });

  it('Codex のモデルと実行ファイル設定を保存できる', () => {
    const next = mergeSettings(defaultSettings(), {agent: {provider: 'codex', codexModel: 'gpt-codex', codexBin: '/opt/codex'}});
    expect(next.agent).toMatchObject({provider: 'codex', codexModel: 'gpt-codex', codexBin: '/opt/codex'});
  });
});
