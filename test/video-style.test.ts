import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureStyleCuts, videoStylePrompt, renderVideoStyleSkill, type VideoStyleDraft} from '../shared/video-style';
import {BriefSchema} from '../shared/schema/brief';
import {makeBrief, makeCatalog, makeClip} from './helpers';
import {saveVideoStyle, readVideoStyle, listVideoStyles, draftVideoStyle, videoStylesDir} from '../core/video-style';
import {aiScriptDraft} from '../core/script-draft';

vi.mock('../core/agent', () => ({runAgent: vi.fn()}));
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));
import {runAgent} from '../core/agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-video-style-'));
const homeBefore = process.env.REEL_STUDIO_HOME;
const workBefore = process.env.REEL_STUDIO_WORK_DIR;
process.env.REEL_STUDIO_HOME = path.join(tmp, 'settings');
process.env.REEL_STUDIO_WORK_DIR = path.join(tmp, 'work');
const clip = makeClip({id: '01', slug: 'plate', dur: 10, kind: 'serving', angle: 'close', subject: '看板料理'});
const catalog = makeCatalog('original-reel', [clip]);
const cuts = {fps: 30, cuts: [
  {id: 'c1', src: clip.src, inSec: 0, outSec: 2, playbackRate: 2, main: {text: 'この盛りすぎた一皿'}},
  {id: 'c2', src: 'uploads/alias.mov', inSec: 2, outSec: 5, main: {text: '焼肉の決定版'}},
], meta: {aliases: [{from: clip.src, to: 'uploads/alias.mov', applied: true}], slots: [
  {cutId: 'c1', clipId: '01', segment: 'first', role: 'hook' as const, textStatus: 'final' as const, locked: false, qc: []},
  {cutId: 'c2', clipId: '01', segment: 'proof', role: 'proof' as const, textStatus: 'final' as const, locked: false, qc: []},
]}};
const rules = {hook: '{看板商品}の驚きから始める', words: '短い体言止めで食感を伝える', cutting: '冒頭1秒、証明3秒の強弱を残す', sequence: 'フック→証明→店情報', telop: 'テロップを短く、声で補う', ending: '体験への誘いで締める'};
const draft: VideoStyleDraft = {
  label: '驚きから証明へ', summary: '短いフックの後に見せ場をゆっくり見せる', rules,
  source: {slug: 'original-reel', shop: '元の焼肉店', capturedAt: '2026-10-09T00:00:00.000Z'},
  referenceCuts: captureStyleCuts(cuts, catalog, {voice: '', segments: [{id: 'n1', at: 1, text: '肉汁があふれる'}]}), instruction: '',
};
const write = (dir: string, name: string, data: unknown) => {fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, name), JSON.stringify(data));};
beforeEach(() => {vi.clearAllMocks(); vi.mocked(runAgent).mockReset();});
afterEach(() => {fs.rmSync(path.join(tmp, 'settings'), {recursive: true, force: true});});
afterAll(() => {
  if (homeBefore === undefined) delete process.env.REEL_STUDIO_HOME; else process.env.REEL_STUDIO_HOME = homeBefore;
  if (workBefore === undefined) delete process.env.REEL_STUDIO_WORK_DIR; else process.env.REEL_STUDIO_WORK_DIR = workBefore;
  fs.rmSync(tmp, {recursive: true, force: true});
});

