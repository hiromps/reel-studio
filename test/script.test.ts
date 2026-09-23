import {describe, expect, it} from 'vitest';
import {checkScriptPlan, parseSections, repairScriptPlan, scriptTotalSec, sectionDurations, type ScriptPlan} from '@shared/script';
import {ReelDataSchema} from '@shared/schema';
import {stableHash} from '@shared/hash';

const SCRIPT = `【0〜3秒】フック

映像： 盛り合わせの全体。肉のアップ

テロップ：
「価格論争が起きた焼肉盛り」

⸻

【4〜10秒】店舗紹介・価格提示

映像： 店舗外観、店内、看板

⸻

【11〜20秒】話題のメニュー紹介
`;

describe('parseSections', () => {
  it('【0〜3秒】形式の見出しを拾う', () => {
    const s = parseSections(SCRIPT);
    expect(s.map((x) => [x.fromSec, x.toSec])).toEqual([
      [0, 3],
      [4, 10],
      [11, 20],
    ]);
    expect(s[0].label).toBe('フック');
    expect(s[1].label).toBe('店舗紹介・価格提示');
  });

  it('半角・ハイフン・分秒表記も拾う', () => {
    expect(parseSections('[0-3秒] フック').map((x) => [x.fromSec, x.toSec])).toEqual([[0, 3]]);
    expect(parseSections('【1:00〜1:30】締め').map((x) => [x.fromSec, x.toSec])).toEqual([[60, 90]]);
  });

  it('見出しが無い台本でも落ちない（空を返すだけ）', () => {
    expect(parseSections('ふつうの文章です。\n映像：外観')).toEqual([]);
  });

  it('逆順・0 秒幅の区間は捨てる', () => {
    expect(parseSections('【10〜3秒】変\n【5〜5秒】変')).toEqual([]);
  });

  it('全体尺は最後の区間の終わり', () => {
    expect(scriptTotalSec(parseSections(SCRIPT))).toBe(20);
    expect(scriptTotalSec([])).toBeUndefined();
  });
});

const sections = parseSections(SCRIPT);
const durations = new Map([
  ['01', 10],
  ['02', 10],
  ['03', 10],
]);
const plan = (cuts: ScriptPlan['cuts'], narration: ScriptPlan['narration'] = [{id: '01', at: 0, text: 'よみ'}]): ScriptPlan => ({cuts, narration, unmatched: [], notes: ''});
const cut = (o: Partial<ScriptPlan['cuts'][number]> = {}): ScriptPlan['cuts'][number] => ({clipId: '01', inSec: 0, outSec: 3, telop: '', section: sections[0].heading, ...o});

describe('sectionDurations', () => {
  it('区間ごとに合計尺を出す', () => {
    const d = sectionDurations(plan([cut({outSec: 1.5}), cut({inSec: 2, outSec: 3.5}), cut({clipId: '02', outSec: 6, section: sections[1].heading})]), sections);
    expect(d.get(sections[0].heading)).toBeCloseTo(3);
    expect(d.get(sections[1].heading)).toBeCloseTo(6);
    expect(d.get(sections[2].heading)).toBe(0);
  });
});

