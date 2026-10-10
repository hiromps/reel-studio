// セットアップで見つけたツールをサーバー・CLI・音声合成の子プロセスへ引き継ぐ。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeFile = process.env.REEL_STUDIO_RUNTIME_FILE || path.join(appRoot, '.runtime', 'tools.json');

export function runtimeEnv(base = process.env, file = runtimeFile) {
  let tools = {};
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record && typeof record === 'object') tools = record;
  } catch { /* 初回は未作成 */ }
  const env = {...base};
  const dirs = [path.dirname(process.execPath), env.REEL_STUDIO_FFMPEG_DIR || tools.ffmpegDir].filter((p) => typeof p === 'string' && fs.existsSync(p));
  // Windows の環境変数は大小文字を区別しない。Path/PATHを二重に渡さない。
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...new Set([...dirs, ...(env[pathKey] ?? '').split(path.delimiter)])].join(path.delimiter);
  if (!env.REEL_STUDIO_BROWSER_EXECUTABLE && typeof tools.browser === 'string' && fs.existsSync(tools.browser)) {
    env.REEL_STUDIO_BROWSER_EXECUTABLE = tools.browser;
  }
  return env;
}
