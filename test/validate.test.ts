import {describe, expect, it} from 'vitest';
import path from 'node:path';
import {validateCuts, formatValidation} from '@shared/validate';
import {FORMAT_SPECS} from '@shared/format-specs';
import {PERSONAS} from '@shared/personas';
import {fixtures, readJson, makeCatalog, makeClip, makeBrief} from './helpers';
import type {ReelData} from '@shared/schema';

const load = (name: string) => readJson(path.join(fixtures, `${name}.cuts.json`));
const codes = (issues: {code: string}[]) => issues.map((i) => i.code);

describe('validateCuts — 既存の納品物は E ゼロ', () => {
  it('2050coffee（F7・hiro）', () => {
    const r = validateCuts(load('2050coffee'), {spec: FORMAT_SPECS.F7, persona: PERSONAS.hiro});
    expect(r.errors, formatValidation(r)).toEqual([]);
    expect(r.summary.totalFrames).toBe(1641);
    expect(r.summary.cutCount).toBe(17);
  });
  it('musch-aki（F1・hiro・固定順）', () => {
    const r = validateCuts(load('musch-aki'), {spec: FORMAT_SPECS.F1, persona: PERSONAS.hiro});
    expect(r.errors, formatValidation(r)).toEqual([]);
    expect(r.summary.groupCount).toBe(13);
    expect(codes(r.warnings)).toContain('THEME_MISMATCH'); // stylish（推奨 pop）
  });
  it('katsugyocenter-nagi（F7・nagi・alias 済み）', () => {
    const r = validateCuts(load('katsugyocenter-nagi'), {spec: FORMAT_SPECS.F7, persona: PERSONAS.nagi});
    expect(r.errors, formatValidation(r)).toEqual([]);
    expect(codes(r.errors)).not.toContain('SAME_SRC_NONCONSECUTIVE');
    expect(r.summary.revealPct).toBeUndefined(); // slot も catalog も無いので位置は判定しない
  });
  it('reunion-hiro（F7・hiro）', () => {
    const r = validateCuts(load('reunion-hiro'), {spec: FORMAT_SPECS.F7, persona: PERSONAS.hiro});
    expect(r.errors, formatValidation(r)).toEqual([]);
    expect(codes(r.warnings)).toContain('TELOP_OVER_MAX_CHARS'); // 14 文字のフック
    expect(codes(r.warnings)).toContain('CTA_TEXT');
  });
  it('context 無しでも動き、依存ルールは skipped に列挙される', () => {
    const r = validateCuts(load('2050coffee'));
    expect(r.ok).toBe(true);
    expect(r.skipped).toContain('TOTAL_OVER_MAX');
    expect(r.skipped).toContain('HOOK_SIGNAGE');
  });
});

