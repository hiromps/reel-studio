// PC の claude CLI（Claude Code）のログイン状態の確認と、ログイン画面の起動。
// 「接続先を Claude に戻したいのに繋がらない」ときの再接続に使う。
// - 状態は `claude auth status --json`（課金なし・数百 ms）。メールアドレスは読み捨てる
// - ログインは `claude auth login` を見えるターミナルで開く（ブラウザでの承認が要るので裏では走らせない）
import {spawn} from 'node:child_process';
import {claudeBin} from './agent';
import {exec, isWindows} from './exec';
import type {ClaudeAuth} from '../shared/schema/settings';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `claude auth status --json` の出力を要約する。JSON でなければ null */
export const parseClaudeAuthStatus = (stdout: string, now = new Date()): ClaudeAuth | null => {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const j = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    if (typeof j.loggedIn !== 'boolean') return null;
    const expiresAt = str(j.loginExpiresAt);
    // 期限切れのログインは「ログインしていない」と同じ扱いにする（実行すると 401 で止まる）
    const expired = !!expiresAt && Date.parse(expiresAt) <= now.getTime();
    return {
      loggedIn: j.loggedIn && !expired,
      method: str(j.authMethod),
      plan: str(j.planTier) ?? str(j.subscriptionType),
      expiresAt,
      checkedAt: now.toISOString(),
      ...(expired ? {error: 'ログインの有効期限が切れています'} : {}),
    };
  } catch {
    return null;
  }
};

/** いまのログイン状態。claude が無い・古くて auth を知らないときは error 付きで loggedIn=false */
export const claudeAuthStatus = async (bin = claudeBin()): Promise<ClaudeAuth> => {
  const checkedAt = new Date().toISOString();
  try {
    const r = await exec(bin, ['auth', 'status', '--json'], {timeoutMs: 20_000});
    const parsed = parseClaudeAuthStatus(r.stdout);
    if (parsed) return parsed;
    const detail = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? '';
    return {loggedIn: false, method: null, plan: null, expiresAt: null, checkedAt, error: `ログイン状態を読めませんでした${detail ? `（${detail.slice(0, 160)}）` : ''}。Claude Code を更新してください`};
  } catch (e) {
    return {loggedIn: false, method: null, plan: null, expiresAt: null, checkedAt, error: `claude を起動できませんでした（${(e as Error).message.slice(0, 160)}）`};
  }
};

/** ログイン用に開くコマンド（画面の案内にも出す） */
export const claudeLoginCommand = (bin = claudeBin()): string => `${/\s/.test(bin) ? `"${bin}"` : bin} auth login`;

/**
 * `claude auth login` を見えるターミナルで開く。ブラウザで承認すると CLI がログイン情報を保存する。
 * 開けたら true。開けない OS（GUI の無い Linux など）では false を返し、画面でコマンドを案内する
 */
export const openClaudeLogin = (bin = claudeBin()): boolean => {
  try {
    if (isWindows) {
      // start の第 1 引数はウィンドウのタイトル。新しいコンソールで開き、終わっても閉じない（/k）
      const child = spawn('cmd.exe', ['/c', 'start', 'Claude ログイン', 'cmd.exe', '/k', bin, 'auth', 'login'], {detached: true, stdio: 'ignore', windowsHide: false});
      child.on('error', () => {});
      child.unref();
      return true;
    }
    if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script ${JSON.stringify(claudeLoginCommand(bin))}`;
      const child = spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], {detached: true, stdio: 'ignore'});
      child.on('error', () => {});
      child.unref();
      return true;
    }
    return false;
  } catch {
    return false;
  }
};
