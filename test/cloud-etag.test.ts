// クラウド版の ETag（rev-hash）の扱い。
// ローカル版は「mtime-size」を ETag にしているが、クラウドでは版番号（rev）とハッシュを繋げたものを使う。
// 画面（src/api.ts）は ETag を中身の分からない文字列として If-Match に載せ直すだけなので、
// 大事なのは「rev が読み戻せること」と「中身が変われば ETag も変わること」の 2 点。
import {describe, expect, it} from 'vitest';
import {docEtag, revOfEtag} from '../cloud/store';
import {stableHash} from '@shared/hash';

describe('クラウドの ETag', () => {
  it('rev とハッシュを繋げた形になる', () => {
    expect(docEtag(3, 'a1b2c3d4')).toBe('3-a1b2c3d4');
  });

  it('ETag から rev を読み戻せる', () => {
    expect(revOfEtag('3-a1b2c3d4')).toBe(3);
    expect(revOfEtag('12-0000ffff')).toBe(12);
  });

  it('ETag が無い・形が違うときは null（If-Match 無しと同じ扱いにする）', () => {
    expect(revOfEtag(null)).toBeNull();
    expect(revOfEtag(undefined)).toBeNull();
    expect(revOfEtag('')).toBeNull();
    // ローカル版の ETag（mtime-size）を誤って送られても rev としては読まない…
    // ではなく先頭の数字を読むので、突き合わせで外れて 409 になる（黙って上書きしない）
    expect(revOfEtag('W/"abc"')).toBeNull();
  });

  it('中身が変われば ETag も変わる（同じ中身なら同じ）', () => {
    const a = {cuts: [{src: 'uploads/01.mp4', inSec: 0, outSec: 2}]};
    const b = {cuts: [{src: 'uploads/01.mp4', inSec: 0, outSec: 3}]};
    expect(docEtag(1, stableHash(a))).not.toBe(docEtag(1, stableHash(b)));
    // キーの順番が違っても同じハッシュ（stableHash はキーを並べ替える）
    expect(stableHash({x: 1, y: 2})).toBe(stableHash({y: 2, x: 1}));
  });
});