describe('validateCuts — 壊れた cuts を検出する', () => {
  const base = () => ({fps: 60, theme: 'pop', cuts: [{src: 'uploads/01_a.mp4', inSec: 0, outSec: 1.2, main: {text: '東大阪、9割が知らない'}}]});

  it('SCHEMA', () => {
    const r = validateCuts({fps: 60});
    expect(codes(r.errors)).toContain('SCHEMA');
    expect(r.ok).toBe(false);
  });
  it('CUT_TOO_LONG と fix.trimTo', () => {
    const d = base();
    d.cuts.push({src: 'uploads/02_b.mp4', inSec: 0, outSec: 3.5, main: {text: 'ながい'}});
    const r = validateCuts(d, {spec: FORMAT_SPECS.F0});
    const e = r.errors.find((i) => i.code === 'CUT_TOO_LONG')!;
    expect(e).toBeDefined();
    expect(e.fix).toEqual({type: 'trimTo', payload: {outSec: 3}});
  });
  it('TELOP_PLACEHOLDER / TELOP_PERIOD / TELOP_FORBIDDEN_CHARS / TELOP_TOO_LONG', () => {
    const d = base();
    d.cuts.push(
      {src: 'uploads/02_b.mp4', inSec: 0, outSec: 1.5, main: {text: '{{g02:access}}'}},
      {src: 'uploads/03_c.mp4', inSec: 0, outSec: 1.5, main: {text: '句点あり。'}},
      {src: 'uploads/04_d.mp4', inSec: 0, outSec: 1.5, main: {text: '半角(かっこ)🍜'}},
      {src: 'uploads/05_e.mp4', inSec: 0, outSec: 2.5, main: {text: 'あいうえおかきくけこさしすせそたちつてと'}},
    );
    const r = validateCuts(d);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(['TELOP_PLACEHOLDER', 'TELOP_PERIOD', 'TELOP_FORBIDDEN_CHARS', 'TELOP_TOO_LONG']));
    expect(r.summary.placeholders).toBe(1);
  });
  it('SAME_SRC_NONCONSECUTIVE（連続は許容）', () => {
    const d = base();
    d.cuts.push({src: 'uploads/01_a.mp4', inSec: 1.2, outSec: 2.0, main: {text: '連続はOK'}});
    d.cuts.push({src: 'uploads/02_b.mp4', inSec: 0, outSec: 1.0, main: {text: '別'}});
    d.cuts.push({src: 'uploads/01_a.mp4', inSec: 2.0, outSec: 3.0, main: {text: '非連続はNG'}});
    const r = validateCuts(d);
    const e = r.errors.filter((i) => i.code === 'SAME_SRC_NONCONSECUTIVE');
    expect(e.length).toBe(1);
    expect(e[0].cutIndex).toBe(3);
    expect(e[0].fix?.type).toBe('alias');
  });
  it('SUBS_AND_MAIN / CONVERSATION_RATE / SUBS_RANGE', () => {
    const d = base();
    d.cuts.push({
      src: 'uploads/02_b.mp4',
      inSec: 1.0,
      outSec: 5.0,
      playbackRate: 1.25,
      main: {text: '併用'},
      subs: [{text: 'はみ出す', startSec: 0.5, endSec: 2.0, orientation: 'horizontal'}],
    } as any);
    const r = validateCuts(d);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(['SUBS_AND_MAIN', 'CONVERSATION_RATE', 'SUBS_RANGE']));
  });
  it('TOTAL_OVER_MAX（尺の上限超え）', () => {
    const d = base();
    for (let i = 0; i < 12; i++) d.cuts.push({src: `uploads/${10 + i}_x.mp4`, inSec: 0, outSec: 2.5, main: {text: `カット${i}`}});
    const r = validateCuts(d, {spec: FORMAT_SPECS.F7});
    expect(codes(r.errors)).toEqual(expect.arrayContaining(['TOTAL_OVER_MAX']));
  });

  describe('badge の許可（型ごと）', () => {
    const withBadge = (text: string) => {
      const d = base();
      (d.cuts[0] as any).badge = text;
      return d;
    };

    it('F0 はエリアバッジを許可する（E を出さない）', () => {
      const r = validateCuts(withBadge('西九条'), {spec: FORMAT_SPECS.F0});
      expect(codes(r.errors)).not.toContain('BADGE_FORMAT');
    });

    it('F0 でバッジを使わなくても催促しない（任意なので）', () => {
      const r = validateCuts(base(), {spec: FORMAT_SPECS.F0});
      expect(codes(r.warnings)).not.toContain('BADGE_MISSING');
    });

    it('F2（順位）はバッジが無いと W を出す', () => {
      const r = validateCuts(base(), {spec: FORMAT_SPECS.F2});
      expect(codes(r.warnings)).toContain('BADGE_MISSING');
    });

    it('どの型でもバッジを禁止しない（演出なので型で縛らない）', () => {
      for (const id of ['F1', 'F3', 'F4', 'F5', 'F7'] as const) {
        const r = validateCuts(withBadge('西九条'), {spec: FORMAT_SPECS[id]});
        expect(codes(r.errors), id).not.toContain('BADGE_FORMAT');
      }
    });

    it('F6（店名）もバッジが無いと W を出す', () => {
      expect(codes(validateCuts(base(), {spec: FORMAT_SPECS.F6}).warnings)).toContain('BADGE_MISSING');
    });

    it('バッジ自体が未記入なら型に関係なく E（TELOP_PLACEHOLDER）', () => {
      const r = validateCuts(withBadge('{{b01:エリア}}'), {spec: FORMAT_SPECS.F3});
      expect(codes(r.errors)).toContain('TELOP_PLACEHOLDER');
    });
  });
  it('catalog があると NG / 尺超過 / 看板フック / F7 温存を判定する', () => {
    const catalog = makeCatalog('t', [
      makeClip({id: '01', slug: 'sign', dur: 2.0, kind: 'signage', signage: true}),
      makeClip({id: '02', slug: 'ng', dur: 2.0, kind: 'interior'}),
      makeClip({id: '03', slug: 'food', dur: 1.5, kind: 'sizzle'}),
    ]);
    catalog.clips[1].user.ng = true;
    const d = {
      fps: 60,
      cuts: [
        {src: 'uploads/01_sign.mov', inSec: 0, outSec: 1.2, main: {text: '看板がフック'}},
        {src: 'uploads/02_ng.mov', inSec: 0, outSec: 1.2, main: {text: 'NG素材'}},
        {src: 'uploads/03_food.mov', inSec: 0, outSec: 1.9, main: {text: '尺超過'}},
      ],
    };
    const r = validateCuts(d, {catalog, spec: FORMAT_SPECS.F7});
    expect(codes(r.errors)).toEqual(expect.arrayContaining(['HOOK_SIGNAGE', 'NG_CLIP_USED', 'OUT_BEYOND_DURATION', 'F7_SIGNAGE_EARLY']));
  });
  it('brief.order.fixed と違う並びは W で知らせる（レンダーは止めない）', () => {
    const catalog = makeCatalog('t', [
      makeClip({id: '01', slug: 'a', dur: 2.0, kind: 'sizzle'}),
      makeClip({id: '02', slug: 'b', dur: 2.0, kind: 'interior'}),
    ]);
    const brief = makeBrief({persona: 'hiro', order: {mode: 'fixed', fixed: ['01', '02']}, hook: {clipId: '01'}});
    const d = {fps: 60, cuts: [{src: 'uploads/02_b.mov', inSec: 0, outSec: 1.2, main: {text: '東大阪、9割'}}, {src: 'uploads/01_a.mov', inSec: 0, outSec: 1.2, main: {text: 'b'}}]};
    const r = validateCuts(d, {catalog, brief});
    // 自分で並べ替えた構成をレンダーできなくなるので E にはしない
    expect(codes(r.warnings)).toContain('ORDER_FIXED_VIOLATION');
    expect(codes(r.errors)).not.toContain('ORDER_FIXED_VIOLATION');
    expect(codes(r.errors)).toContain('HOOK_NOT_USER');
  });
  it('同じ素材を 2 回使う固定順を違反にしない', () => {
    // id → 位置の Map にすると '01' が後勝ちで 1 個に潰れ、間の '02' が全部違反に見えていた
    const catalog = makeCatalog('t', [
      makeClip({id: '01', slug: 'a', dur: 4.0, kind: 'sizzle'}),
      makeClip({id: '02', slug: 'b', dur: 2.0, kind: 'interior'}),
    ]);
    const brief = makeBrief({persona: 'hiro', order: {mode: 'fixed', fixed: ['01', '02', '01']}, hook: {clipId: '01'}});
    const d = {
      fps: 60,
      cuts: [
        {src: 'uploads/01_a.mov', inSec: 0, outSec: 1.2, main: {text: '東大阪、9割'}},
        {src: 'uploads/02_b.mov', inSec: 0, outSec: 1.2, main: {text: 'b'}},
        {src: 'uploads/01_a.mov', inSec: 2.0, outSec: 3.2, main: {text: 'c'}},
      ],
    };
    expect(codes(validateCuts(d, {catalog, brief}).errors)).not.toContain('ORDER_FIXED_VIOLATION');
  });
});

