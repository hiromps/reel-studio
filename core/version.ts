// 「いま動いている版」と「GitHub の最新版」を調べる。
//
// このツールは git clone で配って git pull で更新する形なので、更新の判断に必要なのは
//   1. 手元の版（コミット）と、手元に未コミットの変更があるか
//   2. GitHub の main がどれだけ先に進んでいるか（何が変わったか）
// の 2 つ。GitHub への問い合わせは失敗しても動作に影響させない（オフラインでも使える）。
import fs from 'node:fs';
import path from 'node:path';
import {appRoot} from './settings';
import {exec} from './exec';

/** 配布元。fork して使う人のために origin から読む（読めなければこれを使う） */
const FALLBACK_REPO = 'hiromps/reel-studio';
const GITHUB_API = 'https://api.github.com';
/** GitHub の未認証 API は 1 時間 60 回まで。少し長めに覚えておく */
const CHECK_TTL_MS = 30 * 60_000;

export type LocalVersion = {
  /** package.json の version */
  version: string;
  /** git clone で入れたか（zip 展開だと false。その場合は更新コマンドが使えない） */
  isGit: boolean;
  commit: string | null;
  shortCommit: string | null;
  committedAt: string | null;
  branch: string | null;
  /** 手元に未コミットの変更があるか（あると git pull が止まる） */
  dirty: boolean;
  /** GitHub 上のリポジトリ（owner/name） */
  repo: string;
};

export type UpdateInfo = {
  local: LocalVersion;
  /** GitHub の最新（取れなければ null） */
  latest: {commit: string; shortCommit: string; committedAt: string | null; url: string} | null;
  /** 手元が何コミット遅れているか（比較できなければ null） */
  behind: number | null;
  /** 遅れているぶんの件名（新しい順・最大 20 件） */
  commits: {shortCommit: string; subject: string; date: string | null}[];
  /** 問い合わせに失敗した理由（画面に出す。null なら成功） */
  problem: string | null;
  checkedAt: string;
};

const git = async (args: string[]): Promise<string | null> => {
  try {
    const r = await exec('git', args, {cwd: appRoot, timeoutMs: 20_000});
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
};

const packageVersion = (): string => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as {version?: string}).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/** origin の URL から owner/name を取り出す（SSH でも HTTPS でも）。fork して使う人のために origin を見る */
export const repoFromRemote = (url: string | null): string => {
  if (!url) return FALLBACK_REPO;
  const m = /github\.com[:/]+([^/]+)\/([^/.]+)(\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : FALLBACK_REPO;
};

export const localVersion = async (): Promise<LocalVersion> => {
  const isGit = fs.existsSync(path.join(appRoot, '.git'));
  if (!isGit) return {version: packageVersion(), isGit: false, commit: null, shortCommit: null, committedAt: null, branch: null, dirty: false, repo: FALLBACK_REPO};
  const [commit, committedAt, branch, status, remote] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['log', '-1', '--format=%cI']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    git(['remote', 'get-url', 'origin']),
  ]);
  return {
    version: packageVersion(),
    isGit: true,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    committedAt,
    branch,
    // 空文字なら変更なし。null（git が失敗）は「分からない」なので変更なし扱いにする
    dirty: !!status,
    repo: repoFromRemote(remote),
  };
};

let cache: {at: number; info: UpdateInfo} | null = null;

const fetchJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
  const res = await fetch(url, {
    headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'reel-studio'},
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub の問い合わせ回数の上限に達しました（しばらく経ってから再試行してください）');
  if (!res.ok) throw new Error(`GitHub が HTTP ${res.status} を返しました`);
  return res.json();
};

type GhCommit = {sha?: string; html_url?: string; commit?: {message?: string; committer?: {date?: string}}};

/**
 * 更新があるか調べる。結果は 30 分覚えておく（?refresh=1 で取り直す）。
 * 比較は `compare/<手元>...<既定ブランチ>`。手元のコミットが GitHub に無い（自分で直した）ときは
 * 比較できないので、最新版だけを返す。
 */
