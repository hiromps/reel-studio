// 顔モザイク（deface）：設定値・検出区間の要約・スクリプト引数・ファイルの入れ替え（ffmpeg / python は使わない）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {faceSpans, holdFrames, MOSAIC_DEFAULTS, mosaicLabel, resolveMosaicParams, spansText, summarizeMosaicReport, type MosaicInfo} from '@shared/mosaic';
import {ClipSchema} from '@shared/schema';
import {HEAVY_JOBS, PROJECTLESS_JOBS} from '@shared/jobs';
import {mosaicScriptArgs, refreshAliases, restoreOriginal, swapInMosaic, type MosaicSourceProbe} from '../core/mosaic';
import {makeClip} from './helpers';

const info = (over: Partial<MosaicInfo> = {}): MosaicInfo => ({
  applied: true,
  original: 'mosaic/originals/01_a.mp4',
  checkedAt: '2026-09-17T00:00:00.000Z',
  params: MOSAIC_DEFAULTS,
  frames: 120,
  framesWithFaces: 60,
  maxFaces: 2,
  spans: [{startSec: 0.5, endSec: 1.5, maxFaces: 2}],
  engine: 'deface 1.5.0 / CPUExecutionProvider',
  ...over,
});

describe('resolveMosaicParams', () => {
  it('既定値は料理動画向け（しきい値 0.6）', () => {
    expect(resolveMosaicParams()).toEqual({threshold: 0.6, cells: 8, maskScale: 1.3, detectShort: 720, detectEvery: 1, holdSec: 0.1});
  });

  it('undefined と NaN（CLI の未指定・空欄）は既定値のまま', () => {
    expect(resolveMosaicParams({threshold: undefined, cells: Number.NaN, maskScale: 1.5})).toMatchObject({threshold: 0.6, cells: 8, maskScale: 1.5});
  });

  it('範囲外は弾く', () => {
    expect(() => resolveMosaicParams({threshold: 0.1})).toThrow();
    expect(() => resolveMosaicParams({cells: 2})).toThrow();
    expect(() => resolveMosaicParams({cells: 8.5})).toThrow();
  });
});

describe('faceSpans / summarizeMosaicReport', () => {
  it('短い切れ目（0.25 秒以内）はつなぎ、長い切れ目で分ける', () => {
    // 10fps: 0.25 秒 = 3 フレームまでの切れ目はつなぐ
    const faces = [0, 1, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 0];
    expect(faceSpans(faces, 10)).toEqual([
      {startSec: 0.1, endSec: 0.7, maxFaces: 2},
      {startSec: 1.1, endSec: 1.2, maxFaces: 1},
    ]);
  });

  it('顔が無ければ区間なし', () => {
    expect(faceSpans([0, 0, 0], 30)).toEqual([]);
  });

  it('要約：顔のあるフレーム数・最大人数・秒数', () => {
    const sum = summarizeMosaicReport({frames: 13, fps: 10, width: 1080, height: 1920, faces: [0, 1, 1, 0, 0, 2, 1, 0, 0, 0, 0, 1, 0], engine: 'x', elapsedSec: 1});
    expect(sum).toMatchObject({frames: 13, framesWithFaces: 5, maxFaces: 2, faceSec: 0.7});
  });

  it('holdFrames は fps に合わせて秒をフレームにする', () => {
    expect(holdFrames(0.1, 59.94)).toBe(6);
    expect(holdFrames(0.1, 23.583)).toBe(2);
    expect(holdFrames(0, 60)).toBe(0);
  });
});

describe('表示', () => {
  it('mosaicLabel', () => {
    expect(mosaicLabel(undefined)).toBe('未チェック');
    expect(mosaicLabel(info({applied: false, original: undefined, spans: []}))).toBe('顔なし（確認済み）');
    expect(mosaicLabel(info())).toBe('モザイク済み（顔 1 秒・最大 2 人）');
  });

  it('spansText は多いと省略する', () => {
    const spans = [0, 1, 2, 3, 4].map((i) => ({startSec: i * 2, endSec: i * 2 + 1, maxFaces: 1}));
    expect(spansText(spans, 2)).toBe('0〜1 秒 / 2〜3 秒 ほか 3 か所');
  });
});

describe('catalog スキーマ', () => {
  it('mosaic の無い既存の catalog もそのまま読める', () => {
    const clip = makeClip({id: '01', slug: 'a', dur: 2, kind: 'person'});
    expect(ClipSchema.parse(clip).mosaic).toBeUndefined();
    expect(ClipSchema.parse({...clip, mosaic: info()}).mosaic?.applied).toBe(true);
  });
});

describe('ジョブ', () => {
  it('モザイクは重いジョブ（ffmpeg・レンダーと同時に走らせない）。導入は案件に属さない', () => {
    expect(HEAVY_JOBS.has('mosaic')).toBe(true);
    expect(HEAVY_JOBS.has('mosaic-revert')).toBe(true);
    expect(PROJECTLESS_JOBS.has('mosaic-setup')).toBe(true);
  });
});

