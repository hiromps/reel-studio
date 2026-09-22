// Instagram の情報取得（Smartgram の MCP サーバー）の、環境に依存しない部分。
//
// Smartgram（app.smartgram.jp）は MCP サーバー（growgram-insights）として、登録済みアカウント経由で
// 任意の公開アカウントのプロフィール・投稿・ユーザー検索を返す。Reel Studio はこれを
// 店舗情報の裏取り（core/ai.ts の aiFacts）で、裏で走らせる claude に MCP サーバーとして渡す。
//
// ここにはツール名・進捗ラベル・JSON-RPC の薄いクライアント（接続テスト用）だけを置く。
// 設定ファイル（鍵の在り処）に依存する部分は core/instagram-mcp.ts。クラウド（Vercel）からも
// 接続テストを叩けるよう、node 固有のものは import しない（fetch だけ）。
import type {InstagramAccount} from './schema/settings';

/** --mcp-config 内でのサーバー名。ツール名は mcp__smartgram__<tool> になる */
export const INSTAGRAM_MCP_SERVER = 'smartgram';
/** 鍵を子プロセスに渡す環境変数（設定 JSON では ${...} で参照する） */
export const INSTAGRAM_MCP_KEY_ENV = 'SMARTGRAM_MCP_KEY';

/**
 * 裏取りで claude に許可するツール。読むだけのもの、かつ HikerAPI のトークンを消費しないものに絞る
 * （get_user_stories / download_reel_video は課金される。フォロワー一覧・インサイト・予約投稿は裏取りに要らない）
 */
export const INSTAGRAM_MCP_TOOLS = ['list_instagram_accounts', 'search_users', 'get_profile', 'get_user_posts', 'get_api_usage'] as const;
export type InstagramMcpTool = (typeof INSTAGRAM_MCP_TOOLS)[number];

export const instagramMcpToolName = (tool: string): string => `mcp__${INSTAGRAM_MCP_SERVER}__${tool}`;
const TOOL_PREFIX = instagramMcpToolName('');

export const isInstagramMcpTool = (name: string): boolean => name.startsWith(TOOL_PREFIX);

/** 進捗表示用のラベル（ツール呼び出しのたびに出す） */
export const instagramToolLabel = (name: string, input: Record<string, unknown> = {}): string => {
  const tool = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const target = str('target') || str('username');
  switch (tool) {
    case 'list_instagram_accounts':
      return 'Instagram の実行アカウントを確認中';
    case 'search_users':
      return `Instagram を検索中「${str('query')}」`;
    case 'get_profile':
      return `Instagram のプロフィールを確認中 @${target}`;
    case 'get_user_posts':
      return `Instagram の投稿を確認中 @${target}`;
    case 'get_api_usage':
      return 'Instagram API の残量を確認中';
    default:
      return `Instagram ${tool}`;
  }
};

// ───────────────────────── JSON-RPC（接続テスト用） ─────────────────────────

export type JsonRpcResponse = {jsonrpc?: string; id?: number | string; result?: unknown; error?: {code?: number; message?: string}};

/**
 * Streamable HTTP の応答は素の JSON か SSE（`event: message` / `data: {...}`）。
 * SSE は data 行をイベントごとに繋ぎ、JSON-RPC の応答（result か error を持つもの）の最後の 1 件を返す
 */
export const parseMcpResponse = (contentType: string, body: string): JsonRpcResponse => {
  if (!contentType.toLowerCase().includes('text/event-stream')) return JSON.parse(body) as JsonRpcResponse;
  const events: string[] = [];
  let cur: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      if (cur.length) events.push(cur.join('\n'));
      cur = [];
      continue;
    }
    if (line.startsWith('data:')) cur.push(line.slice(5).replace(/^ /, ''));
  }
  if (cur.length) events.push(cur.join('\n'));
  let found: JsonRpcResponse | null = null;
  for (const ev of events) {
    try {
      const j = JSON.parse(ev) as JsonRpcResponse;
      if (j && (j.result !== undefined || j.error !== undefined)) found = j;
    } catch {
      // 進捗などの JSON でないイベントは無視
    }
  }
  if (!found) throw new Error('SSE に JSON-RPC の応答が無い');
  return found;
};

export class InstagramMcpError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type InstagramMcpConn = {url: string; apiKey: string};

