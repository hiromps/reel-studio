// 自前フォント（テロップ用）の置き場と、案件への配り方。
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deleteFont, ensureProjectFont, fontExists, fontsDir, listFonts, saveFont} from '../core/fonts';
import {resetSettings} from '../core/settings';
import {checkFontUpload, fontFamilyOf, isFontFileName, safeFontFile} from '@shared/schema/fonts';
import {customFontFamily} from '@engine/telops';

let home: string;
let work: string;

/** それらしい中身のフォント（先頭 4 バイトの署名だけ本物に合わせる） */
const fontBytes = (sig: 'ttf' | 'otf' | 'woff2' = 'ttf', size = 2048): Buffer => {
  const head = sig === 'ttf' ? Buffer.from([0x00, 0x01, 0x00, 0x00]) : Buffer.from(sig === 'otf' ? 'OTTO' : 'wOF2', 'ascii');
  return Buffer.concat([head, Buffer.alloc(size - 4, 7)]);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fonts-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fonts-proj-'));
  process.env.REEL_STUDIO_HOME = home;
  resetSettings();
});
afterEach(() => {
  delete process.env.REEL_STUDIO_HOME;
  resetSettings();
  fs.rmSync(home, {recursive: true, force: true});
  fs.rmSync(work, {recursive: true, force: true});
});

describe('fonts: 受け入れの判定', () => {
  it('拡張子・中身・大きさを見る', () => {
    expect(checkFontUpload('MyFont.otf', 2048, fontBytes('otf'))).toBeNull();
    expect(checkFontUpload('MyFont.woff2', 2048, fontBytes('woff2'))).toBeNull();
    expect(checkFontUpload('MyFont.exe', 2048, fontBytes())).toMatch(/対応していない拡張子/);
    expect(checkFontUpload('MyFont.ttf', 0, Buffer.alloc(0))).toMatch(/空/);
    expect(checkFontUpload('MyFont.ttf', 2048, Buffer.from('MZ\u0000\u0000', 'ascii'))).toMatch(/フォントファイルではない/);
    expect(checkFontUpload('MyFont.ttf', 100 * 1024 * 1024, fontBytes())).toMatch(/大きすぎ/);
  });

  it('ファイル名は置き場の外に出られない', () => {
    expect(safeFontFile('../../etc/passwd.ttf')).toBe('passwd.ttf');
    expect(safeFontFile('C:\\Windows\\Fonts\\meiryo.ttc')).toBe('meiryo.ttc');
    expect(safeFontFile('.hidden.ttf')).toBe('hidden.ttf');
    expect(isFontFileName('筑紫A丸ゴシック.otf')).toBe(true);
    expect(isFontFileName('notes.txt')).toBe(false);
  });

  it('family の付け方はエンジンと画面で同じ（ここがズレると絵に出ない）', () => {
    for (const f of ['MyFont.otf', '筑紫A丸ゴシック.ttf', 'Font.Name.v2.woff2']) expect(fontFamilyOf(f)).toBe(customFontFamily(f));
  });
});

describe('fonts: 置き場', () => {
  it('取り込む → 一覧に出る → 消える', () => {
    const e = saveFont('MyFont.otf', fontBytes('otf', 4096));
    expect(e.file).toBe('MyFont.otf');
    expect(e.label).toBe('MyFont');
    expect(e.family).toBe('reel-font-MyFont');
    expect(e.sizeBytes).toBe(4096);
    expect(fs.existsSync(path.join(fontsDir(), 'MyFont.otf'))).toBe(true);
    expect(listFonts().map((f) => f.file)).toEqual(['MyFont.otf']);
    expect(fontExists('MyFont.otf')).toBe(true);

    expect(deleteFont('MyFont.otf')).toBe(true);
    expect(listFonts()).toEqual([]);
    expect(deleteFont('MyFont.otf')).toBe(false);
  });

  it('フォントでないものは受け取らない', () => {
    expect(() => saveFont('bad.ttf', Buffer.from('not a font at all', 'utf8'))).toThrow(/フォントファイルではない/);
    expect(() => saveFont('script.js', fontBytes())).toThrow(/対応していない拡張子/);
    expect(listFonts()).toEqual([]);
  });

  it('同じ名前は置き換える', () => {
    saveFont('MyFont.ttf', fontBytes('ttf', 2048));
    const e = saveFont('MyFont.ttf', fontBytes('ttf', 8192));
    expect(e.sizeBytes).toBe(8192);
    expect(listFonts()).toHaveLength(1);
  });

  it('フォント以外のファイルが置き場に混ざっても一覧には出ない', () => {
    fs.mkdirSync(fontsDir(), {recursive: true});
    fs.writeFileSync(path.join(fontsDir(), 'readme.txt'), 'ライセンスのメモ');
    saveFont('MyFont.ttf', fontBytes());
    expect(listFonts().map((f) => f.file)).toEqual(['MyFont.ttf']);
  });
});

describe('fonts: 案件への配り', () => {
  const projectFont = (file: string) => path.join(work, 'public', 'fonts', file);

  it('指定されたフォントを public/fonts/ へコピーし、2 回目は触らない', () => {
    saveFont('MyFont.ttf', fontBytes('ttf', 4096));
    const first = ensureProjectFont(work, 'MyFont.ttf');
    expect(first).toEqual({file: 'MyFont.ttf', copied: true, missing: false});
    expect(fs.statSync(projectFont('MyFont.ttf')).size).toBe(4096);

    expect(ensureProjectFont(work, 'MyFont.ttf')).toEqual({file: 'MyFont.ttf', copied: false, missing: false});
  });

  it('置き場で差し替えたら案件側も追いつく', () => {
    saveFont('MyFont.ttf', fontBytes('ttf', 4096));
    ensureProjectFont(work, 'MyFont.ttf');
    // mtime が同じ秒に収まっても分かるよう、大きさを変える
    saveFont('MyFont.ttf', fontBytes('ttf', 9000));
    expect(ensureProjectFont(work, 'MyFont.ttf').copied).toBe(true);
    expect(fs.statSync(projectFont('MyFont.ttf')).size).toBe(9000);
  });

  it('置き場に無くても案件に実体があれば使える（貰った案件フォルダ）', () => {
    fs.mkdirSync(path.dirname(projectFont('Given.otf')), {recursive: true});
    fs.writeFileSync(projectFont('Given.otf'), fontBytes('otf'));
    expect(ensureProjectFont(work, 'Given.otf')).toEqual({file: 'Given.otf', copied: false, missing: false});
  });

  it('どこにも無ければ missing（同梱の明朝で描かれる。レンダーは止めない）', () => {
    expect(ensureProjectFont(work, 'Nope.ttf')).toEqual({file: 'Nope.ttf', copied: false, missing: true});
    expect(fs.existsSync(projectFont('Nope.ttf'))).toBe(false);
  });

  it('指定が無い・怪しい名前なら何もしない', () => {
    expect(ensureProjectFont(work, undefined)).toEqual({file: null, copied: false, missing: false});
    expect(ensureProjectFont(work, '')).toEqual({file: null, copied: false, missing: false});
    expect(ensureProjectFont(work, 'notes.txt')).toEqual({file: null, copied: false, missing: false});
    // パスを含む指定でも置き場の外は読まない
    saveFont('MyFont.ttf', fontBytes());
    expect(ensureProjectFont(work, '../../MyFont.ttf')).toEqual({file: 'MyFont.ttf', copied: true, missing: false});
    expect(fs.existsSync(projectFont('MyFont.ttf'))).toBe(true);
  });
});
