// 台本からの組み立て：「割り当てを見るだけ」の結果を残し、承認されたら AI を走らせずに書き込む。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseSections, reviewScriptProposal, scriptPlanToCuts, scriptPlanToNarration, scriptTextHash, type ScriptPlan, type ScriptProposal} from '@shared/script';
import {NarrationSchema, ReelDataSchema} from '@shared/schema';
import {applyScriptProposal, scriptProposalPath, scriptProposalView} from '../core/script';
import {makeBrief, makeCatalog, makeClip} from './helpers';

const SCRIPT = `【0〜3秒】フック
映像： 肉のアップ
テロップ： 価格論争が起きた焼肉盛り
ナレーション： これ、いくらに見えますか？

【3〜6秒】店舗紹介
映像： 外観
`;

const clips = () => [
  makeClip({id: '01', slug: 'niku-up', dur: 4, kind: 'sizzle', angle: 'close'}),
  makeClip({id: '02', slug: 'gaikan', dur: 5, kind: 'exterior', angle: 'wide'}),
];

const plan = (over: Partial<ScriptPlan> = {}): ScriptPlan => ({
  cuts: [
    {clipId: '01', inSec: 0.5, outSec: 3.5, telop: '価格論争が起きた焼肉盛り', section: '【0〜3秒】フック'},
    {clipId: '02', inSec: 1, outSec: 4, telop: '', badge: '東大阪', section: '【3〜6秒】店舗紹介'},
  ],
  narration: [{id: '01_hook', at: 0.2, text: 'これ、いくらに見えますか？'}],
  unmatched: [],
  notes: 'フックは肉の寄り',
  ...over,
});

const proposal = (over: Partial<ScriptProposal> = {}): ScriptProposal => ({version: 1, createdAt: '2026-09-18T00:00:00.000Z', scriptHash: scriptTextHash(SCRIPT), model: 'sonnet', costUsd: 0.8, plan: plan(), autoFixes: [], ...over});

const check = () => ({
  sections: parseSections(SCRIPT),
  clipDurations: new Map(clips().map((c) => [c.id, c.probe.durationSec])),
  ngClipIds: new Set<string>(),
  maxTelopChars: 13,
});

const buildCtx = {catalog: makeCatalog('t', clips()), theme: 'pop' as const, specId: 'F0', briefHash: 'b', catalogHash: 'c', at: '2026-09-18T00:00:00.000Z'};

describe('scriptPlanToCuts / scriptPlanToNarration', () => {
  it('src はいまの catalog から引き、テロップ・バッジ・slot を入れる', () => {
    const cuts = ReelDataSchema.parse(scriptPlanToCuts(plan(), buildCtx));
    expect(cuts.cuts.map((c) => [c.id, c.src, c.inSec, c.outSec])).toEqual([
      ['c01', 'uploads/01_niku-up.mov', 0.5, 3.5],
      ['c02', 'uploads/02_gaikan.mov', 1, 4],
    ]);
    expect(cuts.cuts[0].main?.text).toBe('価格論争が起きた焼肉盛り');
    expect(cuts.cuts[1].main).toBeUndefined();
    expect(cuts.cuts[1].badge).toBe('東大阪');
    expect(cuts.meta?.slots?.map((s) => s.segment)).toEqual(['【0〜3秒】フック', '【3〜6秒】店舗紹介']);
  });

  it('ナレーションは全ブロック要生成。無ければ null', () => {
    const n = NarrationSchema.parse(scriptPlanToNarration(plan(), {voiceId: '0'.repeat(32), voiceTitle: 'v', speed: 1.2}));
    expect(n.videoSec).toBe(6);
    expect(n.segments).toEqual([{id: '01_hook', at: 0.2, text: 'これ、いくらに見えますか？', needsTts: true}]);
    expect(scriptPlanToNarration(plan({narration: []}), {voiceId: '', voiceTitle: '', speed: 1})).toBeNull();
  });
});