/** 1 回の JSON-RPC 呼び出し。HTTP エラーと JSON-RPC の error は InstagramMcpError にする（鍵は含めない） */
export const mcpCall = async <T = unknown>(conn: InstagramMcpConn, method: string, params: Record<string, unknown> = {}, opt: {signal?: AbortSignal; id?: number} = {}): Promise<T> => {
  const res = await fetch(conn.url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${conn.apiKey}`},
    body: JSON.stringify({jsonrpc: '2.0', id: opt.id ?? 1, method, params}),
    signal: opt.signal,
  });
  if (res.status === 401 || res.status === 403) throw new InstagramMcpError(`鍵が拒否されました（HTTP ${res.status}）。Smartgram の MCP 用 API キーを確認してください`, res.status);
  if (!res.ok) throw new InstagramMcpError(`MCP サーバーが HTTP ${res.status} を返しました`, res.status);
  const body = await res.text();
  let parsed: JsonRpcResponse;
  try {
    parsed = parseMcpResponse(res.headers.get('content-type') ?? '', body);
  } catch (e) {
    throw new InstagramMcpError(`MCP サーバーの応答を読めません: ${e instanceof Error ? e.message : String(e)}`, res.status);
  }
  if (parsed.error) throw new InstagramMcpError(`MCP サーバーがエラーを返しました: ${parsed.error.message ?? `code ${parsed.error.code ?? '?'}`}`, res.status);
  return parsed.result as T;
};

type ToolResult = {content?: {type?: string; text?: string}[]; isError?: boolean};

/** tools/call の結果（content の text に入った JSON）を読む */
const toolJson = <T>(r: ToolResult): T => {
  const text = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string).join('\n');
  if (r.isError) throw new InstagramMcpError(`ツールがエラーを返しました: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
};

export type InstagramMcpProbe = {
  ok: boolean;
  status?: number;
  message: string;
  /** サーバーが名乗った名前（growgram-insights など） */
  server?: string;
  /** サーバーにあるツール名 */
  tools?: string[];
  /** 登録済みのアカウント（username 引数の候補） */
  accounts?: InstagramAccount[];
};

/**
 * 鍵が通り、裏取りに使うツールが揃っているか（Settings の接続テスト）。
 * initialize → tools/list → list_instagram_accounts の順に叩く（Instagram 本体にはアクセスしない）
 */
export const probeInstagramMcp = async (conn: InstagramMcpConn, opt: {signal?: AbortSignal} = {}): Promise<InstagramMcpProbe> => {
  try {
    const init = await mcpCall<{serverInfo?: {name?: string; version?: string}}>(
      conn,
      'initialize',
      {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'reel-studio', version: '0'}},
      {signal: opt.signal, id: 1},
    );
    const server = init?.serverInfo?.name;
    const list = await mcpCall<{tools?: {name: string}[]}>(conn, 'tools/list', {}, {signal: opt.signal, id: 2});
    const tools = (list?.tools ?? []).map((t) => t.name);
    const missing = INSTAGRAM_MCP_TOOLS.filter((t) => !tools.includes(t));
    if (missing.length) return {ok: false, message: `接続はできましたが、裏取りに使うツールがありません: ${missing.join(', ')}（サーバー ${server ?? '?'}）`, server, tools};
    let accounts: InstagramAccount[] = [];
    try {
      const raw = toolJson<{accounts?: {username?: string; isActive?: boolean; fullName?: string; followerCount?: number}[]}>(
        await mcpCall<ToolResult>(conn, 'tools/call', {name: 'list_instagram_accounts', arguments: {}}, {signal: opt.signal, id: 3}),
      );
      accounts = (raw.accounts ?? [])
        .filter((a) => typeof a.username === 'string' && a.username)
        .map((a) => ({username: a.username as string, active: !!a.isActive, ...(a.fullName ? {fullName: a.fullName} : {}), ...(typeof a.followerCount === 'number' ? {followers: a.followerCount} : {})}));
    } catch (e) {
      // 一覧が取れなくても鍵とツールは確認できている。メッセージにだけ残す
      return {ok: true, message: `接続できました（${server ?? 'MCP'}・ツール ${tools.length} 個）。登録アカウントの一覧は取れませんでした: ${e instanceof Error ? e.message : String(e)}`, server, tools, accounts: []};
    }
    const active = accounts.filter((a) => a.active).length;
    return {
      ok: true,
      message: `接続できました（${server ?? 'MCP'}・ツール ${tools.length} 個・登録アカウント ${accounts.length} 件${accounts.length ? `、うち有効 ${active} 件` : ''}）`,
      server,
      tools,
      accounts,
    };
  } catch (e) {
    if (e instanceof InstagramMcpError) return {ok: false, status: e.status, message: e.message};
    return {ok: false, message: `接続できません: ${e instanceof Error ? e.message : String(e)}`};
  }
};