describe('過去案件から育てる型', () => {
  it('再生速度を含む尺・カット順・別名素材のタグ・声の位置を記録し素材パスは持ち出さない', () => {
    expect(draft.referenceCuts.map((c) => c.durationSec)).toEqual([1, 3]);
    expect(draft.referenceCuts[0].playbackRate).toBe(2);
    expect(draft.referenceCuts[1]).toMatchObject({role: 'proof', kind: 'serving', angle: 'close', narration: '肉汁があふれる'});
    expect(JSON.stringify(draft.referenceCuts)).not.toContain('uploads/');
    expect(() => captureStyleCuts({fps: 30, cuts: [{src: 'bad', inSec: 3, outSec: 1}]}, null, null)).toThrow('尺が不正');
  });

  it('改善の履歴とスキルを永続化し、別案件が使用中の旧版を変えない', () => {
    const v1 = saveVideoStyle(draft);
    const target = BriefSchema.parse(makeBrief({persona: 'standard', videoStyle: v1}));
    const v2 = saveVideoStyle({...draft, rules: {...rules, words: '過剰な断言を避ける'}, instruction: '過剰な断言を避けて'}, {id: v1.id, expectedRevision: 1});
    expect(readVideoStyle(v1.id)?.revisions).toHaveLength(2);
    expect(v2.revision).toBe(2);
    expect(target.videoStyle?.revision).toBe(1);
    expect(target.videoStyle?.rules.words).toBe(rules.words);
    expect(listVideoStyles()).toHaveLength(1);
    const skill = fs.readFileSync(path.join(videoStylesDir(), v1.id, 'SKILL.md'), 'utf8');
    expect(skill).toBe(renderVideoStyleSkill(v2));
    expect(skill).toContain('name: reel-style-');
    expect(skill).toContain('過剰な断言を避ける');
    expect(() => saveVideoStyle(draft, {id: v1.id, expectedRevision: 1})).toThrow('別の画面');
    expect(readVideoStyle(v1.id)?.revisions).toHaveLength(2);
    const separate = saveVideoStyle(draft);
    expect(separate.id).not.toBe(v1.id);
  });

  it('不正なIDや破損した履歴を空の記憶として上書きしない', () => {
    expect(() => readVideoStyle('../settings')).toThrow();
    const saved = saveVideoStyle(draft);
    const file = path.join(videoStylesDir(), saved.id, 'style.json');
    fs.writeFileSync(file, '{broken');
    expect(() => saveVideoStyle(draft, {id: saved.id, expectedRevision: 1})).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('元案件の保存済み編集から抽出し、AIの返答だけでは記憶を確定しない', async () => {
    const dir = path.join(tmp, 'work', 'original-reel');
    write(dir, 'cuts.json', cuts); write(dir, 'catalog.json', catalog); write(dir, 'brief.json', makeBrief({persona: 'standard'}));
    vi.mocked(runAgent).mockResolvedValueOnce({data: {label: draft.label, summary: draft.summary, rules}, costUsd: 0.01} as any);
    const result = await draftVideoStyle('original-reel', {});
    expect(result.draft.referenceCuts.map((c) => c.durationSec)).toEqual([1, 3]);
    expect(result.draft.source.slug).toBe('original-reel');
    expect(listVideoStyles()).toEqual([]);
    const saved = saveVideoStyle(result.draft);
    vi.mocked(runAgent).mockResolvedValueOnce({data: {label: draft.label, summary: draft.summary, rules: {...rules, ending: '余韻の画で締める'}}, costUsd: 0.01} as any);
    const refined = await draftVideoStyle('original-reel', {base: saved, instruction: '余韻で終える'});
    expect(refined.baseRevision).toBe(1);
    expect(refined.draft.rules.ending).toBe('余韻の画で締める');
    expect(refined.draft.referenceCuts).toEqual(saved.referenceCuts);
    expect(readVideoStyle(saved.id)?.revisions).toHaveLength(1);
  });

  it('別ジャンルの台本生成へ選んだ版と元の尺・順番を渡し、既定の均一テンポを指示しない', async () => {
    const style = saveVideoStyle(draft);
    const dir = path.join(tmp, 'work', 'cafe-reel');
    const cafe = makeClip({id: '02', slug: 'cake', dur: 8, kind: 'eating', subject: 'ケーキ'});
    write(dir, 'catalog.json', makeCatalog('cafe-reel', [cafe]));
    write(dir, 'brief.json', makeBrief({persona: 'standard', targetSec: 4, shop: {name: 'コピー先カフェ', area: '神戸', genre: 'カフェ', pr: false}, videoStyle: style}));
    vi.mocked(runAgent).mockResolvedValueOnce({data: {sections: [{fromSec: 0, toSec: 4, label: 'フックと証明', video: 'ケーキの断面 id 02', cutCount: 2, cutSec: '1→3', telop: 'この断面がたまらない', narration: '', why: '強弱を写す'}], notes: '型のテンポをケーキの断面へ適用', unmatched: []}, costUsd: 0.01} as any);
    const result = await aiScriptDraft(dir, {request: 'この型をカフェへ適用'});
    const prompt = vi.mocked(runAgent).mock.calls[0][0].prompt;
    expect(prompt).toContain('コピー先カフェ');
    expect(prompt).toContain(videoStylePrompt(style));
    expect(prompt).not.toContain('1 カット 0.7〜0.8 秒');
    expect(result.script).toContain('ケーキの断面');
    expect(fs.readFileSync(path.join(dir, 'script.md'), 'utf8')).toBe(result.script);
    expect(result.script).not.toContain('元の焼肉店');
  });
});
