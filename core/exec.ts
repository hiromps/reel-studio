// 子プロセス実行のラッパ。args 配列のみ（shell 不使用）、Windows では windowsHide、kill は taskkill /T /F でツリーごと落とす。
import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';

export type ExecResult = {code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 行ごとのログコールバック（stdout/stderr 混在） */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** 中断シグナル */
  signal?: AbortSignal;
  /** stdout/stderr を結果に保持する最大文字数（超えた分は先頭から捨てる） */
  keepChars?: number;
  timeoutMs?: number;
};

export const isWindows = process.platform === 'win32';

/** Windows の日本語パスでも壊れないように、引数はそのまま配列で渡す。パス区切りだけ / に正規化する */
export const posixPath = (p: string): string => p.replace(/\\/g, '/');

export class ExecError extends Error {
  result: ExecResult;
  constructor(cmd: string, args: string[], result: ExecResult) {
    // 原因が分からないと手が出ないので、末尾の stderr を必ず添える
    const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).filter((l) => l.trim()).slice(-6);
    super(`${path.basename(cmd)} ${args.join(' ')} が終了コード ${result.code}${result.signal ? ` (${result.signal})` : ''} で失敗${tail.length ? `\n  ${tail.join('\n  ')}` : ''}`);
    this.result = result;
  }
}

export const killTree = (child: ChildProcess) => {
  if (!child.pid) return;
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
};

/** 実行して結果を返す（終了コード ≠ 0 でも reject しない。呼び手が判断する） */
export const exec = (cmd: string, args: string[], opt: ExecOptions = {}): Promise<ExecResult> & {child: ChildProcess} => {
  const started = Date.now();
  const keep = opt.keepChars ?? 200_000;
  const child = spawn(cmd, args, {
    cwd: opt.cwd,
    env: {...process.env, ...opt.env},
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
  });
  let stdout = '';
  let stderr = '';
  const push = (buf: string, chunk: Buffer | string) => {
    const s = buf + chunk.toString();
    return s.length > keep ? s.slice(s.length - keep) : s;
  };
  const lineBuf: Record<'stdout' | 'stderr', string> = {stdout: '', stderr: ''};
  const feed = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (!opt.onLine) return;
    lineBuf[stream] += chunk.toString();
    // \r（進捗上書き）も行区切りとして扱う
    const parts = lineBuf[stream].split(/\r\n|\n|\r/);
    lineBuf[stream] = parts.pop() ?? '';
    for (const p of parts) {
      const clean = p.replace(/\x1b\[[0-9;]*m/g, ''); // ANSI 色コードを落とす（remotion の出力）
      if (clean.trim()) opt.onLine(clean, stream);
    }
  };
  child.stdout?.on('data', (c: Buffer) => {
    stdout = push(stdout, c);
    feed('stdout', c);
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderr = push(stderr, c);
    feed('stderr', c);
  });

  let timer: NodeJS.Timeout | undefined;
  if (opt.timeoutMs) timer = setTimeout(() => killTree(child), opt.timeoutMs);
  const onAbort = () => killTree(child);
  opt.signal?.addEventListener('abort', onAbort, {once: true});

  const p = new Promise<ExecResult>((resolve, reject) => {
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      opt.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opt.signal?.removeEventListener('abort', onAbort);
      for (const s of ['stdout', 'stderr'] as const) if (lineBuf[s].trim() && opt.onLine) opt.onLine(lineBuf[s], s);
      resolve({code, signal, stdout, stderr, durationMs: Date.now() - started});
    });
  }) as Promise<ExecResult> & {child: ChildProcess};
  p.child = child;
  return p;
};

/** 終了コード 0 以外は ExecError を投げる版 */
export const execOk = async (cmd: string, args: string[], opt: ExecOptions = {}): Promise<ExecResult> => {
  const r = await exec(cmd, args, opt);
  if (r.code !== 0) throw new ExecError(cmd, args, r);
  return r;
};
