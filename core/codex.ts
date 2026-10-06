// Codex CLI を読み取り専用で実行する。構造化結果は一時的な JSON Schema ファイルで指定する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {exec, isWindows, killTree} from './exec';
import {appRoot, loadSettings} from './settings';
import {AgentError, type AgentOptions, type AgentRun} from './agent';
import type {AgentModelOption} from '../shared/schema/settings';

export type CodexBinInfo = {bin: string; source: 'env' | 'settings' | 'path' | 'none'};

export const codexBinInfo = (): CodexBinInfo => {
  const env = process.env.REEL_STUDIO_CODEX_BIN?.trim();
  if (env) return {bin: env, source: 'env'};
  const configured = loadSettings().agent.codexBin?.trim();
  if (configured) return {bin: configured, source: 'settings'};
  const local = path.join(appRoot, 'node_modules', '.bin', isWindows ? 'codex.cmd' : 'codex');
  if (fs.existsSync(local)) return {bin: local, source: 'path'};
  const names = isWindows ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const bin = path.join(dir, name);
      if (fs.existsSync(bin)) return {bin, source: 'path'};
    }
  }
  return {bin: names[0], source: 'none'};
};

/** npm の Windows .cmd shim は spawn できないため、同梱の JS エントリを node で起動する。 */
export const codexCommand = (bin = codexBinInfo().bin): {bin: string; prefix: string[]} => {
  if (isWindows && bin.toLowerCase().endsWith('.cmd')) {
    const script = [
      path.join(path.dirname(bin), '..', '@openai', 'codex', 'bin', 'codex.js'),
      path.join(path.dirname(bin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ].find((candidate) => fs.existsSync(candidate));
    if (!script) throw new AgentError('Codex CLI の実体が見つかりません', `npm の ${bin} を確認してください`);
    return {bin: process.execPath, prefix: [script]};
  }
  return {bin, prefix: []};
};

export const codexAvailable = (): boolean => {
  const info = codexBinInfo();
  try {
    codexCommand(info.bin);
    return info.source !== 'none' && fs.existsSync(info.bin);
  } catch {
    return false;
  }
};

export const codexVersion = async (bin = codexBinInfo().bin): Promise<string | null> => {
  try {
    const c = codexCommand(bin);
    const r = await exec(c.bin, [...c.prefix, '--version'], {timeoutMs: 20_000});
    return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] || null : null;
  } catch {
    return null;
  }
};

export const codexLoggedIn = async (bin = codexBinInfo().bin): Promise<boolean> => {
  if (process.env.OPENAI_API_KEY?.trim()) return true;
  try {
    const c = codexCommand(bin);
    const r = await exec(c.bin, [...c.prefix, 'login', 'status'], {timeoutMs: 10_000});
    return r.code === 0;
  } catch {
    return false;
  }
};

/** Codex app-server の model/list。CLI が使うモデルカタログを毎回問い合わせる。 */
export const listCodexModels = async (bin = codexBinInfo().bin): Promise<AgentModelOption[]> => {
  const c = codexCommand(bin);
  return new Promise((resolve, reject) => {
    const child = spawn(c.bin, [...c.prefix, 'app-server', '--listen', 'stdio://'], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let buffer = '';
    let done = false;
    const finish = (error?: Error, models?: AgentModelOption[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const timer = setTimeout(() => finish(new Error('Codex のモデル一覧取得が時間切れです')), 25_000);
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(new Error('Codex app-server が終了しました')));
    const send = (body: unknown) => child.stdin?.write(`${JSON.stringify(body)}\n`);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let msg: {id?: number; result?: {data?: {model?: string; slug?: string; displayName?: string; name?: string}[]}; error?: {message?: string}};
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message ?? 'Codex の初期化に失敗しました'));
          send({method: 'initialized', params: {}});
          send({id: 2, method: 'model/list', params: {limit: 100, includeHidden: false}});
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(msg.error.message ?? 'Codex のモデル一覧を取得できません'));
          const models = (msg.result?.data ?? []).map((item) => ({id: item.model ?? item.slug ?? '', label: item.displayName ?? item.name ?? item.model ?? item.slug ?? ''})).filter((item) => item.id);
          finish(undefined, models);
        }
      }
    });
    send({id: 1, method: 'initialize', params: {clientInfo: {name: 'reel_studio', title: 'Reel Studio', version: '0.3.2'}}});
  });
};