export const checkUpdate = async (opt: {refresh?: boolean} = {}): Promise<UpdateInfo> => {
  if (!opt.refresh && cache && Date.now() - cache.at < CHECK_TTL_MS) return cache.info;
  const local = await localVersion();
  const base: UpdateInfo = {local, latest: null, behind: null, commits: [], problem: null, checkedAt: new Date().toISOString()};

  try {
    const head = (await fetchJson(`${GITHUB_API}/repos/${local.repo}/commits/HEAD`)) as GhCommit;
    if (head.sha) {
      base.latest = {
        commit: head.sha,
        shortCommit: head.sha.slice(0, 7),
        committedAt: head.commit?.committer?.date ?? null,
        url: head.html_url ?? `https://github.com/${local.repo}`,
      };
    }
    if (local.commit && head.sha && local.commit === head.sha) {
      base.behind = 0;
    } else if (local.commit && head.sha) {
      try {
        const cmp = (await fetchJson(`${GITHUB_API}/repos/${local.repo}/compare/${local.commit}...${head.sha}`)) as {
          behind_by?: number;
          ahead_by?: number;
          commits?: GhCommit[];
        };
        // compare は base→head 方向。ahead_by = 手元より進んでいる数
        base.behind = typeof cmp.ahead_by === 'number' ? cmp.ahead_by : null;
        base.commits = (cmp.commits ?? [])
          .slice(-20)
          .reverse()
          .map((c) => ({
            shortCommit: (c.sha ?? '').slice(0, 7),
            subject: (c.commit?.message ?? '').split('\n')[0],
            date: c.commit?.committer?.date ?? null,
          }));
      } catch (e) {
        // 手元のコミットが GitHub に無い＝自分で変更している／別のブランチにいる。
        // 異常ではないので、そうと分かる言い方にする（404 のままだと何が悪いのか分からない）
        base.problem = /404/.test((e as Error).message)
          ? `手元のコミット（${local.shortCommit}）が GitHub にありません。自分で変更しているか、${local.branch && local.branch !== 'main' ? `${local.branch} ブランチにいます` : '別のブランチにいます'}`
          : (e as Error).message;
      }
    }
  } catch (e) {
    base.problem = (e as Error).message;
  }
  cache = {at: Date.now(), info: base};
  return base;
};

export const resetUpdateCache = (): void => {
  cache = null;
};

export type PullResult = {ok: boolean; message: string; log: string[]; needsInstall: boolean; engineChanged: boolean; restart: boolean};

/**
 * 手元を GitHub の最新に進める（`git pull --ff-only`）。
 *
 * - **早送りできないときは何もしない。** 勝手にマージやリベースをすると、手元の変更が
 *   絡んだときに素人が復旧できない状態になる
 * - 依存やエンジンが変わったかを見て、次にやること（再起動・npm install）を返す
 * - `npm install` はここでは走らせない。動いているサーバーが node_modules を掴んでいるため
 *   （再起動時にランチャーが入れ直す）
 */
export const pullUpdate = async (): Promise<PullResult> => {
  const log: string[] = [];
  const local = await localVersion();
  if (!local.isGit) return {ok: false, message: 'git clone で入れた場合のみ更新できます（zip で展開した場合は、新しく clone し直してください）', log, needsInstall: false, engineChanged: false, restart: false};
  if (local.dirty) {
    const status = (await git(['status', '--porcelain'])) ?? '';
    return {
      ok: false,
      message: '手元に未コミットの変更があるため更新を止めました。変更を退避（git stash）するか、コミットしてからやり直してください',
      log: status.split('\n').filter(Boolean).slice(0, 20),
      needsInstall: false,
      engineChanged: false,
      restart: false,
    };
  }
  const before = local.commit;
  const fetched = await git(['fetch', '--tags', 'origin']);
  if (fetched === null) return {ok: false, message: 'git fetch に失敗しました（ネットワークと git の設定を確認してください）', log, needsInstall: false, engineChanged: false, restart: false};

  const pulled = await exec('git', ['pull', '--ff-only'], {cwd: appRoot, timeoutMs: 120_000}).catch(() => null);
  const out = `${pulled?.stdout ?? ''}${pulled?.stderr ?? ''}`.trim();
  if (out) log.push(...out.split('\n').filter(Boolean));
  if (!pulled || pulled.code !== 0) {
    return {
      ok: false,
      message: '早送りで更新できませんでした（手元のコミットが枝分かれしています）。git の履歴を確認してください',
      log,
      needsInstall: false,
      engineChanged: false,
      restart: false,
    };
  }

  const after = await git(['rev-parse', 'HEAD']);
  if (before && after && before === after) return {ok: true, message: 'すでに最新です', log, needsInstall: false, engineChanged: false, restart: false};

  // 何が変わったかで「次にやること」を決める
  const changed = (before && after ? await git(['diff', '--name-only', `${before}..${after}`]) : '') ?? '';
  const files = changed.split('\n').filter(Boolean);
  const needsInstall = files.some((f) => f === 'package-lock.json' || f === 'package.json');
  const engineChanged = files.some((f) => f.startsWith('engine/'));
  resetUpdateCache();
  return {
    ok: true,
    message: `${before?.slice(0, 7)} → ${after?.slice(0, 7)} に更新しました（${files.length} ファイル）`,
    log,
    needsInstall,
    engineChanged,
    restart: true,
  };
};
