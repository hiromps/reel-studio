// ローカルにインストールされた Claude Code CLI（claude.exe）を子プロセスとして走らせ、
// JSON Schema で形を固定した構造化出力だけを受け取る薄いラッパ。
//
// 方針：
// - エージェントには**書き込みをさせない**（--allowedTools は Read/Glob のみ）。
//   契約ファイルへの反映は呼び出し側が zod で検証してから行う（importTags / importOrder）。
// - 権限プロンプトが出たら自動で拒否（--permission-prompts none）。GUI からは答えられないため。
// - ワークスペースの MCP サーバーは読み込まない（--strict-mcp-config）。起動が遅くなるうえ
//   システムプロンプトが数万トークン膨らみ、タグ付けには 1 つも要らない。
// - 認証はユーザーの既存ログインをそのまま使う（API キーの設定は不要）。--bare は OAuth を
//   読まない仕様なので使わない。
import fs from 'node:fs';
import path from 'node:path';
import {exec, isWindows, type ExecOptions} from './exec';
import {loadSettings} from './settings';
import type {AgentEvent} from '../shared/agent-progress';

export class AgentError extends Error {
  detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.detail = detail;
  }
}

export type ClaudeBinInfo = {bin: string; source: 'env' | 'settings' | 'path' | 'none'};

let cachedBin: ClaudeBinInfo | null = null;

/** claude 実行ファイルの場所。REEL_STUDIO_CLAUDE_BIN > Settings「AI」の claudeBin > PATH の順 */
export const claudeBinInfo = (): ClaudeBinInfo => {
  if (cachedBin) return cachedBin;
  const fromEnv = process.env.REEL_STUDIO_CLAUDE_BIN?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return (cachedBin = {bin: fromEnv, source: 'env'});
  const fromSettings = loadSettings().agent.claudeBin?.trim();
  if (fromSettings && fs.existsSync(fromSettings)) return (cachedBin = {bin: fromSettings, source: 'settings'});
  const names = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return (cachedBin = {bin: p, source: 'path'});
    }
  }
  // 見つからなければ素の名前で spawn を試す（PATH 解決は OS に任せる）
  return (cachedBin = {bin: names[0], source: 'none'});
};

export const claudeBin = (): string => claudeBinInfo().bin;

/** 設定を変えたあとに探し直す */
export const resetClaudeBin = (): void => {
  cachedBin = null;
};

export const claudeAvailable = (): boolean => {
  const b = claudeBin();
  return path.isAbsolute(b) ? fs.existsSync(b) : false;
};

/** `claude --version` の 1 行目。動かなければ null（接続テストと Settings の表示用） */
export const claudeVersion = async (bin = claudeBin()): Promise<string | null> => {
  try {
    const r = await exec(bin, ['--version'], {timeoutMs: 20_000});
    if (r.code !== 0) return null;
    return r.stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
};

export type AgentRun<T> = {
  data: T;
  costUsd: number;
  durationMs: number;
  turns: number;
  sessionId?: string;
};

/** エージェントが作業中に出すもの（進捗表示に使う）。型は shared/agent-progress.ts が正 */
export type {AgentEvent} from '../shared/agent-progress';

export type AgentOptions = {
  /** 作業ディレクトリ。ここからの相対パスで Read させる */
  cwd: string;
  prompt: string;
  /** 返り値の形（JSON Schema）。CLI 側で検証される */
  schema: Record<string, unknown>;
  /** 既定は studioConfig.agent.model */
  model?: string;
  /** cwd 以外に読ませたいディレクトリ */
  addDirs?: string[];
  /** 既定 Read + Glob。書き込み系は絶対に足さないこと */
  allowedTools?: string[];
  timeoutMs?: number;
  onLine?: (line: string) => void;
  /** 作業の途中経過（起動・思考・ツール呼び出し・出力・書き出し・定期の heartbeat）。進捗表示に使う */
  onEvent?: (e: AgentEvent) => void;
  /** heartbeat の間隔（既定 5 秒）。画を見ずに考えている間も「動いている」と分かるようにするため */
  heartbeatMs?: number;
  signal?: AbortSignal;
};

type CliResult = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
  permission_denials?: {tool_name?: string}[];
  api_error_status?: unknown;
};

/**
 * claude -p を 1 回走らせて構造化出力を受け取る。
 * stdout だけを JSON として読む（stderr が混ざると壊れるため exec の結果を分けて扱う）。
 */
