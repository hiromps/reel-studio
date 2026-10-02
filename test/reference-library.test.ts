// 参考動画のライブラリ：同じ動画の分析を案件をまたいで使い回す（core/reference.ts のライブラリ部分）。ffmpeg も claude も使わない
//（コマやシートは中身の無いファイルで代用し、reference.json は分析済みの形を直接書く）。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReferenceKey, referenceKeyOfHash, referenceKeyOfInstagram, ReferenceSchema, type Reference} from '@shared/reference';
import {
  findLibraryEntry,
  hashFileSha256,
  libraryEntryDir,
  listLibraryEntries,
  readReference,
  referenceLibraryDir,
  referenceStudioDir,
  referenceVideoPath,
  reuseFromLibrary,
  storeToLibrary,
  writeReference,
} from '../core/reference';
import {resetSettings} from '../core/settings';

const analyzed = (key: string, over: Partial<Reference> = {}): Reference =>
  ReferenceSchema.parse({
    version: 1,
    source: {file: 'reference/source.mp4', originalName: 'buzz.mp4', durationSec: 12, fps: 30, width: 1080, height: 1920, hasAudio: true, importedAt: '2026-09-22T00:00:00.000Z', key},
    analyzedAt: '2026-10-02T01:00:00.000Z',
    model: 'opus',
    costUsd: 1.2,
    sceneCuts: [2.5],
    cuts: [
      {index: 1, startSec: 0, endSec: 2.5, telop: '生野区で9割が知らない', role: 'hook', frame: 'reference/frames/001.jpg'},
      {index: 2, startSec: 2.5, endSec: 12, telop: '一度は行っとこ', role: 'cta', frame: 'reference/frames/002.jpg'},
    ],
    segments: [{id: '1', label: 'フック', fromSec: 0, toSec: 12, role: 'hook', cutCount: 2, cutIndices: [1, 2]}],
    sheets: ['reference/sheets/01.jpg'],
    pattern: {hookType: '数字で言い切る'},
    summary: 'テスト',
    mimicRules: ['冒頭は寄り'],
    ...over,
  });

/** 案件（またはライブラリの 1 本）を分析済みの形で作る */
const makeProject = (dir: string, ref: Reference, opt: {video?: boolean} = {}) => {
  const rdir = referenceStudioDir(dir);
  fs.mkdirSync(path.join(rdir, 'frames'), {recursive: true});
  fs.mkdirSync(path.join(rdir, 'sheets'), {recursive: true});
  fs.writeFileSync(path.join(rdir, 'frames', '001.jpg'), 'f1');
  fs.writeFileSync(path.join(rdir, 'frames', '002.jpg'), 'f2');
  fs.writeFileSync(path.join(rdir, 'sheets', '01.jpg'), 's1');
  if (opt.video !== false) fs.writeFileSync(path.join(rdir, 'source.mp4'), 'video-bytes');
  writeReference(dir, ref);
};

let home: string;
let work: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-lib-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-lib-work-'));
  process.env.REEL_STUDIO_HOME = home;
  resetSettings();
});
afterEach(() => {
  resetSettings();
  fs.rmSync(home, {recursive: true, force: true});
  fs.rmSync(work, {recursive: true, force: true});
});

