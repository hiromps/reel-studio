import {describe, expect, it} from 'vitest';
import path from 'node:path';
import {planCuts, PlanError, applyAliasNames} from '@shared/plan';
import {validateCuts, formatValidation} from '@shared/validate';
import {FORMAT_SPECS} from '@shared/format-specs';
import {TEST_PERSONAS} from './helpers';
import {cutDurationSec, totalSec, telopGroupsOf} from '@shared/timeline';
import {isPlaceholder} from '@shared/telop-text';
import type {Clip} from '@shared/schema';
import {fixtures, readJson, makeCatalog, makeClip, makeBrief, richClips} from './helpers';

const NOW = '2026-09-09T00:00:00.000Z';
const opts = {now: NOW};

/** 既存案件の cuts.json ＋ probe から合成 catalog を作る（fixed 回帰用） */
const catalogFromProject = (name: string, probeName: string, fps: number) => {
  const cuts = readJson(path.join(fixtures, `${name}.cuts.json`));
  const probe: Record<string, string> = readJson(path.join(fixtures, `${probeName}.probe.json`));
  const srcs = [...new Set<string>(cuts.cuts.map((c: any) => c.src))];
  const clips: Clip[] = srcs.map((src, i) => {
    const raw = probe[src];
    const [, , , , dur] = raw ? raw.split(',') : [];
    const m = /uploads\/(\d+)_?(.*)\.(\w+)$/.exec(src);
    const id = m ? m[1] : String(i + 1).padStart(2, '0');
    const slug = m && m[2] ? m[2] : src;
    const c = makeClip({id, slug, dur: raw ? parseFloat(dur) : 3.0, kind: 'other', ext: m ? m[3] : 'mp4', fps});
    c.src = src;
    delete (c as any).tags; // 実案件はタグ無しで固定順だけを検証する
    return c;
  });
  return {cuts, catalog: makeCatalog(name, clips, fps), order: srcs.map((s) => clips.find((c) => c.src === s)!.id)};
};

