// カット頭のフレームを 1 枚だけ切り出してキャッシュする。
//
// なぜ catalog のストリップを使わないか：cuts.json は Reel Studio の外（daihon スキルの手作業）でも作られる。
// その場合 src が catalog のクリップと一致せず（例：手作りの 01_hook-sashimi-reveal.mov ／
// reel catalog が作った 01_img-3036.mov）サムネイルが出せない。素材ファイルから直に取れば
// カタログの有無に関係なく必ず出せて、しかも 1 秒刻みのストリップより正確な絵になる。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {execOk} from './exec';

const CACHE_SUBDIR = 'cutframes';
/** 同時に走らせる ffmpeg の数（絵コンテを開くと一気に十数枚要求されるため） */
const MAX_PARALLEL = 3;

/**
 * public 相対パス（cuts.json の src）を案件フォルダ内の実ファイルに解決する。
 * 絶対パス・ドライブ指定・public の外に出る参照は弾く。無ければ null。
 */
export const resolveMaterial = (projectDir: string, srcRel: string): string | null => {
  if (!srcRel || path.isAbsolute(srcRel) || /^[a-zA-Z]:/.test(srcRel)) return null;
  const publicDir = path.resolve(projectDir, 'public');
  const abs = path.resolve(publicDir, srcRel);
  if (abs !== publicDir && !abs.startsWith(publicDir + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
};

/** 素材の実体（サイズ・更新時刻）まで含めた鍵。素材を差し替えたら別ファイルになる */
export const frameCacheKey = (srcRel: string, timeSec: number, width: number, size: number, mtimeMs: number): string =>
  crypto.createHash('sha1').update(`${srcRel}|${timeSec.toFixed(3)}|${width}|${size}|${Math.round(mtimeMs)}`).digest('hex').slice(0, 20);

let running = 0;
const waiting: (() => void)[] = [];
const inflight = new Map<string, Promise<string | null>>();

const withSlot = async <T,>(fn: () => Promise<T>): Promise<T> => {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
};

const grab = async (input: string, out: string, timeSec: number, width: number): Promise<boolean> => {
  const tmp = `${out}.${process.pid}.tmp.jpg`;
  const args = ['-y', '-nostdin', '-v', 'error'];
  if (timeSec > 0) args.push('-ss', timeSec.toFixed(3)); // -i の前＝キーフレーム seek で速い
  args.push('-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', tmp);
  try {
    await execOk('ffmpeg', args, {timeoutMs: 60_000});
  } catch {
    fs.rmSync(tmp, {force: true});
    return false;
  }
  if (!fs.existsSync(tmp)) return false; // 尺を超えた指定などでフレームが出ないことがある
  fs.renameSync(tmp, out);
  return true;
};

/**
 * `<案件>/.studio/cutframes/<hash>.jpg` を用意して絶対パスを返す。生成できなければ null。
 * 同じ絵の同時要求は 1 本にまとめる。
 */
export const ensureCutFrame = async (projectDir: string, srcRel: string, timeSec: number, width = 240): Promise<string | null> => {
  const input = resolveMaterial(projectDir, srcRel);
  if (!input) return null;
  const st = fs.statSync(input);
  const t = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
  const out = path.join(projectDir, studioConfig.studioDirName, CACHE_SUBDIR, `${frameCacheKey(srcRel, t, width, st.size, st.mtimeMs)}.jpg`);
  if (fs.existsSync(out)) return out;
  const pending = inflight.get(out);
  if (pending) return pending;

  const task = withSlot(async () => {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    if (await grab(input, out, t, width)) return out;
    // 指定位置で取れなかったら先頭で取り直す（尺より後ろを指していた場合など）
    if (t > 0 && (await grab(input, out, 0, width))) return out;
    return null;
  }).finally(() => inflight.delete(out));
  inflight.set(out, task);
  return task;
};
