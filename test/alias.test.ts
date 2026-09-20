import {describe, expect, it} from 'vitest';
import {realignAliases, aliasFixCount} from '@shared/alias';
import {validateCuts} from '@shared/validate';
import type {ReelData} from '@shared/schema';

const reel = (srcs: string[], aliases?: {from: string; to: string; applied?: boolean}[]): ReelData => ({
  fps: 30,
  theme: 'pop',
  meta: aliases ? {aliases: aliases.map((a) => ({applied: false, ...a}))} : undefined,
  cuts: srcs.map((src, i) => ({id: `c${String(i + 1).padStart(2, '0')}`, src, inSec: i, outSec: i + 1, main: {text: `てろっぷ${i + 1}`}})),
});

describe('realignAliases — 非連続の再参照だけを別名に振り直す', () => {
  it('連続はそのまま、離れた再参照だけ別名にする', () => {
    const r = realignAliases(reel(['uploads/08_tank.mp4', 'uploads/08_tank.mp4', 'uploads/09_x.mp4', 'uploads/08_tank.mp4', 'uploads/09_x.mp4', 'uploads/08_tank.mp4']));
    expect(r.data.cuts.map((c) => c.src)).toEqual([
      'uploads/08_tank.mp4',
      'uploads/08_tank.mp4',
      'uploads/09_x.mp4',
      'uploads/08b_tank-seg2.mp4',
      'uploads/09b_x-seg2.mp4',
      'uploads/08c_tank-seg3.mp4',
    ]);
    expect(r.renames.map((x) => x.cutId)).toEqual(['c04', 'c05', 'c06']);
    expect(r.data.meta?.aliases?.map((a) => `${a.from} → ${a.to}`)).toEqual([
      'uploads/08_tank.mp4 → uploads/08b_tank-seg2.mp4',
      'uploads/09_x.mp4 → uploads/09b_x-seg2.mp4',
      'uploads/08_tank.mp4 → uploads/08c_tank-seg3.mp4',
    ]);
  });

  it('直したあとは SAME_SRC_NONCONSECUTIVE が消える', () => {
    const before = reel(['uploads/01_a.mp4', 'uploads/02_b.mp4', 'uploads/01_a.mp4']);
    expect(validateCuts(before).errors.map((e) => e.code)).toContain('SAME_SRC_NONCONSECUTIVE');
    const after = realignAliases(before).data;
    expect(validateCuts(after).errors.map((e) => e.code)).not.toContain('SAME_SRC_NONCONSECUTIVE');
  });

  it('既に正しい別名なら何もしない（何度押しても同じ）', () => {
    const once = realignAliases(reel(['uploads/01_a.mp4', 'uploads/02_b.mp4', 'uploads/01_a.mp4']));
    const twice = realignAliases(once.data);
    expect(twice.renames).toEqual([]);
    expect(twice.data).toBe(once.data); // 変更が無いときは同じオブジェクトを返す
    expect(aliasFixCount(once.data)).toBe(0);
  });

  it('別名のほうを非連続で使っていたら、その別名を元にさらに別名を作る', () => {
    const data = reel(
      ['uploads/01b_a-seg2.mp4', 'uploads/02_b.mp4', 'uploads/01b_a-seg2.mp4'],
      [{from: 'uploads/01_a.mp4', to: 'uploads/01b_a-seg2.mp4', applied: true}],
    );
    const r = realignAliases(data);
    expect(r.renames.length).toBe(1);
    // 元（01_a）から数えて 3 ブロック目なので seg3。コピー元は実在する 01b_a-seg2
    expect(r.data.cuts[2].src).toBe('uploads/01c_a-seg3.mp4');
    expect(r.data.meta?.aliases?.at(-1)).toMatchObject({from: 'uploads/01b_a-seg2.mp4', to: 'uploads/01c_a-seg3.mp4', applied: false});
  });

  it('元が違う既存の別名と名前がぶつかったらずらす（中身の取り違えを防ぐ）', () => {
    const data = reel(
      ['uploads/01_a.mp4', 'uploads/02_b.mp4', 'uploads/01_a.mp4'],
      [{from: 'uploads/99_other.mp4', to: 'uploads/01b_a-seg2.mp4', applied: true}],
    );
    const r = realignAliases(data);
    expect(r.data.cuts[2].src).toBe('uploads/01c_a-seg3.mp4');
  });

  it('同じ別名が他のカットで使われていたらずらす', () => {
    const data = reel(['uploads/01_a.mp4', 'uploads/01b_a-seg2.mp4', 'uploads/02_b.mp4', 'uploads/01_a.mp4']);
    const r = realignAliases(data);
    // 01b_a-seg2 は meta に無いので別素材扱い。名前がぶつかるので seg3 になる
    expect(r.data.cuts[3].src).toBe('uploads/01c_a-seg3.mp4');
  });

  it('入力の cuts は書き換えない', () => {
    const before = reel(['uploads/01_a.mp4', 'uploads/02_b.mp4', 'uploads/01_a.mp4']);
    realignAliases(before);
    expect(before.cuts[2].src).toBe('uploads/01_a.mp4');
  });
});
