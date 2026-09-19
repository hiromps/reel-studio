// 起動時に「更新があるか」だけを静かに調べる。
//
// ランチャーの画面は毎回見るところなので、ここに 1 行出しておけば気づける
// （ターミナルを開かない人は、それ以外に気づく機会がない）。
//
// 方針:
// - **失敗しても何も言わない。** オフラインでも・git 以外で入れていても、起動を妨げない
// - 結果は 6 時間覚えておく（GitHub の未認証 API は 1 時間 60 回まで）
// - 勝手に更新はしない。やり方を出すだけ
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

const cacheFile = () => {
  const dir = process.env.REEL_STUDIO_HOME?.trim() || path.join(os.homedir(), '.reel-studio');
  return path.join(dir, 'update-check.json');
};

const git = (args, cwd) => {
  const r = spawnSync('git', args, {cwd, encoding: 'utf8', windowsHide: true, timeout: 10000});
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
};

const repoFromRemote = (url) => {
  if (!url) return null;
  const m = /github\.com[:/]+([^/]+)\/([^/.]+)(\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
};

/**
 * 手元より GitHub が進んでいれば {behind, subject} を返す。それ以外・失敗時は null。
 * 呼び出し側は null を「何も出さない」として扱う。
 */
export const checkUpdate = async (root) => {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const file = cacheFile();
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - c.at < TTL_MS) return c.result;
  } catch {
    /* キャッシュが無い・壊れていれば調べ直す */
  }

  let result = null;
  try {
    const head = git(['rev-parse', 'HEAD'], root);
    const repo = repoFromRemote(git(['remote', 'get-url', 'origin'], root));
    if (head && repo) {
      const res = await fetch(`https://api.github.com/repos/${repo}/compare/${head}...HEAD`, {
        headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'reel-studio'},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const d = await res.json();
        const behind = typeof d.ahead_by === 'number' ? d.ahead_by : 0;
        if (behind > 0) {
          const last = (d.commits ?? []).slice(-1)[0];
          result = {behind, subject: (last?.commit?.message ?? '').split('\n')[0]};
        }
      }
    }
  } catch {
    /* オフライン・上限超過。黙って諦める */
  }

  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({at: Date.now(), result}));
  } catch {
    /* 覚えられなくても動作には影響しない */
  }
  return result;
};
