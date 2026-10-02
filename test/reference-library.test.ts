// 参考動画のライブラリ：同じ動画の分析を案件をまたいで使い回す（core/reference.ts のライブラリ部分）。ffmpeg も claude も使わない
//（コマやシートは中身の無いファイルで代用し、reference.json は分析済みの形を直接書く）。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isReferenceKey, libraryEntryLabel, referenceKeyFromFilename, referenceKeyOfHash, referenceKeyOfInstagram, ReferenceSchema, type Reference} from '@shared/reference';
import {
  findLibraryEntry,
  findLibraryEntryBySha,
  hashFileSha256,
  libraryEntryDir,
  libraryIndex,
  listLibraryEntries,
  readReference,
  referenceLibraryDir,
  referenceStudioDir,
  referenceVideoPath,
  registerReferenceToLibrary,
  reuseFromLibrary,
  setLibraryTitle,
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
let dataRoot: string;
/** listProjects() が見る案件（work/<slug>-reel/ に GourmetReel.tsx があるもの）を作る */
const makeListedProject = (slug: string): string => {
  const dir = path.join(dataRoot, 'work', `${slug}-reel`);
  fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'src', 'GourmetReel.tsx'), '// stub');
  return dir;
};
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-lib-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-lib-work-'));
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-lib-data-'));
  process.env.REEL_STUDIO_HOME = home;
  process.env.REEL_STUDIO_DATA_ROOT = dataRoot;
  resetSettings();
});
afterEach(() => {
  delete process.env.REEL_STUDIO_DATA_ROOT;
  resetSettings();
  fs.rmSync(home, {recursive: true, force: true});
  fs.rmSync(work, {recursive: true, force: true});
  fs.rmSync(dataRoot, {recursive: true, force: true});
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

  it.each([
    ['instagram-Ddd6Dp5S_wZ.mp4', 'ig_Ddd6Dp5S_wZ'],
    ['instagram_Ddd6Dp5S_wZ.MOV', 'ig_Ddd6Dp5S_wZ'],
    ['Instagram-Ddd6Dp5S_wZ.mp4', 'ig_Ddd6Dp5S_wZ'],
    ['@osk_gurume_Ddd6Dp5S_wZ.mp4', 'ig_Ddd6Dp5S_wZ'],
    ['reel-Ddd6Dp5S_wZ.mp4', 'ig_Ddd6Dp5S_wZ'],
    ['C:\\Users\\x\\Downloads\\instagram-Abc12345.mp4', 'ig_Abc12345'],
  ])('ファイル名から投稿コードを読む: %s', (name, key) => {
    expect(referenceKeyFromFilename(name)).toBe(key);
  });

  it.each(['buzz.mp4', 'IMG_1234.MOV', 'ig_abc.mp4', 'instagram.mp4', '2026-09-22 reel.mp4'])('投稿コードが無いファイル名: %s', (name) => {
    expect(referenceKeyFromFilename(name)).toBeNull();
  });

  it('一覧の呼び名は 名前 > 元のファイル名 > 鍵', () => {
    expect(libraryEntryLabel({title: '炉端の型', originalName: 'a.mp4', key: 'ig_x12345'})).toBe('炉端の型');
    expect(libraryEntryLabel({title: '  ', originalName: 'a.mp4', key: 'ig_x12345'})).toBe('a.mp4');
    expect(libraryEntryLabel({title: '', originalName: '', key: 'ig_x12345'})).toBe('ig_x12345');
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

  it('名前を付けると、同じ動画を写している案件の表示名も揃う。一覧には使っている案件が出る', () => {
    const key = 'ig_Ddd6Dp5S_wZ';
    const a = makeListedProject('a');
    makeProject(a, analyzed(key));
    storeToLibrary(a, readReference(a)!);
    const b = makeListedProject('b');
    reuseFromLibrary(b, findLibraryEntry(key)!);
    makeListedProject('c'); // 参考動画なし

    const row = setLibraryTitle(key, '  大阪・炉端焼きの発見型  ');
    expect(row.title).toBe('大阪・炉端焼きの発見型');
    expect(row.usedBy.sort()).toEqual(['a-reel', 'b-reel']);
    expect(readReference(a)?.title).toBe('大阪・炉端焼きの発見型');
    expect(readReference(b)?.title).toBe('大阪・炉端焼きの発見型');
    expect(findLibraryEntry(key)?.ref?.title).toBe('大阪・炉端焼きの発見型');
    // 空で消す
    expect(setLibraryTitle(key, '').title).toBe('');
    expect(() => setLibraryTitle('ig_nothing1', 'x')).toThrow(/ライブラリにありません/);

    const idx = libraryIndex();
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({key, originalName: 'buzz.mp4', durationSec: 12, segments: 1, cuts: 2, hookType: '数字で言い切る', usedBy: expect.arrayContaining(['a-reel', 'b-reel'])});
    // 写した案件でライブラリから分析し直しても、ライブラリの名前は残る
    writeReference(b, {...readReference(b)!, summary: '直した'});
    setLibraryTitle(key, '名前');
    storeToLibrary(b, readReference(b)!);
    expect(findLibraryEntry(key)?.ref?.title).toBe('名前');
    expect(findLibraryEntry(key)?.ref?.summary).toBe('直した');
  });

  it('鍵の無い古い取り込みを登録する：ファイル名の投稿コード → 内容の sha256 → 新規 の順で結び付ける', async () => {
    // ライブラリに ig_Ddd6Dp5S_wZ がある（人格づくりで分析したもの）
    const lib = libraryEntryDir('ig_Ddd6Dp5S_wZ');
    makeProject(lib, analyzed('ig_Ddd6Dp5S_wZ', {title: '炉端の型'}));
    // 1. 別のツールで落とした instagram-<code>.mp4 を手で取り込んであった案件（鍵なし・中身も違う）
    const a = makeListedProject('a');
    const refA = analyzed('ig_Ddd6Dp5S_wZ', {summary: '案件 a の分析'});
    makeProject(a, {...refA, source: {...refA.source!, key: undefined, originalName: 'instagram-Ddd6Dp5S_wZ.mp4'}});
    fs.writeFileSync(path.join(referenceStudioDir(a), 'source.mp4'), 'different-bytes');
    const e1 = await registerReferenceToLibrary(a);
    expect(e1.key).toBe('ig_Ddd6Dp5S_wZ');
    expect(e1.title).toBe('炉端の型');
    expect(e1.usedBy).toEqual(['a-reel']);
    expect(readReference(a)?.source?.key).toBe('ig_Ddd6Dp5S_wZ');
    expect(readReference(a)?.title).toBe('炉端の型');
    // 既存のライブラリの分析が正（案件の分析で上書きしない）
    expect(findLibraryEntry('ig_Ddd6Dp5S_wZ')?.ref?.summary).toBe('テスト');
    expect(listLibraryEntries()).toHaveLength(1);

    // 2. ファイル名に手がかりが無いが、中身がライブラリの動画と同じ案件
    const libSha = await hashFileSha256(path.join(referenceStudioDir(lib), 'source.mp4'));
    writeReference(lib, {...readReference(lib)!, source: {...readReference(lib)!.source!, sha: libSha}});
    const b = makeListedProject('b');
    const refB = analyzed('ig_Ddd6Dp5S_wZ');
    makeProject(b, {...refB, source: {...refB.source!, key: undefined, originalName: 'buzz.mp4'}});
    expect(findLibraryEntryBySha(libSha)?.key).toBe('ig_Ddd6Dp5S_wZ');
    const e2 = await registerReferenceToLibrary(b, {title: '新しい名前'});
    expect(e2.key).toBe('ig_Ddd6Dp5S_wZ');
    expect(e2.title).toBe('新しい名前');
    expect(e2.usedBy.sort()).toEqual(['a-reel', 'b-reel']);
    expect(readReference(a)?.title).toBe('新しい名前');

    // 3. どこにも無い動画は、内容の鍵で新しく入る
    const c = makeListedProject('c');
    const refC = analyzed('ig_Other12345');
    makeProject(c, {...refC, source: {...refC.source!, key: undefined, originalName: 'another.mp4'}});
    fs.writeFileSync(path.join(referenceStudioDir(c), 'source.mp4'), 'brand-new-bytes');
    const e3 = await registerReferenceToLibrary(c, {title: '別の型'});
    expect(e3.key).toMatch(/^sha_[0-9a-f]{16}$/);
    expect(e3.title).toBe('別の型');
    expect(listLibraryEntries().map((e) => e.key).sort()).toEqual(['ig_Ddd6Dp5S_wZ', e3.key].sort());
    expect(findLibraryEntry(e3.key)?.videoPath).toBeTruthy();

    // 分析前の案件は登録できない
    const d = makeListedProject('d');
    writeReference(d, {...analyzed('ig_NotYet12345'), analyzedAt: undefined, segments: [], cuts: [], source: {...analyzed('ig_NotYet12345').source!, key: undefined}});
    await expect(registerReferenceToLibrary(d)).rejects.toThrow(/分析済みの参考動画がありません/);
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