describe('mosaicScriptArgs', () => {
  const probe: MosaicSourceProbe = {width: 1080, height: 1920, fps: '60000/1001', fpsValue: 59.94, frames: 144, hasAudio: true, color: {space: 'bt709', trc: 'bt709'}};
  const args = (p: MosaicSourceProbe) => mosaicScriptArgs({script: 's.py', input: 'in.mov', output: 'out.mov', report: 'r.json', probe: p, params: MOSAIC_DEFAULTS});
  const value = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

  it('fps は分数のまま渡し（丸めると尺がずれる）、保持はフレーム数にする', () => {
    const a = args(probe);
    expect(a[0]).toBe('s.py');
    expect(value(a, '--fps')).toBe('60000/1001');
    expect(value(a, '--hold')).toBe('6');
    expect(value(a, '--threshold')).toBe('0.6');
    expect(value(a, '--audio')).toBe('copy');
  });

  it('色の情報は分かっているものだけ、音声が無ければ none', () => {
    const a = args({...probe, hasAudio: false});
    expect(value(a, '--color-space')).toBe('bt709');
    expect(value(a, '--color-trc')).toBe('bt709');
    expect(a).not.toContain('--color-primaries');
    expect(value(a, '--audio')).toBe('none');
  });
});

describe('ファイルの入れ替え', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mosaic-'));
    const dir = path.join(root, 'a-reel');
    const other = path.join(root, 'b-reel');
    fs.mkdirSync(path.join(dir, 'public', 'uploads'), {recursive: true});
    fs.mkdirSync(path.join(other, 'public', 'uploads'), {recursive: true});
    const src = 'uploads/01_a.mp4';
    const dest = path.join(dir, 'public', src);
    fs.writeFileSync(dest, 'original');
    // 「同じ素材から作る」案件はハードリンクで共有している
    const linked = path.join(other, 'public', src);
    fs.linkSync(dest, linked);
    const tmp = (content: string) => {
      const p = path.join(root, `tmp-${content}.mp4`);
      fs.writeFileSync(p, content);
      return p;
    };
    return {dir, src, dest, linked, tmp};
  };
  const read = (p: string) => fs.readFileSync(p, 'utf8');

  it('初回は元を退避してモザイク版を入れる。ハードリンク共有の相手は元のまま', async () => {
    const t = setup();
    const original = await swapInMosaic(t.dir, {src: t.src, mosaic: undefined}, t.tmp('mosaic'));
    expect(original).toBe('mosaic/originals/01_a.mp4');
    expect(read(t.dest)).toBe('mosaic');
    expect(read(path.join(t.dir, '.studio', original))).toBe('original');
    expect(read(t.linked)).toBe('original');
  });

  it('かけ直しは元を残したまま差し替え、元に戻すと元の実体（リンク）に戻る', async () => {
    const t = setup();
    const original = await swapInMosaic(t.dir, {src: t.src, mosaic: undefined}, t.tmp('mosaic1'));
    const clip = {src: t.src, mosaic: info({original})};
    await swapInMosaic(t.dir, clip, t.tmp('mosaic2'));
    expect(read(t.dest)).toBe('mosaic2');
    expect(read(path.join(t.dir, '.studio', original))).toBe('original');

    const before = Date.now() - 1000;
    fs.utimesSync(path.join(t.dir, '.studio', original), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await restoreOriginal(t.dir, clip);
    expect(read(t.dest)).toBe('original');
    expect(fs.existsSync(path.join(t.dir, '.studio', original))).toBe(false);
    expect(fs.statSync(t.dest).nlink).toBe(2);
    // 古い時刻のままだと、モザイク版でレンダーした out/final.mp4 が「最新」に見える
    expect(fs.statSync(t.dest).mtimeMs).toBeGreaterThan(before);
  });

  it('退避先に同名のファイルがあれば止める（どちらが元か分からない）', async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.dir, '.studio', 'mosaic', 'originals'), {recursive: true});
    fs.writeFileSync(path.join(t.dir, '.studio', 'mosaic', 'originals', '01_a.mp4'), 'unknown');
    await expect(swapInMosaic(t.dir, {src: t.src, mosaic: undefined}, t.tmp('mosaic'))).rejects.toThrow(/退避先に同じ名前/);
    expect(read(t.dest)).toBe('original');
  });

  it('alias コピーを作り直す（作ってあるものだけ）', async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.dir, 'public', 'uploads', '01_a__a2.mp4'), 'stale');
    const cuts = {
      fps: 60,
      meta: {aliases: [{from: t.src, to: 'uploads/01_a__a2.mp4'}, {from: t.src, to: 'uploads/01_a__a3.mp4'}]},
      cuts: [{src: t.src, inSec: 0, outSec: 1, main: {text: 'a'}}],
    };
    fs.writeFileSync(path.join(t.dir, 'cuts.json'), JSON.stringify(cuts));
    await swapInMosaic(t.dir, {src: t.src, mosaic: undefined}, t.tmp('mosaic'));
    expect(refreshAliases(t.dir, t.src)).toEqual(['uploads/01_a__a2.mp4']);
    expect(read(path.join(t.dir, 'public', 'uploads', '01_a__a2.mp4'))).toBe('mosaic');
    expect(fs.existsSync(path.join(t.dir, 'public', 'uploads', '01_a__a3.mp4'))).toBe(false);
  });
});