describe('reviewScriptProposal', () => {
  const toCuts = (p: ScriptPlan) => scriptPlanToCuts(p, buildCtx);

  it('台本が同じで E が無ければ書き込める', () => {
    const r = reviewScriptProposal(proposal(), {scriptText: SCRIPT, check: check(), toCuts});
    expect(r.canApply).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r).toMatchObject({cutCount: 2, narrationCount: 1, totalSec: 6});
    expect(r.lines.join('\n')).toContain('【0〜3秒】フック');
  });

  it('案を作ったあとに台本を直したら書き込めない', () => {
    const r = reviewScriptProposal(proposal(), {scriptText: SCRIPT + '\n【6〜9秒】締め\n', check: check(), toCuts});
    expect(r.canApply).toBe(false);
    expect(r.blockers[0]).toContain('台本');
  });

  it('いまの素材で検算し直す（あとから NG にした素材が入っていれば書き込めない）', () => {
    const r = reviewScriptProposal(proposal(), {scriptText: SCRIPT, check: {...check(), ngClipIds: new Set(['02'])}, toCuts});
    expect(r.canApply).toBe(false);
    expect(r.issues.some((i) => i.code === 'SCRIPT_NG_CLIP')).toBe(true);
  });

  it('機械的に直せる E は直してから検算する（自動修正の前に作った案でも、承認すれば書ける）', () => {
    // 締めのナレーションが動画尺（6 秒）より後ろ。以前はこれで「書き込めません」で止まっていた
    const old = proposal({plan: plan({narration: [{id: '01_hook', at: 0.2, text: 'これ、いくらに見えますか？'}, {id: '02_close', at: 8, text: '締め'}]})});
    const r = reviewScriptProposal(old, {scriptText: SCRIPT, check: check(), toCuts});
    expect(r.canApply).toBe(true);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes[0]).toContain('02_close');
    expect(r.plan.narration[1].at).toBeLessThanOrEqual(6);
    expect(r.issues.some((i) => i.severity === 'E')).toBe(false);
    // 元の案は書き換えない（純粋）
    expect(old.plan.narration[1].at).toBe(8);
  });
});

describe('applyScriptProposal（案件フォルダ）', () => {
  const setup = (p: ScriptProposal | null) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reel-script-')), 't-reel');
    fs.mkdirSync(path.join(dir, '.studio'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'script.md'), SCRIPT);
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(makeCatalog('t-reel', clips())));
    fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard'})));
    if (p) fs.writeFileSync(scriptProposalPath(dir), JSON.stringify(p));
    return dir;
  };

  it('承認すると AI を走らせずに cuts.json と narration.json を書き、書き込み済みにする', () => {
    const dir = setup(proposal());
    const before = scriptProposalView(dir);
    expect(before).toMatchObject({canApply: true, current: {cuts: null, narration: null, sfx: 0}});
    expect(before?.appliedAt).toBeUndefined();

    const r = applyScriptProposal(dir);
    expect(r).toMatchObject({cuts: 2, narration: 1, totalSec: 6});
    const cuts = JSON.parse(fs.readFileSync(path.join(dir, 'cuts.json'), 'utf8'));
    expect(cuts.cuts).toHaveLength(2);
    const narration = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'));
    expect(narration.segments[0].needsTts).toBe(true);

    const after = scriptProposalView(dir);
    expect(after?.appliedAt).toBeTruthy();
    expect(after?.current).toEqual({cuts: 2, narration: 1, sfx: 0});
  });

  it('台本が変わっていたら何も書かない', () => {
    const dir = setup(proposal());
    fs.writeFileSync(path.join(dir, 'script.md'), SCRIPT + '\n【6〜9秒】締め\n');
    expect(() => applyScriptProposal(dir)).toThrow(/書き込めません/);
    expect(fs.existsSync(path.join(dir, 'cuts.json'))).toBe(false);
  });

  it('動画尺より後ろのナレーションがある古い案も、自動で直して書き、直したことを案に残す', () => {
    const dir = setup(proposal({plan: plan({narration: [{id: '01_hook', at: 0.2, text: 'これ、いくらに見えますか？'}, {id: '02_close', at: 8, text: '締め'}]})}));
    const before = scriptProposalView(dir);
    expect(before?.canApply).toBe(true);
    expect(before?.autoFixes).toHaveLength(1);
    expect(before?.autoFixes[0]).toContain('02_close');

    const lines: string[] = [];
    const r = applyScriptProposal(dir, {onLine: (l) => lines.push(l)});
    expect(r.fixes).toHaveLength(1);
    expect(lines.some((l) => l.includes('自動修正'))).toBe(true);
    const narration = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'));
    expect(narration.segments[1].at).toBeLessThanOrEqual(6);

    // 書いたあとの案は直したあとのもの。もう一度見直しても同じ修正は出ない
    const after = scriptProposalView(dir);
    expect(after?.autoFixes).toHaveLength(1);
    expect(after?.appliedAt).toBeTruthy();
  });

  it('案が無ければ「先に見るだけ」と案内する', () => {
    const dir = setup(null);
    expect(scriptProposalView(dir)).toBeNull();
    expect(() => applyScriptProposal(dir)).toThrow(/割り当てを見るだけ/);
  });
});