describe('フックのエリア名はバッジに出す', () => {
  const hookCuts = (text: string, badge?: string): ReelData =>
    ({
      fps: 30,
      theme: 'pop',
      cuts: [
        {id: 'c01', src: 'uploads/01_a.mp4', inSec: 0, outSec: 1.5, main: {text}, ...(badge ? {badge} : {})},
        {id: 'c02', src: 'uploads/02_b.mp4', inSec: 0, outSec: 1.5, main: {text: 'ぜひ行ってみて'}},
      ],
    }) as unknown as ReelData;
  const ctx = (cuts: ReelData) =>
    validateCuts(cuts, {brief: makeBrief({persona: 'hiro', shop: {name: '焼肉たべる', area: '生野区', genre: '焼肉', pr: false}}), persona: PERSONAS.hiro});

  it('本文がエリア名で始まっていたら W（バッジへ移す）', () => {
    const r = ctx(hookCuts('生野区、9割が知らない'));
    const i = r.warnings.find((x) => x.code === 'HOOK_AREA_IN_TELOP');
    expect(i).toBeDefined();
    expect(i!.message).toContain('地元の9割が知らない'); // 言い換えの例を出す
  });

  it('「生野区で」「生野区の」のような助詞付きも拾う', () => {
    for (const t of ['生野区で9割が知らない', '生野区の9割が素通りする']) expect(codes(ctx(hookCuts(t)).warnings), t).toContain('HOOK_AREA_IN_TELOP');
  });

  it('バッジに出して本文を言い換えていれば指摘しない', () => {
    expect(codes(ctx(hookCuts('地元の9割が知らない', '生野区')).warnings)).not.toContain('HOOK_AREA_IN_TELOP');
  });

  it('文中のエリア名は触らない（頭にあるときだけ）', () => {
    expect(codes(ctx(hookCuts('9割が知らない生野区の店')).warnings)).not.toContain('HOOK_AREA_IN_TELOP');
  });

  it('本文がエリア名だけなら移せないので指摘しない', () => {
    expect(codes(ctx(hookCuts('生野区')).warnings)).not.toContain('HOOK_AREA_IN_TELOP');
  });

  it('バッジにエリアがあれば、本文に一桁数字だけでも「エリア＋数字」型として通す', () => {
    expect(codes(ctx(hookCuts('地元の9割が知らない', '生野区')).warnings)).not.toContain('HOOK_TEXT_PATTERN');
    // バッジが無ければ従来どおり型を要求する
    expect(codes(ctx(hookCuts('地元の人が知らない')).warnings)).toContain('HOOK_TEXT_PATTERN');
  });
});
