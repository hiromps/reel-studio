// カットフレームの切り出し（catalog に依存しないサムネイル）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {ensureCutFrame, frameCacheKey, resolveMaterial} from '../core/cut-frames';

let dir: string;
const pub = () => path.join(dir, 'public', 'uploads');

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-frames-'));
  fs.mkdirSync(pub(), {recursive: true});
  fs.writeFileSync(path.join(pub(), 'a.mov'), 'dummy');
});
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}));

describe('resolveMaterial', () => {
  it('public 配下の実ファイルを解決する', () => {
    expect(resolveMaterial(dir, 'uploads/a.mov')).toBe(path.join(pub(), 'a.mov'));
  });

  it('無いファイルは null', () => {
    expect(resolveMaterial(dir, 'uploads/none.mov')).toBeNull();
  });

  it('public の外へ出る参照は拒否する', () => {
    for (const bad of ['../../secret.txt', 'uploads/../../../secret.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
      expect(resolveMaterial(dir, bad)).toBeNull();
    }
  });

  it('空文字は null', () => {
    expect(resolveMaterial(dir, '')).toBeNull();
  });
});

describe('frameCacheKey', () => {
  const base = ['uploads/a.mov', 1.5, 240, 1000, 12345] as const;

  it('同じ条件なら同じ鍵', () => {
    expect(frameCacheKey(...base)).toBe(frameCacheKey(...base));
  });

  it('時刻・幅・素材の実体が変われば別の鍵', () => {
    const k = frameCacheKey(...base);
    expect(frameCacheKey('uploads/a.mov', 1.6, 240, 1000, 12345)).not.toBe(k);
    expect(frameCacheKey('uploads/a.mov', 1.5, 320, 1000, 12345)).not.toBe(k);
    expect(frameCacheKey('uploads/a.mov', 1.5, 240, 1001, 12345)).not.toBe(k); // 差し替え（サイズ違い）
    expect(frameCacheKey('uploads/a.mov', 1.5, 240, 1000, 99999)).not.toBe(k); // 差し替え（更新時刻違い）
    expect(frameCacheKey('uploads/b.mov', 1.5, 240, 1000, 12345)).not.toBe(k);
  });
});

describe('ensureCutFrame', () => {
  it('素材が無ければ null（ffmpeg を呼ばない）', async () => {
    await expect(ensureCutFrame(dir, 'uploads/none.mov', 1)).resolves.toBeNull();
  });

  it('動画として読めなければ null を返し、ゴミを残さない', async () => {
    await expect(ensureCutFrame(dir, 'uploads/a.mov', 1)).resolves.toBeNull();
    const cache = path.join(dir, '.studio', 'cutframes');
    const left = fs.existsSync(cache) ? fs.readdirSync(cache) : [];
    expect(left).toEqual([]);
  });
});