describe('planCuts — 決定論と制約（F7 / F0 / F1）', () => {
  const catalog = makeCatalog('reunion', richClips());
  const brief = makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '11', text: '東大阪、9割が知らない'}, savePriorities: ['hours', 'budget', 'menu'], shop: {name: 'Cafe REUNION', area: '東大阪', genre: 'ティールーム', pr: false}});

  it('同じ入力なら同じ出力（決定論）', () => {
    const a = planCuts({catalog, brief, options: opts});
    const b = planCuts({catalog, brief, options: opts});
    expect(a.cuts).toEqual(b.cuts);
    expect(a.markdown).toEqual(b.markdown);
  });

  it('F7: 先頭がユーザー指定フック、看板は最後の2カットのみ、全カット ≤ 3.0 秒、E ゼロ', () => {
    const r = planCuts({catalog, brief, options: opts});
    const cuts = r.cuts.cuts;
    expect(r.cuts.meta?.slots?.[0].clipId).toBe('11');
    expect(cuts[0].main?.text).toBe('東大阪、9割が知らない');
    const n = cuts.length;
    const signageIdx = r.cuts.meta!.slots!.map((s, i) => (s.clipId === '19' ? i : -1)).filter((i) => i >= 0);
    expect(signageIdx.length).toBeGreaterThan(0);
    for (const i of signageIdx) expect(i).toBeGreaterThanOrEqual(n - 2);
    for (const c of cuts) expect(cutDurationSec(c)).toBeLessThanOrEqual(3.0 + 1e-9);
    const total = totalSec(r.cuts);
    expect(total).toBeGreaterThanOrEqual(24);
    expect(total).toBeLessThanOrEqual(30.05);
    // プレースホルダを埋めた状態で validate → E ゼロ
    const filled = JSON.parse(JSON.stringify(r.cuts));
    for (const c of filled.cuts) if (c.main && isPlaceholder(c.main.text)) c.main.text = 'テスト文言';
    const v = validateCuts(filled, {catalog, brief, spec: FORMAT_SPECS.F7, persona: TEST_PERSONAS.standard});
    expect(v.errors, formatValidation(v)).toEqual([]);
    expect(v.summary.revealPct).toBeGreaterThanOrEqual(0.8);
    // 焦らし → リビール → CTA の順
    const roles = r.cuts.meta!.slots!.map((s) => s.role);
    expect(roles.slice(-3)).toEqual(['tease', 'reveal', 'cta']);
    expect(cuts[n - 3].main?.text).toBe('その名も・・・');
    expect(cuts[n - 1].main?.text).toBe('ぜひ行ってみて');
  });

  it('F7: テロップは複数カットまたぎになり、グループ数が 尺÷1.8〜2.0 付近', () => {
    const r = planCuts({catalog, brief, options: opts});
    const groups = telopGroupsOf(r.cuts);
    const total = totalSec(r.cuts);
    expect(groups.length).toBeLessThan(r.cuts.cuts.length);
    expect(groups.length).toBeGreaterThanOrEqual(Math.floor(total / 2.2));
    expect(groups.length).toBeLessThanOrEqual(Math.ceil(total / 1.6));
    expect(r.cuts.meta!.telopGroups!.length).toBe(groups.length);
  });

  it('F0: 店名リビールが②直後（カット 2〜5）に来る', () => {
    const b0 = makeBrief({...brief, format: 'F0'});
    const r = planCuts({catalog, brief: b0, options: opts});
    const idx = r.cuts.meta!.slots!.findIndex((s) => s.role === 'reveal');
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThanOrEqual(4);
    expect(r.cuts.meta!.slots![idx].clipId).toBe('19');
    expect(totalSec(r.cuts)).toBeLessThanOrEqual(27.05);
    const filled = JSON.parse(JSON.stringify(r.cuts));
    for (const c of filled.cuts) if (c.main && isPlaceholder(c.main.text)) c.main.text = 'テスト文言';
    const v = validateCuts(filled, {catalog, brief: b0, spec: FORMAT_SPECS.F0, persona: TEST_PERSONAS.standard});
    expect(v.errors, formatValidation(v)).toEqual([]);
  });

  it('F1 + 会話クリップ: 保護規則（rate なし・subs・横書き）', () => {
    const clips = richClips();
    clips.push(makeClip({id: '23', slug: 'tenshu-talk', dur: 8.0, kind: 'conversation', speech: true, speechRanges: [{startSec: 0.5, endSec: 3.2}, {startSec: 3.6, endSec: 6.9}]}));
    const cat = makeCatalog('t', clips);
    const b1 = makeBrief({...brief, format: 'F1', speech: {use: true, protect: true}});
    const r = planCuts({catalog: cat, brief: b1, options: opts});
    const conv = r.cuts.cuts.find((c) => c.subs && c.subs.length);
    expect(conv).toBeDefined();
    expect(conv!.playbackRate).toBeUndefined();
    expect(conv!.main).toBeUndefined();
    expect(conv!.subs!.every((s) => s.orientation === 'horizontal')).toBe(true);
    expect(conv!.inSec).toBeCloseTo(0.35, 2);
    expect(conv!.outSec).toBeCloseTo(7.1, 2);
  });

  it('NG クリップは使われない、フック未指定は PlanError', () => {
    const b = makeBrief({...brief, ngClipIds: ['16', '18']});
    const r = planCuts({catalog, brief: b, options: opts});
    expect(r.cuts.meta!.slots!.some((s) => s.clipId === '16' || s.clipId === '18')).toBe(false);
    expect(() => planCuts({catalog, brief: makeBrief({persona: 'standard', format: 'F7'}), options: opts})).toThrow(PlanError);
  });

  it('nagi persona: 既定 F7、リビールは無言、締めは布教', () => {
    const b = makeBrief({persona: 'discovery', hook: {clipId: '11', text: '東大阪、この沼9割知らない'}});
    const r = planCuts({catalog, brief: b, options: opts});
    expect(r.cuts.meta!.generated!.specId).toBe('F7');
    expect(r.cuts.theme).toBe('human');
    const revealIdx = r.cuts.meta!.slots!.findIndex((s) => s.role === 'reveal');
    expect(r.cuts.cuts[revealIdx].main).toBeUndefined();
    expect(r.cuts.cuts[r.cuts.cuts.length - 1].main?.text).toBe('これは布教したい');
  });

  it('F2: units ごとに badge 見出しが付く', () => {
    const b = makeBrief({
      persona: 'standard',
      format: 'F2',
      hook: {clipId: '11'},
      units: [
        {label: '1位 A店', badge: '第1位', clipIds: ['13', '16', '18']},
        {label: '2位 B店', badge: '第2位', clipIds: ['15', '17']},
        {label: '3位 C店', badge: '第3位', clipIds: ['12', '21', '14']},
      ],
    });
    const r = planCuts({catalog, brief: b, options: opts});
    const badges = r.cuts.cuts.filter((c) => c.badge).map((c) => c.badge);
    expect(badges).toEqual(['{{badge:第3位}}', '{{badge:第2位}}', '{{badge:第1位}}']); // 下から発表
  });
});

