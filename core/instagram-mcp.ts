// Instagram の情報取得（Smartgram の MCP サーバー）の、設定ファイルに依存する部分。
//
// 店舗情報の裏取り（core/ai.ts の aiFacts）で、店の公式 Instagram を読むために使う。
// Instagram のページは WebFetch だとログイン壁で読めないことが多く、検索スニペット頼みだった。
// Smartgram の MCP を裏で走らせる claude に渡す（--mcp-config。--strict-mcp-config なのでこれ以外は
// 読み込まれない）ことで、登録済みアカウント経由で公開アカウントのプロフィール・投稿を直接読める。
//
// - 鍵は argv にもファイルにも出さない。設定の JSON には `${SMARTGRAM_MCP_KEY}` と書き、値は子プロセスの
//   環境変数で渡す（Claude Code が MCP 設定の ${VAR} を展開する。2026-09-23 に実走で確認）
// - 鍵の値はログ・例外文・画面用の view には載せない（core/settings.ts と同じ方針）
// - ツール名・進捗ラベル・接続テスト（JSON-RPC）は shared/instagram-mcp.ts（クラウドからも使う）
import {loadSettings} from './settings';
import {DEFAULT_INSTAGRAM_MCP_URL} from '../shared/schema/settings';
import {INSTAGRAM_MCP_KEY_ENV, INSTAGRAM_MCP_SERVER, INSTAGRAM_MCP_TOOLS, instagramMcpToolName} from '../shared/instagram-mcp';

export {
  INSTAGRAM_MCP_KEY_ENV,
  INSTAGRAM_MCP_SERVER,
  INSTAGRAM_MCP_TOOLS,
  InstagramMcpError,
  instagramMcpToolName,
  instagramToolLabel,
  isInstagramMcpTool,
  mcpCall,
  parseMcpResponse,
  probeInstagramMcp,
  type InstagramMcpProbe,
} from '../shared/instagram-mcp';

export type InstagramMcpEnv = {
  url: string;
  apiKey: string;
  /** MCP ツールの username 引数に渡す登録済みアカウント。無ければ claude が一覧から選ぶ */
  account?: string;
  /** 鍵の出どころ（値は含めない） */
  source: string;
};

/** 空白だけ・${VAR} のままの値は「無い」扱い */
const literal = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t && !t.startsWith('${') ? t : undefined;
};

let cached: InstagramMcpEnv | null | undefined;

/** 環境変数（SMARTGRAM_MCP_KEY / SMARTGRAM_MCP_URL / SMARTGRAM_ACCOUNT）→ settings.json の順。鍵が無ければ null */
export const instagramMcpEnv = (): InstagramMcpEnv | null => {
  if (cached !== undefined) return cached;
  const s = loadSettings().instagram;
  const envKey = literal(process.env.SMARTGRAM_MCP_KEY);
  const apiKey = envKey ?? literal(s.mcpKey);
  const url = literal(process.env.SMARTGRAM_MCP_URL) ?? literal(s.mcpUrl) ?? DEFAULT_INSTAGRAM_MCP_URL;
  const account = literal(process.env.SMARTGRAM_ACCOUNT) ?? literal(s.account);
  cached = apiKey ? {url, apiKey, account, source: envKey ? '環境変数 SMARTGRAM_MCP_KEY' : 'settings.json'} : null;
  return cached;
};

/** テストや設定変更後に読み直す */
export const resetInstagramMcpEnv = (): void => {
  cached = undefined;
};

export const instagramMcpAvailable = (): boolean => !!instagramMcpEnv();

export type InstagramMcpForAgent = {
  /** --mcp-config に渡す JSON。鍵は入っておらず ${SMARTGRAM_MCP_KEY} で参照している */
  config: Record<string, unknown>;
  /** 子プロセスに足す環境変数（鍵の実体はここだけ） */
  env: Record<string, string>;
  /** --allowedTools に足す完全なツール名 */
  allowedTools: string[];
};

/** runAgent に渡す MCP 設定。JSON に鍵は書かず、env で渡す */
export const instagramMcpForAgent = (env: InstagramMcpEnv): InstagramMcpForAgent => ({
  config: {mcpServers: {[INSTAGRAM_MCP_SERVER]: {type: 'http', url: env.url, headers: {Authorization: `Bearer \${${INSTAGRAM_MCP_KEY_ENV}}`}}}},
  env: {[INSTAGRAM_MCP_KEY_ENV]: env.apiKey},
  allowedTools: INSTAGRAM_MCP_TOOLS.map(instagramMcpToolName),
});
