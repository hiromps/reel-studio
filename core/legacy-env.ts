// 旧来の置き場（Claude Code の settings.local.json / .mcp.json の env）から Fish Audio の鍵を取り込む。
// `reel settings import-legacy` 専用。値は呼び出し側が settings.json に書くだけで、表示・ログには出さない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const readJsonSafe = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** `${FOO}` のような参照はそのままでは使えない（展開元はここには無い） */
const literal = (v: unknown): string | null => (typeof v === 'string' && v && !v.startsWith('${') ? v : null);

/** settings.json の env ブロックと、.mcp.json の mcpServers.<name>.env の両方を平らにする */
const envBlock = (file: string): Record<string, unknown> => {
  const j = readJsonSafe(file);
  const out: Record<string, unknown> = {};
  const env = j?.env;
  if (env && typeof env === 'object') Object.assign(out, env);
  const servers = j?.mcpServers;
  if (servers && typeof servers === 'object')
    for (const s of Object.values(servers as Record<string, {env?: Record<string, unknown>}>)) if (s?.env) for (const [k, v] of Object.entries(s.env)) if (!(k in out)) out[k] = v;
  return out;
};

export type LegacyFishEnv = {apiKey?: string; modelId?: string; /** 見つけたファイル（値は含まない） */ sources: {apiKey?: string; modelId?: string}};

/** 探す順: <dir>/.claude/settings.local.json → <dir>/.mcp.json → ~/.claude/settings.json */
export const readLegacyFishEnv = (dir?: string): LegacyFishEnv => {
  const candidates: string[] = [];
  if (dir) candidates.push(path.join(dir, '.claude', 'settings.local.json'), path.join(dir, '.mcp.json'));
  candidates.push(path.join(os.homedir(), '.claude', 'settings.json'));
  const out: LegacyFishEnv = {sources: {}};
  for (const file of candidates) {
    if (out.apiKey && out.modelId) break;
    const env = envBlock(file);
    if (!out.apiKey) {
      const k = literal(env.FISH_API_KEY);
      if (k) {
        out.apiKey = k;
        out.sources.apiKey = file;
      }
    }
    if (!out.modelId) {
      const m = literal(env.FISH_MODEL_ID);
      if (m) {
        out.modelId = m;
        out.sources.modelId = file;
      }
    }
  }
  return out;
};