export async function runAgent<T = unknown>(opt: AgentOptions): Promise<AgentRun<T>> {
  const bin = claudeBin();
  const args = [
    '-p',
    opt.prompt,
    // stream-json だと作業中のツール使用が 1 行ずつ流れてくる（進捗を出せる）。最後の 1 行が結果
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(opt.schema),
    '--allowedTools',
    ...(opt.allowedTools ?? ['Read', 'Glob']),
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
  ];
  if (opt.model) args.push('--model', opt.model);
  for (const d of opt.addDirs ?? []) args.push('--add-dir', d);

  // stdout は 1 行 1 JSON。type=result が最終結果で、それ以外は途中経過
  //   system/init … モデルが動き出した ／ assistant … 思考・本文・ツール呼び出し ／ user … ツールの結果
  let parsed: CliResult | null = null;
  type StreamLine = {type?: string; subtype?: string; model?: string; message?: {content?: {type?: string; name?: string; input?: Record<string, unknown>; text?: string}[]}};
  const takeLine = (line: string) => {
    let d: StreamLine & CliResult;
    try {
      d = JSON.parse(line) as StreamLine & CliResult;
    } catch {
      return; // 進捗行は落としても結果には影響しない
    }
    if (d.type === 'result') {
      parsed = d;
      return;
    }
    if (!opt.onEvent) return;
    if (d.type === 'system') {
      if (d.subtype === 'init' || !d.subtype) opt.onEvent({kind: 'init', model: d.model});
      return;
    }
    if (d.type === 'user') {
      if ((d.message?.content ?? []).some((b) => b.type === 'tool_result')) opt.onEvent({kind: 'tool_result'});
      return;
    }
    if (d.type !== 'assistant') return;
    for (const b of d.message?.content ?? []) {
      if (b.type === 'tool_use' && b.name) opt.onEvent({kind: 'tool', name: b.name, input: b.input ?? {}});
      else if (b.type === 'text' && b.text?.trim()) opt.onEvent({kind: 'text', text: b.text.trim()});
      else if (b.type === 'thinking') opt.onEvent({kind: 'thinking'});
    }
  };
  // 何も出力が無い間（考えている間）も進捗の表示が止まって見えないよう、一定間隔で経過秒を流す
  const startedAt = Date.now();
  const heartbeat = opt.onEvent ? setInterval(() => opt.onEvent?.({kind: 'heartbeat', elapsedSec: (Date.now() - startedAt) / 1000}), opt.heartbeatMs ?? 5000) : undefined;

  const execOpt: ExecOptions = {
    cwd: opt.cwd,
    timeoutMs: opt.timeoutMs ?? 20 * 60_000,
    signal: opt.signal,
    onLine: (line, stream) => (stream === 'stdout' ? takeLine(line) : opt.onLine?.(line)),
  };
  let r: Awaited<ReturnType<typeof exec>>;
  try {
    r = await exec(bin, args, execOpt);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  if (r.signal || (r.code !== 0 && !r.stdout.trim())) {
    throw new AgentError(`claude の起動に失敗（終了コード ${r.code}${r.signal ? ` / ${r.signal}` : ''}）`, r.stderr.trim().split(/\r?\n/).slice(-5).join('\n'));
  }
  // 取りこぼし対策：最後の行が result のことがある
  if (!parsed) for (const line of r.stdout.trim().split(/\r?\n/).reverse()) if ((takeLine(line), parsed)) break;
  // 別関数（takeLine）の中で代入しているので、型の絞り込みを一度リセットする
  const res = parsed as CliResult | null;
  if (!res) throw new AgentError('claude の出力を JSON として読めなかった', r.stdout.slice(-800) || r.stderr.slice(-800));
  const denied = (res.permission_denials ?? []).map((d) => d.tool_name).filter(Boolean);
  if (res.is_error) {
    throw new AgentError(
      `claude が失敗を返した（${res.subtype ?? 'error'}${res.api_error_status ? ` / api ${String(res.api_error_status)}` : ''}）`,
      [res.result ?? '', denied.length ? `権限拒否: ${denied.join(', ')}` : ''].filter(Boolean).join('\n'),
    );
  }
  if (res.structured_output === undefined || res.structured_output === null) {
    throw new AgentError('claude が構造化出力を返さなかった', [res.result ?? '', denied.length ? `権限拒否: ${denied.join(', ')}` : ''].filter(Boolean).join('\n'));
  }
  if (denied.length) opt.onLine?.(`（権限拒否されたツール: ${denied.join(', ')}）`);
  return {
    data: res.structured_output as T,
    costUsd: res.total_cost_usd ?? 0,
    durationMs: res.duration_ms ?? 0,
    turns: res.num_turns ?? 0,
    sessionId: res.session_id,
  };
}