describe('checkScriptPlan', () => {
  const ctx = {sections, clipDurations: durations};

  it('カットが空なら E', () => {
    expect(checkScriptPlan(plan([]), ctx)[0].code).toBe('SCRIPT_NO_CUTS');
  });

  it('catalog に無い素材は E', () => {
    expect(checkScriptPlan(plan([cut({clipId: '99'})]), ctx).some((i) => i.code === 'SCRIPT_UNKNOWN_CLIP')).toBe(true);
  });

  it('NG にした素材は E', () => {
    expect(checkScriptPlan(plan([cut()]), {...ctx, ngClipIds: new Set(['01'])}).some((i) => i.code === 'SCRIPT_NG_CLIP')).toBe(true);
  });

  it('素材の長さを超える区間は E', () => {
    expect(checkScriptPlan(plan([cut({outSec: 99})]), ctx).some((i) => i.code === 'SCRIPT_OUT_OF_RANGE')).toBe(true);
  });

  it('区間が逆・0 は E', () => {
    expect(checkScriptPlan(plan([cut({inSec: 5, outSec: 2})]), ctx).some((i) => i.code === 'SCRIPT_BAD_RANGE')).toBe(true);
  });

  it('同じ素材の連続は W（切り替わって見えない）', () => {
    const r = checkScriptPlan(plan([cut({inSec: 0, outSec: 1.5}), cut({inSec: 1.5, outSec: 3})]), ctx);
    expect(r.some((i) => i.code === 'SCRIPT_SAME_CLIP_RUN')).toBe(true);
  });

  it('区間の尺が台本とずれたら W', () => {
    // フックは台本 3 秒。1 秒しか割り当てていない
    const r = checkScriptPlan(plan([cut({outSec: 1})]), ctx);
    const i = r.find((x) => x.code === 'SCRIPT_SECTION_LENGTH');
    expect(i?.message).toContain('3.0 秒ですが 1.0 秒');
  });

  it('許容範囲（既定 1.5 秒）に収まっていれば言わない', () => {
    expect(checkScriptPlan(plan([cut({outSec: 2})]), ctx).some((i) => i.code === 'SCRIPT_SECTION_LENGTH')).toBe(false);
  });

  it('カットが無い区間は W', () => {
    const r = checkScriptPlan(plan([cut()]), ctx);
    expect(r.filter((i) => i.code === 'SCRIPT_SECTION_EMPTY')).toHaveLength(2); // 2 個目・3 個目の区間
  });

  it('テロップが長い・句点付きは W', () => {
    const r = checkScriptPlan(plan([cut({telop: 'あ'.repeat(30)}), cut({clipId: '02', telop: 'これは。', section: sections[1].heading, outSec: 6})]), ctx);
    expect(r.some((i) => i.code === 'SCRIPT_TELOP_LONG')).toBe(true);
    expect(r.some((i) => i.code === 'SCRIPT_TELOP_PERIOD')).toBe(true);
  });

  it('ナレーションの重複 id・空・改行は E', () => {
    const r = checkScriptPlan(
      plan([cut()], [
        {id: 'a', at: 0, text: 'よみ'},
        {id: 'a', at: 1, text: ''},
        {id: 'b', at: 2, text: '改行\nあり'},
      ]),
      ctx,
    );
    expect(r.some((i) => i.code === 'SCRIPT_NARR_DUP_ID')).toBe(true);
    expect(r.some((i) => i.code === 'SCRIPT_NARR_EMPTY')).toBe(true);
    expect(r.some((i) => i.code === 'SCRIPT_NARR_NEWLINE')).toBe(true);
  });

  it('動画尺より後ろのナレーションは E', () => {
    expect(checkScriptPlan(plan([cut()], [{id: 'a', at: 99, text: 'よみ'}]), ctx).some((i) => i.code === 'SCRIPT_NARR_AFTER_END')).toBe(true);
  });

  it('ナレーションが無ければ W', () => {
    expect(checkScriptPlan(plan([cut()], []), ctx).some((i) => i.code === 'SCRIPT_NARR_MISSING')).toBe(true);
  });

  it('台本どおりに埋まっていれば E は出ない', () => {
    const p = plan(
      [
        cut({outSec: 3}),
        cut({clipId: '02', inSec: 0, outSec: 6, section: sections[1].heading}),
        cut({clipId: '03', inSec: 0, outSec: 9, section: sections[2].heading}),
      ],
      [{id: '01_hook', at: 0, text: 'よみ'}],
    );
    expect(checkScriptPlan(p, ctx).filter((i) => i.severity === 'E')).toEqual([]);
  });
});

