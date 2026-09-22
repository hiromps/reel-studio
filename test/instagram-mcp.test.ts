// Instagram の情報取得（Smartgram MCP）: 設定の解決・claude に渡す形・接続テストの応答の読み方。
// 実際の Smartgram には繋がない（fetch を差し替える）。
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {defaultSettings, instagramKeyView, mergeSettings, resetSettings, saveSettings, settingsView} from '../core/settings';
import {INSTAGRAM_MCP_KEY_ENV, INSTAGRAM_MCP_TOOLS, instagramMcpAvailable, instagramMcpEnv, instagramMcpForAgent, instagramToolLabel, isInstagramMcpTool, parseMcpResponse, probeInstagramMcp, resetInstagramMcpEnv} from '../core/instagram-mcp';
import {agentArgs} from '../core/agent';
import {DEFAULT_INSTAGRAM_MCP_URL} from '../shared/schema/settings';
import {studioConfig} from '../studio.config';

let home: string;
const ENV_KEYS = ['SMARTGRAM_MCP_KEY', 'SMARTGRAM_MCP_URL', 'SMARTGRAM_ACCOUNT'];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-igmcp-'));
  process.env.REEL_STUDIO_HOME = home;
  for (const k of ENV_KEYS) delete process.env[k];
  resetSettings();
  resetInstagramMcpEnv();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetSettings();
  resetInstagramMcpEnv();
  vi.unstubAllGlobals();
  fs.rmSync(home, {recursive: true, force: true});
});

describe('instagram-mcp: 設定の解決', () => {
  it('鍵が無ければ null（裏取りは Web 検索だけ）', () => {
    expect(instagramMcpEnv()).toBeNull();
    expect(instagramMcpAvailable()).toBe(false);
    expect(instagramKeyView()).toEqual({present: false, masked: '', source: null});
  });

  it('settings.json の鍵で有効になり、URL は既定、アカウントは任意', () => {
    saveSettings(mergeSettings(defaultSettings(), {instagram: {mcpKey: 'growgram_mcp_settings_0001'}}));
    resetInstagramMcpEnv();
    const e = instagramMcpEnv();
    expect(e?.apiKey).toBe('growgram_mcp_settings_0001');
    expect(e?.url).toBe(DEFAULT_INSTAGRAM_MCP_URL);
    expect(e?.account).toBeUndefined();
    expect(e?.source).not.toContain('0001');
    expect(instagramKeyView()).toEqual({present: true, masked: '••••0001', source: 'settings'});
  });

  it('環境変数は settings.json より強い（鍵・URL・アカウントとも）', () => {
    saveSettings(mergeSettings(defaultSettings(), {instagram: {mcpKey: 'growgram_mcp_settings_0001', mcpUrl: 'https://example.test/mcp', account: 'from-settings'}}));
    process.env.SMARTGRAM_MCP_KEY = 'growgram_mcp_env_9999';
    process.env.SMARTGRAM_MCP_URL = 'https://staging.example.test/mcp';
    process.env.SMARTGRAM_ACCOUNT = 'from-env';
    resetInstagramMcpEnv();
    expect(instagramMcpEnv()).toEqual({apiKey: 'growgram_mcp_env_9999', url: 'https://staging.example.test/mcp', account: 'from-env', source: '環境変数 SMARTGRAM_MCP_KEY'});
    expect(instagramKeyView().source).toBe('env');
  });

  it('${VAR} のままの鍵や空白は無視する', () => {
    process.env.SMARTGRAM_MCP_KEY = '${SMARTGRAM_MCP_KEY}';
    expect(instagramMcpEnv()).toBeNull();
    process.env.SMARTGRAM_MCP_KEY = '   ';
    resetInstagramMcpEnv();
    expect(instagramMcpEnv()).toBeNull();
  });

  it('merge は書いたキーだけ変え、空文字で消える（@ 付きの username は保存側で剥がさない＝画面が剥がす）', () => {
    const cur = mergeSettings(defaultSettings(), {instagram: {mcpKey: 'growgram_mcp_x_0001', account: 'smartgram.jp'}});
    expect(cur.instagram).toEqual({mcpKey: 'growgram_mcp_x_0001', account: 'smartgram.jp'});
    const next = mergeSettings(cur, {instagram: {mcpUrl: 'https://example.test/mcp'}});
    expect(next.instagram).toEqual({mcpKey: 'growgram_mcp_x_0001', account: 'smartgram.jp', mcpUrl: 'https://example.test/mcp'});
    const cleared = mergeSettings(next, {instagram: {mcpKey: '', account: null, mcpUrl: ''}});
    expect(cleared.instagram).toEqual({});
    expect(cleared.tts.modelId).toBe('s2.1-pro-free'); // 触っていない
  });

  it('不正な URL や短すぎる鍵は保存できない', () => {
    expect(() => mergeSettings(defaultSettings(), {instagram: {mcpUrl: 'not a url'}})).toThrow();
    expect(() => mergeSettings(defaultSettings(), {instagram: {mcpKey: 'short'}})).toThrow();
  });

  it('settingsView は鍵を出さず、環境変数で固定されているかを返す', () => {
    saveSettings(mergeSettings(defaultSettings(), {instagram: {mcpKey: 'growgram_mcp_secret_7777', account: 'smartgram.jp'}}));
    const v = settingsView({bin: 'claude', available: false, source: 'none', version: null}, studioConfig.templateDir);
    expect(JSON.stringify(v)).not.toContain('secret_7777');
    expect(v.settings.instagram).toEqual({account: 'smartgram.jp', mcpKey: {present: true, masked: '••••7777', source: 'settings'}});
    expect(v.env.instagramMcpKey).toBe(false);
    process.env.SMARTGRAM_MCP_KEY = 'growgram_mcp_env_0000';
    expect(settingsView({bin: 'claude', available: false, source: 'none', version: null}, studioConfig.templateDir).env.instagramMcpKey).toBe(true);
  });
});

