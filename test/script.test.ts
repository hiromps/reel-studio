import {describe, expect, it} from 'vitest';
import {checkScriptPlan, parseSections, scriptTotalSec, sectionDurations, type ScriptPlan} from '@shared/script';
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