export const codexArgs = (opt: AgentOptions, schemaPath: string): string[] => [
  'exec', '--json', '--sandbox', 'read-only', '--config', 'approval_policy="never"', '--ephemeral', '--skip-git-repo-check',
  '--output-schema', schemaPath,
  ...(opt.model ? ['--model', opt.model] : []),
  // Claude 形式の HTTP MCP 設定を Codex の一時設定へ変換する。鍵の値は argv に載せない。
  ...Object.entries((opt.mcp?.config.mcpServers ?? {}) as Record<string, {url?: string; headers?: Record<string, string>}>).flatMap(([name, server]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !server.url) return [];
    const tokenVar = server.headers?.Authorization?.match(/^Bearer \$\{([A-Z][A-Z0-9_]*)\}$/)?.[1];
    return ['--config', `mcp_servers.${name}.url=${JSON.stringify(server.url)}`, ...(tokenVar ? ['--config', `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(tokenVar)}`] : [])];
  }),
  '-',
];

/** Codex の response_format は object の全 properties を required に含める必要がある。 */
export const codexOutputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const object = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    if (object.type === 'object' && object.properties && typeof object.properties === 'object' && !Array.isArray(object.properties)) {
      object.required = Object.keys(object.properties);
    }
    return object;
  };
  return visit(schema) as Record<string, unknown>;
};

export async function runCodex<T = unknown>(opt: AgentOptions): Promise<AgentRun<T>> {
  if (!codexAvailable()) throw new AgentError('codex 実行ファイルが見つかりません', 'Codex CLI をインストールするか、Settings の「AI」で実行ファイルを指定してください');
  if (!await codexLoggedIn()) throw new AgentError('Codex CLI にログインしていません', 'ターミナルで codex login を実行してください');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-codex-'));
  const schemaPath = path.join(temp, 'schema.json');
  fs.writeFileSync(schemaPath, JSON.stringify(codexOutputSchema(opt.schema)), 'utf8');
  const command = codexCommand();
  let answer = '';
  let turns = 0;
  let turnStatus = '';
  let failure = '';
  const started = Date.now();
  const heartbeat = opt.onEvent ? setInterval(() => opt.onEvent?.({kind: 'heartbeat', elapsedSec: (Date.now() - started) / 1000}), opt.heartbeatMs ?? 5000) : undefined;
  try {
    opt.onLine?.(`（AI の接続先: Codex ／ モデル ${opt.model || 'CLI の既定'}）`);
    const result = await exec(command.bin, [...command.prefix, ...codexArgs(opt, schemaPath)], {
      cwd: opt.cwd,
      input: opt.prompt,
      env: opt.mcp?.env,
      timeoutMs: opt.timeoutMs ?? 20 * 60_000,
      signal: opt.signal,
      onLine: (line, stream) => {
        if (stream === 'stderr') return;
        let event: {type?: string; item?: {type?: string; text?: string}; turn?: {status?: string; error?: {message?: string}}; error?: {message?: string}; message?: string};
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'thread.started') opt.onEvent?.({kind: 'init', model: opt.model});
        if (event.type === 'turn.started') turns += 1;
        if (event.type === 'turn.completed') turnStatus = event.turn?.status ?? 'completed';
        if (event.type === 'turn.failed') turnStatus = 'failed';
        if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.turn?.error?.message ?? event.message ?? failure;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text ?? '';
      },
    });
    const detail = (failure || result.stderr.trim() || `終了コード ${result.code}${result.signal ? ` / ${result.signal}` : ''}`).slice(-1000);
    if (result.code !== 0 || turnStatus === 'failed') throw new AgentError(`Codex の実行に失敗しました: ${detail}`, detail);
    if (!answer) throw new AgentError(`Codex が結果を返しませんでした: ${detail}`, detail);
    let data: T;
    try { data = JSON.parse(answer) as T; } catch { throw new AgentError('Codex の結果が JSON ではありません', answer.slice(0, 1000)); }
    return {data, costUsd: 0, durationMs: result.durationMs, turns};
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    const resolvedTemp = path.resolve(temp);
    if (resolvedTemp.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolvedTemp).startsWith('reel-codex-')) {
      fs.rmSync(resolvedTemp, {recursive: true, force: true});
    }
  }
}