describe('instagram-mcp: claude に渡す形', () => {
  it('config に鍵は入らず ${SMARTGRAM_MCP_KEY} で参照し、実体は env だけ。許可ツールは読み取り専用のものだけ', () => {
    const a = instagramMcpForAgent({url: 'https://app.smartgram.jp/api/mcp', apiKey: 'growgram_mcp_real_1234', source: 'test'});
    const json = JSON.stringify(a.config);
    expect(json).not.toContain('real_1234');
    expect(json).toContain('${SMARTGRAM_MCP_KEY}');
    expect(a.config).toEqual({mcpServers: {smartgram: {type: 'http', url: 'https://app.smartgram.jp/api/mcp', headers: {Authorization: 'Bearer ${SMARTGRAM_MCP_KEY}'}}}});
    expect(a.env).toEqual({[INSTAGRAM_MCP_KEY_ENV]: 'growgram_mcp_real_1234'});
    expect(a.allowedTools).toEqual(INSTAGRAM_MCP_TOOLS.map((t) => `mcp__smartgram__${t}`));
    // 課金されるツール・書き込み系は含めない
    expect(a.allowedTools.join(' ')).not.toMatch(/download_reel_video|get_user_stories|scheduled/);
  });

  it('agentArgs は --mcp-config を JSON 文字列で足し、--strict-mcp-config は常に付く', () => {
    const base = {cwd: '.', prompt: 'p', schema: {type: 'object'}};
    const without = agentArgs(base);
    expect(without).toContain('--strict-mcp-config');
    expect(without).not.toContain('--mcp-config');
    const a = instagramMcpForAgent({url: 'https://app.smartgram.jp/api/mcp', apiKey: 'growgram_mcp_real_1234', source: 'test'});
    const withMcp = agentArgs({...base, mcp: {config: a.config, env: a.env}, allowedTools: ['Read', 'Glob', 'WebSearch', 'WebFetch', ...a.allowedTools]});
    const i = withMcp.indexOf('--mcp-config');
    expect(i).toBeGreaterThan(0);
    expect(JSON.parse(withMcp[i + 1])).toEqual(a.config);
    expect(withMcp.join(' ')).not.toContain('real_1234'); // 鍵は argv に出ない
    expect(withMcp.slice(withMcp.indexOf('--allowedTools') + 1, withMcp.indexOf('--permission-prompts'))).toEqual(['Read', 'Glob', 'WebSearch', 'WebFetch', ...a.allowedTools]);
  });

  it('進捗ラベルはツール名と引数から作る', () => {
    expect(isInstagramMcpTool('mcp__smartgram__get_profile')).toBe(true);
    expect(isInstagramMcpTool('WebFetch')).toBe(false);
    expect(instagramToolLabel('mcp__smartgram__get_profile', {username: 'smartgram.jp', target: 'oc.eat'})).toBe('Instagram のプロフィールを確認中 @oc.eat');
    expect(instagramToolLabel('mcp__smartgram__get_user_posts', {username: 'smartgram.jp'})).toBe('Instagram の投稿を確認中 @smartgram.jp');
    expect(instagramToolLabel('mcp__smartgram__search_users', {username: 'x', query: 'ぼんじり 天満'})).toBe('Instagram を検索中「ぼんじり 天満」');
    expect(instagramToolLabel('mcp__smartgram__list_instagram_accounts')).toBe('Instagram の実行アカウントを確認中');
    expect(instagramToolLabel('mcp__smartgram__something_new')).toBe('Instagram something_new');
  });
});

