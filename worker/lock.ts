// ワーカーの二重起動よけ（`~/.reel-studio/worker.lock`）。
//
// ショートカットからの自動起動・手で叩いた `npm run worker`・タスクスケジューラが重なっても、
// 実際に走るのは 1 つだけにする。2 つ走ると、クラウドは互いの「いま走っているジョブ」を
// 知らないまま両方にジョブを渡すので、同じ案件で ffmpeg / Remotion が同時に動いてしまう。
import fs from 'node:fs';
import path from 'node:path';
import {settingsDir} from '../core/settings';

/** 錠がこれより古ければ、落ちたプロセスの置き土産とみなす（生きていればポーリングのたびに更新される） */
const STALE_MS = 60_000;

const file = (): string => path.join(settingsDir(), 'worker.lock');

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // シグナル 0 は「居るかどうか」を見るだけ
    return true;
  } catch (e) {
    // 他ユーザーのプロセスには触れないが、居ることは確か
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** 生きている別のワーカーの pid。無ければ null */
const holder = (): number | null => {
  let raw: {pid?: number; updatedAt?: string};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as {pid?: number; updatedAt?: string};
  } catch {
    return null; // 錠が無い・壊れている
  }
  const pid = Number(raw.pid);
  if (!pid || pid === process.pid) return null;
  const age = Date.now() - Date.parse(raw.updatedAt ?? '');
  if (!Number.isFinite(age) || age > STALE_MS) return null;
  return pidAlive(pid) ? pid : null;
};

const write = (): void => {
  try {
    fs.mkdirSync(settingsDir(), {recursive: true});
    fs.writeFileSync(file(), JSON.stringify({pid: process.pid, updatedAt: new Date().toISOString()}));
  } catch {
    /* 錠が書けなくても本体は動かす（二重起動よけが効かなくなるだけ） */
  }
};

/**
 * 錠を取る。取れたら null、別のワーカーが動いていればその pid を返す（＝こちらは起動しない）。
 * ログオン時などに同時に立ち上がることがあるので、書いたあと少し待って取り直しを見る。
 */
export const acquireWorkerLock = async (): Promise<number | null> => {
  const held = holder();
  if (held) return held;
  write();
  await new Promise((r) => setTimeout(r, 300));
  return holder(); // この間に誰かが上書きしていたら、そちらに譲る
};

/** ポーリングのたびに呼ぶ（錠が古くならないように） */
export const touchWorkerLock = (): void => write();

/** 終了時に外す。外し損ねても STALE_MS を過ぎれば無効になる */
export const releaseWorkerLock = (): void => {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as {pid?: number};
    if (Number(raw.pid) === process.pid) fs.rmSync(file());
  } catch {
    /* ignore */
  }
};