describe('鍵', () => {
  it('Instagram の投稿コードとファイルの sha256 から作り、フォルダ名に使える形だけを鍵と認める', () => {
    expect(referenceKeyOfInstagram('Ddn8GJfvtiO')).toBe('ig_Ddn8GJfvtiO');
    expect(referenceKeyOfInstagram('a/b c')).toBe('ig_a_b_c');
    expect(referenceKeyOfHash('ABCDEF0123456789abcdef')).toBe('sha_abcdef0123456789');
    expect(isReferenceKey('ig_Ddn8GJfvtiO')).toBe(true);
    expect(isReferenceKey('sha_abcdef0123456789')).toBe(true);
    expect(isReferenceKey('ig_x')).toBe(false);
    expect(isReferenceKey('../evil')).toBe(false);
    expect(isReferenceKey(undefined)).toBe(false);
    expect(libraryEntryDir('ig_Ddn8GJfvtiO')).toBe(path.join(home, 'reference-library', 'ig_Ddn8GJfvtiO'));
    expect(referenceLibraryDir()).toBe(path.join(home, 'reference-library'));
  });

  it('同じ中身のファイルは同じ sha256', async () => {
    const a = path.join(work, 'a.mp4');
    const b = path.join(work, 'b.mp4');
    fs.writeFileSync(a, 'same bytes');
    fs.writeFileSync(b, 'same bytes');
    expect(await hashFileSha256(a)).toBe(await hashFileSha256(b));
    expect(await hashFileSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(b, 'other');
    expect(await hashFileSha256(a)).not.toBe(await hashFileSha256(b));
  });
});

describe('ライブラリに入れる・写す', () => {
  it('案件の分析をライブラリへ写し、別の案件はコマとシートと分析だけを写す（動画は写さない）。再分析はライブラリの動画で行える', () => {
    const key = 'ig_Ddn8GJfvtiO';
    const a = path.join(work, 'a-reel');
    makeProject(a, analyzed(key));
    expect(findLibraryEntry(key)).toBeNull();

    const stored = storeToLibrary(a, readReference(a)!);
    expect(stored?.analyzed).toBe(true);
    expect(stored?.videoPath).toBe(path.join(referenceStudioDir(libraryEntryDir(key)), 'source.mp4'));
    expect(fs.existsSync(path.join(referenceStudioDir(libraryEntryDir(key)), 'frames', '002.jpg'))).toBe(true);
    expect(listLibraryEntries().map((e) => e.key)).toEqual([key]);

    const b = path.join(work, 'b-reel');
    const got = reuseFromLibrary(b, findLibraryEntry(key)!, {originalName: 'from-b.mp4', sourceUrl: 'https://www.instagram.com/reel/Ddn8GJfvtiO/'});
    expect(got.reusedAt).toBeTruthy();
    expect(got.analyzedAt).toBe('2026-10-02T01:00:00.000Z');
    expect(got.source?.originalName).toBe('from-b.mp4');
    expect(got.source?.sourceUrl).toBe('https://www.instagram.com/reel/Ddn8GJfvtiO/');
    expect(got.cuts.map((c) => c.telop)).toEqual(['生野区で9割が知らない', '一度は行っとこ']);
    expect(fs.existsSync(path.join(referenceStudioDir(b), 'frames', '001.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(referenceStudioDir(b), 'sheets', '01.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(referenceStudioDir(b), 'source.mp4'))).toBe(false);
    // 動画は無いが、鍵でライブラリの動画が引ける（「分析をやり直す」用）
    expect(referenceVideoPath(b, got)).toBe(stored!.videoPath);
    // 元の案件は自分の動画
    expect(referenceVideoPath(a, readReference(a)!)).toBe(path.join(referenceStudioDir(a), 'source.mp4'));
  });

  it('ライブラリ側には reusedAt を持たせず、元の投稿 URL は残す。分析前の 1 本は写せない', () => {
    const key = 'sha_abcdef0123456789';
    const a = path.join(work, 'a-reel');
    makeProject(a, analyzed(key, {source: {...analyzed(key).source!, sourceUrl: 'https://www.instagram.com/reel/X1234567/'}}));
    storeToLibrary(a, readReference(a)!);
    // 写した案件で分析し直して、URL 無しの結果をライブラリへ戻す
    const b = path.join(work, 'b-reel');
    const got = reuseFromLibrary(b, findLibraryEntry(key)!);
    makeProject(b, {...got, summary: '分析し直し'}, {video: false});
    storeToLibrary(b, readReference(b)!);
    const e = findLibraryEntry(key)!;
    expect(e.ref?.reusedAt).toBeUndefined();
    expect(e.ref?.summary).toBe('分析し直し');
    expect(e.ref?.source?.sourceUrl).toBe('https://www.instagram.com/reel/X1234567/');
    // b に動画が無くても、ライブラリの動画は残っている
    expect(e.videoPath).toBeTruthy();

    const c = path.join(work, 'c-reel');
    writeReference(c, {...analyzed('ig_NotYet12345'), analyzedAt: undefined, segments: [], cuts: []});
    expect(storeToLibrary(c, readReference(c)!)?.analyzed).toBe(false);
    expect(() => reuseFromLibrary(path.join(work, 'd-reel'), findLibraryEntry('ig_NotYet12345')!)).toThrow(/分析済みの動画がありません/);
    expect(listLibraryEntries().map((e) => e.key)).toEqual([key]);
  });

  it('鍵の無い古い取り込みはライブラリに入れない。ライブラリの 1 本の中で分析したときは自分自身へ写さない', () => {
    const a = path.join(work, 'a-reel');
    const ref = analyzed('ig_Ddn8GJfvtiO');
    makeProject(a, {...ref, source: {...ref.source!, key: undefined}});
    expect(storeToLibrary(a, readReference(a)!)).toBeNull();
    expect(fs.existsSync(referenceLibraryDir())).toBe(false);

    const key = 'ig_SelfEntry01';
    const self = libraryEntryDir(key);
    makeProject(self, analyzed(key));
    const e = storeToLibrary(self, readReference(self)!);
    expect(e?.dir).toBe(self);
    expect(e?.analyzed).toBe(true);
    expect(fs.existsSync(path.join(referenceStudioDir(self), 'source.mp4'))).toBe(true);
  });
});