describe('instagram-mcp: 応答の読み方と接続テスト', () => {
  it('SSE でも素の JSON でも JSON-RPC の応答を取り出す（data が複数行のイベントも繋ぐ）', () => {
    expect(parseMcpResponse('application/json', '{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result).toEqual({a: 1});
    const sse = ['event: message', 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}', '', 'event: message', 'data: {"jsonrpc":"2.0",', 'data: "id":1,"result":{"ok":true}}', ''].join('\n');
    expect(parseMcpResponse('text/event-stream; charset=utf-8', sse).result).toEqual({ok: true});
    expect(() => parseMcpResponse('text/event-stream', 'event: ping\n\n')).toThrow(/JSON-RPC/);
  });

  const sseOf = (json: unknown) => `event: message\ndata: ${JSON.stringify(json)}\n\n`;
  type Handler = (method: string, params: Record<string, unknown>) => {status?: number; body?: unknown};
  const stubFetch = (h: Handler) => {
    const calls: {method: string; auth: string | null; params: Record<string, unknown>}[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const req = JSON.parse(String(init.body)) as {id: number; method: string; params: Record<string, unknown>};
        calls.push({method: req.method, auth: (init.headers as Record<string, string>).Authorization ?? null, params: req.params});
        const r = h(req.method, req.params);
        const status = r.status ?? 200;
        return new Response(status === 200 ? sseOf({jsonrpc: '2.0', id: req.id, result: r.body}) : '', {status, headers: {'content-type': status === 200 ? 'text/event-stream' : 'text/plain'}});
      }),
    );
    return calls;
  };
  const conn = {url: 'https://app.smartgram.jp/api/mcp', apiKey: 'growgram_mcp_test_0001'};
  const toolText = (v: unknown) => ({content: [{type: 'text', text: JSON.stringify(v)}]});

  it('initialize → tools/list → list_instagram_accounts の順に叩き、登録アカウントと有効数を返す', async () => {
    const calls = stubFetch((method) => {
      if (method === 'initialize') return {body: {protocolVersion: '2025-06-18', serverInfo: {name: 'growgram-insights', version: '1.0.0'}}};
      if (method === 'tools/list') return {body: {tools: [...INSTAGRAM_MCP_TOOLS, 'download_reel_video'].map((name) => ({name}))}};
      return {body: toolText({accounts: [{username: 'smartgram.jp', isActive: true, fullName: 'Smartgram', followerCount: 12}, {username: 'oc.eat', isActive: false}, {username: ''}]})};
    });
    const r = await probeInstagramMcp(conn);
    expect(r.ok).toBe(true);
    expect(r.server).toBe('growgram-insights');
    expect(r.accounts).toEqual([{username: 'smartgram.jp', active: true, fullName: 'Smartgram', followers: 12}, {username: 'oc.eat', active: false}]);
    expect(r.message).toContain('登録アカウント 2 件、うち有効 1 件');
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    expect(calls[2].params).toEqual({name: 'list_instagram_accounts', arguments: {}});
    expect(calls.every((c) => c.auth === 'Bearer growgram_mcp_test_0001')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('test_0001'); // 応答に鍵は入らない
  });

  it('鍵が拒否されたら 401 を人の言葉にする', async () => {
    stubFetch(() => ({status: 401}));
    const r = await probeInstagramMcp(conn);
    expect(r).toEqual({ok: false, status: 401, message: expect.stringContaining('鍵が拒否されました（HTTP 401）')});
  });

  it('裏取りに使うツールが無いサーバーは ok にしない', async () => {
    stubFetch((method) => {
      if (method === 'initialize') return {body: {serverInfo: {name: 'other'}}};
      if (method === 'tools/list') return {body: {tools: [{name: 'get_profile'}]}};
      return {body: toolText({accounts: []})};
    });
    const r = await probeInstagramMcp(conn);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('list_instagram_accounts');
    expect(r.message).not.toContain('get_profile,');
  });

  it('一覧のツールがエラーでも鍵とツールの確認は ok のまま', async () => {
    stubFetch((method) => {
      if (method === 'initialize') return {body: {serverInfo: {name: 'growgram-insights'}}};
      if (method === 'tools/list') return {body: {tools: INSTAGRAM_MCP_TOOLS.map((name) => ({name}))}};
      return {body: {content: [{type: 'text', text: 'rate limited'}], isError: true}};
    });
    const r = await probeInstagramMcp(conn);
    expect(r.ok).toBe(true);
    expect(r.accounts).toEqual([]);
    expect(r.message).toContain('一覧は取れませんでした');
  });

  it('繋がらないときは例外にせず ok=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const r = await probeInstagramMcp(conn);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ECONNREFUSED');
  });
});