describe('planCuts — 固定順（fixed）の回帰', () => {
  it('musch-aki: 19 クリップの順序が保たれ、尺が [0.8, 3.0]、グループ数が尺÷1.8〜2.0 付近', () => {
    const {catalog, order} = catalogFromProject('musch-aki', 'musch-aki', 60);
    expect(order.length).toBe(19);
    const brief = makeBrief({persona: 'standard', format: 'F1', materialMode: 'raw', order: {mode: 'fixed', fixed: order}, hook: {clipId: order[0], text: '東梅田、9割が知らない'}, targetSec: 33.7});
    const r = planCuts({catalog, brief, options: opts});
    expect(r.cuts.cuts.length).toBe(19);
    expect(r.cuts.meta!.slots!.map((s) => s.clipId)).toEqual(order);
    for (const c of r.cuts.cuts) {
      expect(cutDurationSec(c)).toBeGreaterThanOrEqual(0.8);
      expect(cutDurationSec(c)).toBeLessThanOrEqual(3.0 + 1e-9);
    }
    const total = totalSec(r.cuts);
    expect(total).toBeGreaterThan(27);
    expect(total).toBeLessThanOrEqual(35);
    const g = telopGroupsOf(r.cuts).length;
    // 納品実績（33.7 秒・13 グループ）と同程度：カット数より少なく、尺÷2.6 以上
    expect(g).toBeLessThan(19);
    expect(g).toBeGreaterThanOrEqual(Math.floor(total / 2.6));
    expect(g).toBeLessThanOrEqual(Math.ceil(total / 1.8) + 1);
    expect(r.aliases).toEqual([]);
  });

  it('2050coffee: 17 クリップ固定順で全尺使用（outSec が素材尺に一致）', () => {
    const {cuts: existing, catalog, order} = catalogFromProject('2050coffee', '2050coffee', 60);
    expect(order.length).toBe(17);
    const brief = makeBrief({persona: 'standard', format: 'F7', order: {mode: 'fixed', fixed: order}, hook: {clipId: order[0], text: '祇園、9割が知らない'}, targetSec: 30});
    const r = planCuts({catalog, brief, options: opts});
    expect(r.cuts.cuts.length).toBe(17);
    r.cuts.cuts.forEach((c, i) => {
      const clip = catalog.clips.find((x) => x.src === c.src)!;
      // 既存 cuts.json は各クリップを頭から全尺使っている。plan は頭から desired 分（≤ 尺）を取る
      expect(c.inSec).toBe(0);
      expect(c.outSec).toBeLessThanOrEqual(clip.probe.durationSec + 1e-6);
      expect(c.outSec).toBeLessThanOrEqual(existing.cuts[i].outSec + 1e-6);
    });
  });
});

