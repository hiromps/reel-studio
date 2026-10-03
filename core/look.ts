// 素材の見た目の指紋と鮮明さを測る（catalog の clips[].look）。似た構図をまとめ、その中で最も鮮明なものを選ぶのに使う
// （判定は shared/shot-variety.ts）。ストリップ画像（.studio/strips/<id>/*.jpg）を ffmpeg で縮めて読むだけなので、1 本 0.1 秒ほど。
//
// - 指紋: 中央のコマを 8×14 の RGB に縮めた 336 バイト（base64）
// - 鮮明さ: 各コマを 90×160 の白黒にしてラプラシアンの分散を取り、上位半分の平均（手ブレしたコマに引っ張られない）
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {loadCatalog, saveCatalog, studioDir} from './catalog';
import type {Catalog, Clip, ClipLook} from '../shared/schema/catalog';

const SIG_W = 8;
const SIG_H = 14;
const SHARP_W = 90;
const SHARP_H = 160;

/** ffmpeg で画像を生のピクセルに。失敗したら null */
const rawPixels = (file: string, w: number, h: number, fmt: 'gray' | 'rgb24'): Promise<Buffer | null> =>
  new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-v', 'error', '-nostdin', '-i', file, '-vf', `scale=${w}:${h}:flags=area,format=${fmt}`, '-f', 'rawvideo', '-'],
      {encoding: 'buffer', windowsHide: true, maxBuffer: 1 << 22, timeout: 20_000},
      (err, stdout) => resolve(err || !stdout?.length ? null : stdout),
    );
  });

const laplacianVar = (b: Uint8Array | Buffer, w: number, h: number): number => {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * b[i] - b[i - 1] - b[i + 1] - b[i - w] - b[i + w];
      s += l;
      s2 += l * l;
      n++;
    }
  return n ? s2 / n - (s / n) ** 2 : 0;
};

/** 1 本ぶんを測る。ストリップが無ければ null */
export const measureLook = async (projectDir: string, clip: Clip): Promise<ClipLook | null> => {
  const sdir = studioDir(projectDir);
  const strip = clip.thumbs.strip.map((p) => path.join(sdir, p)).filter((p) => fs.existsSync(p));
  if (!strip.length) return null;
  const mid = strip[Math.floor(strip.length / 2)];
  const sig = await rawPixels(mid, SIG_W, SIG_H, 'rgb24');
  if (!sig || sig.length !== SIG_W * SIG_H * 3) return null;
  const sharps: number[] = [];
  for (const f of strip) {
    const g = await rawPixels(f, SHARP_W, SHARP_H, 'gray');
    if (g && g.length === SHARP_W * SHARP_H) sharps.push(laplacianVar(g, SHARP_W, SHARP_H));
  }
  if (!sharps.length) return null;
  const top = [...sharps].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(sharps.length / 2)));
  return {v: 1, sig: sig.toString('base64'), sharp: Math.round(top.reduce((a, b) => a + b, 0) / top.length)};
};

/**
 * look が無い素材だけ測って catalog.json に書く（測ったものがあれば保存）。測れた本数を返す。
 * 古い案件（look を持つ前に作った catalog）でも、AI の組み立て・尺合わせの前に呼べば似た構図をまとめられる
 */
export const ensureLooks = async (projectDir: string, opt: {catalog?: Catalog; onLine?: (l: string) => void; force?: boolean} = {}): Promise<number> => {
  const catalog = opt.catalog ?? loadCatalog(projectDir);
  if (!catalog) return 0;
  const todo = catalog.clips.filter((c) => opt.force || !c.look);
  if (!todo.length) return 0;
  let done = 0;
  // 4 本ずつ並べて測る（ffmpeg の起動待ちが大半なので）
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    const looks = await Promise.all(batch.map((c) => measureLook(projectDir, c).catch(() => null)));
    batch.forEach((c, j) => {
      if (looks[j]) {
        c.look = looks[j]!;
        done++;
      }
    });
  }
  if (done) {
    // 測っているあいだに別の操作で catalog が書き換わっていても、look だけを足す
    const fresh = loadCatalog(projectDir);
    if (fresh) {
      const byId = new Map(catalog.clips.map((c) => [c.id, c.look]));
      for (const c of fresh.clips) if ((opt.force || !c.look) && byId.get(c.id)) c.look = byId.get(c.id);
      saveCatalog(projectDir, fresh);
    }
    opt.onLine?.(`素材 ${done} 本の見た目（似た構図の判定と鮮明さ）を測りました`);
  }
  return done;
};