describe('組み立てた cuts が ReelDataSchema を通る', () => {
  it('meta.generated には briefHash / catalogHash が要る（実際に落ちたので固定する）', () => {
    const build = (generated: Record<string, unknown>) =>
      ReelDataSchema.safeParse({
        fps: 30,
        theme: 'pop',
        cuts: [{id: 'c01', src: 'uploads/01.mov', inSec: 0, outSec: 1.5, main: {text: 'テロップ'}}],
        meta: {slots: [{cutId: 'c01', segment: '【0〜3秒】フック', role: 'info', clipId: '01', textStatus: 'draft', locked: false, qc: []}], generated},
      });
    expect(build({tool: 'reel-studio/script', at: '2026-09-13T00:00:00.000Z', specId: 'F0'}).success).toBe(false);
    expect(
      build({tool: 'reel-studio/script', at: '2026-09-13T00:00:00.000Z', briefHash: stableHash({a: 1}), catalogHash: stableHash({b: 2}), specId: 'F0'}).success,
    ).toBe(true);
  });
});

// AI の返答のうち機械的に直せる E は、AI を走らせ直さずに直す（1 回 5〜7 分・課金があるため）
describe('repairScriptPlan', () => {
  const ctx = {sections, clipDurations: durations};
  // 台本どおり 20 秒（3 + 6 + 9）に埋めた組み立て
  const full = (narration: ScriptPlan['narration']) =>
    plan(
      [
        cut({outSec: 3}),
        cut({clipId: '02', inSec: 0, outSec: 6, section: sections[1].heading}),
        cut({clipId: '03', inSec: 0, outSec: 9, section: sections[2].heading}),
      ],
      narration,
    );

  it('直すところが無ければ何も変えない', () => {
    const p = full([{id: '01_hook', at: 0, text: 'よみ'}]);
    const r = repairScriptPlan(p, ctx);
    expect(r.fixes).toEqual([]);
    expect(r.plan).toEqual(p);
    expect(checkScriptPlan(r.plan, ctx).filter((i) => i.severity === 'E')).toEqual([]);
  });

  it('動画尺より後ろのナレーションは、台本の区間 → 実際の映像の位置 に写す（実際に起きた 06_close の件）', () => {
    // 台本は 【11〜20秒】 まであるが、カットの合計は 13.5 秒しか無い。締めのナレーションは台本の秒（14 秒）で書かれている
    const p = plan(
      [cut({outSec: 3}), cut({clipId: '02', inSec: 0, outSec: 6, section: sections[1].heading}), cut({clipId: '03', inSec: 0, outSec: 4.5, section: sections[2].heading})],
      [
        {id: '01_hook', at: 0, text: 'よみ'},
        {id: '06_close', at: 14, text: '締めのひとこと'},
      ],
    );
    expect(checkScriptPlan(p, ctx).some((i) => i.code === 'SCRIPT_NARR_AFTER_END')).toBe(true);
    const r = repairScriptPlan(p, ctx);
    // 【11〜20秒】の 14 秒 = 区間の 1/3。実際のその区間は 9.0〜13.5 秒なので 9 + 4.5/3 = 10.5 秒
    expect(r.plan.narration.map((n) => [n.id, n.at])).toEqual([
      ['01_hook', 0],
      ['06_close', 10.5],
    ]);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes[0]).toContain('06_close');
    expect(r.fixes[0]).toContain('動画尺（13.5 秒）より後ろ');
    expect(r.fixes[0]).toContain('10.5 秒に動かしました');
    expect(checkScriptPlan(r.plan, ctx).filter((i) => i.severity === 'E')).toEqual([]);
  });

  it('台本の終わりよりさらに後ろなら、最後の区間の頭に置く。前のブロックより前には戻さない', () => {
    const p = plan(
      [cut({outSec: 3}), cut({clipId: '02', inSec: 0, outSec: 6, section: sections[1].heading}), cut({clipId: '03', inSec: 0, outSec: 4.5, section: sections[2].heading})],
      [
        {id: '05_info', at: 12, text: 'なか'},
        {id: '06_close', at: 30, text: '締め'},
      ],
    );
    const r = repairScriptPlan(p, ctx);
    // 最後の区間の頭は 9.0 秒だが、05_info（12 秒）より前には戻さない
    expect(r.plan.narration.find((n) => n.id === '06_close')?.at).toBe(12);
    expect(r.plan.narration.find((n) => n.id === '05_info')?.at).toBe(12);
    expect(r.fixes).toHaveLength(1);
  });

  it('区間の見出しが無い台本でも、最後のカットの頭に置いて動画の中に収める', () => {
    const p = plan([cut({outSec: 3, section: ''}), cut({clipId: '02', inSec: 0, outSec: 6, section: ''})], [{id: 'a', at: 20, text: 'よみ'}]);
    const r = repairScriptPlan(p, {sections: [], clipDurations: durations});
    expect(r.plan.narration[0].at).toBe(3);
    expect(checkScriptPlan(r.plan, {sections: [], clipDurations: durations}).filter((i) => i.severity === 'E')).toEqual([]);
  });

  it('素材の長さを超えるカットは、同じ長さのまま素材の終わりに詰める', () => {
    const r = repairScriptPlan(plan([cut({inSec: 8, outSec: 11})]), ctx);
    expect(r.plan.cuts[0]).toMatchObject({inSec: 7, outSec: 10});
    expect(r.fixes[0]).toContain('素材の長さ 10.00 秒を超えていた');
    expect(checkScriptPlan(r.plan, ctx).some((i) => i.code === 'SCRIPT_OUT_OF_RANGE')).toBe(false);
  });

  it('区間が逆なら入れ替える。0 秒は直せないので E のまま', () => {
    const r = repairScriptPlan(plan([cut({inSec: 3, outSec: 1}), cut({clipId: '02', inSec: 2, outSec: 2, section: sections[1].heading})]), ctx);
    expect(r.plan.cuts[0]).toMatchObject({inSec: 1, outSec: 3});
    expect(r.fixes).toHaveLength(1);
    expect(checkScriptPlan(r.plan, ctx).some((i) => i.code === 'SCRIPT_BAD_RANGE')).toBe(true);
  });

  it('catalog に無い id は、拡張子・パス違いで 1 つに決まるときだけ読み替える', () => {
    const r = repairScriptPlan(plan([cut({clipId: 'uploads/01.mov'}), cut({clipId: '99', section: sections[1].heading})]), ctx);
    expect(r.plan.cuts.map((c) => c.clipId)).toEqual(['01', '99']);
    expect(r.fixes).toHaveLength(1);
    expect(checkScriptPlan(r.plan, ctx).filter((i) => i.code === 'SCRIPT_UNKNOWN_CLIP')).toHaveLength(1);
  });

  it('ナレーションの改行は 1 行に、空は外し、id の重複は連番を足す', () => {
    const r = repairScriptPlan(
      plan(
        [cut()],
        [
          {id: 'a', at: 0, text: '改行\nあり'},
          {id: 'a', at: 1, text: 'ふたつめ'},
          {id: 'b', at: 2, text: '  '},
        ],
      ),
      ctx,
    );
    expect(r.plan.narration).toEqual([
      {id: 'a', at: 0, text: '改行あり'},
      {id: 'a_2', at: 1, text: 'ふたつめ'},
    ]);
    expect(r.fixes).toHaveLength(3);
    expect(checkScriptPlan(r.plan, ctx).filter((i) => i.severity === 'E')).toEqual([]);
  });

  it('NG にした素材・カット無しは直せない（E のまま）', () => {
    expect(repairScriptPlan(plan([cut()]), {...ctx, ngClipIds: new Set(['01'])}).fixes).toEqual([]);
    expect(repairScriptPlan(plan([], [{id: 'a', at: 5, text: 'よみ'}]), ctx).fixes).toEqual([]);
  });
});