describe('planCuts — precut と alias', () => {
  it('precut: シーン境界で同一 src を連続分割し、確定テロップを時刻で流し込む', () => {
    const clip = makeClip({id: '01', slug: 'edited', dur: 14.0, kind: 'other', scenes: [1.2, 2.4, 4.0, 5.5, 7.2, 8.8, 10.1, 11.9, 13.0]});
    delete (clip as any).tags;
    const catalog = makeCatalog('pre', [clip]);
    const brief = makeBrief({persona: 'casual', format: 'F0', materialMode: 'precut', precut: {keepOrder: true, durationPolicy: 'asIs', fixedTelops: [{atSec: 0, text: '梅田、9割が知らない'}, {atSec: 13.5, text: '行ってみてな'}]}});
    const r = planCuts({catalog, brief, options: opts});
    const cuts = r.cuts.cuts;
    expect(cuts.length).toBe(10);
    expect(cuts[0].inSec).toBe(0);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i].inSec).toBe(cuts[i - 1].outSec);
    expect(cuts[cuts.length - 1].outSec).toBe(14);
    expect(cuts.every((c) => c.src === clip.src)).toBe(true);
    expect(cuts[0].main?.text).toBe('梅田、9割が知らない');
    expect(cuts[cuts.length - 1].main?.text).toBe('行ってみてな');
    expect(r.aliases).toEqual([]);
  });

  it('applyAliasNames: 非連続の再参照を別名にする（連続はそのまま）', () => {
    const cuts = [
      {src: 'uploads/08_giant-tank.mp4', inSec: 0, outSec: 1},
      {src: 'uploads/08_giant-tank.mp4', inSec: 1, outSec: 2},
      {src: 'uploads/09_x.mp4', inSec: 0, outSec: 1},
      {src: 'uploads/08_giant-tank.mp4', inSec: 2, outSec: 3},
      {src: 'uploads/09_x.mp4', inSec: 1, outSec: 2},
      {src: 'uploads/08_giant-tank.mp4', inSec: 3, outSec: 4},
    ];
    const ops = applyAliasNames(cuts as any);
    expect(cuts.map((c) => c.src)).toEqual([
      'uploads/08_giant-tank.mp4',
      'uploads/08_giant-tank.mp4',
      'uploads/09_x.mp4',
      'uploads/08b_giant-tank-seg2.mp4',
      'uploads/09b_x-seg2.mp4',
      'uploads/08c_giant-tank-seg3.mp4',
    ]);
    expect(ops.map((o) => o.to)).toEqual(['uploads/08b_giant-tank-seg2.mp4', 'uploads/09b_x-seg2.mp4', 'uploads/08c_giant-tank-seg3.mp4']);
  });

  it('素材が少ないと再利用（alias）で埋め、validate で SAME_SRC が出ない', () => {
    const clips = [
      makeClip({id: '01', slug: 'a', dur: 9.0, kind: 'sizzle', angle: 'close', sizzle: 5}),
      makeClip({id: '02', slug: 'b', dur: 9.0, kind: 'interior', angle: 'wide'}),
      makeClip({id: '03', slug: 'c', dur: 9.0, kind: 'serving', angle: 'mid'}),
      makeClip({id: '04', slug: 'sign', dur: 4.0, kind: 'signage', signage: true}),
    ];
    const catalog = makeCatalog('few', clips);
    const brief = makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '01', text: '東大阪、9割が知らない'}});
    const r = planCuts({catalog, brief, options: opts});
    expect(r.aliases.length).toBeGreaterThan(0);
    const filled = JSON.parse(JSON.stringify(r.cuts));
    for (const c of filled.cuts) if (c.main && isPlaceholder(c.main.text)) c.main.text = 'テスト';
    const v = validateCuts(filled, {spec: FORMAT_SPECS.F7});
    expect(v.errors.map((e) => e.code)).not.toContain('SAME_SRC_NONCONSECUTIVE');
  });
});
