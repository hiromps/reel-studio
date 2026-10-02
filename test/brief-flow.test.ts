// Brief の「作り方の流れ」：工程の済み／いまの判定と、作り方の推奨。初めての人の道しるべなので順序を固定しておく。
import {describe, expect, it} from 'vitest';
import {briefFlowOf, personaEffects, recommendRoute, ROUTE_INFO, ROUTE_ORDER, isBriefRoute, type FlowSnapshot} from '../src/components/briefSteps';
import type {Brief, Catalog, Clip, ClipTags, Narration, ReelData} from '../shared/schema';
import {makePersona} from './helpers';

const tags = (): ClipTags => ({kind: 'eating', signage: false, signageSize: 'none', angle: 'mid', motion: 'handheld', sizzleScore: 3, quality: 3, hasSpeech: false, subject: '', description: '', source: 'claude', taggedAt: '2026-09-10T00:00:00.000Z'});
const clip = (id: string, o: {tagged?: boolean} = {}): Clip =>
  ({id, original: `${id}.mov`, slug: id, src: `uploads/${id}.mov`, probe: {codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: 30, durationSec: 5, hasAudio: true, pixFmt: 'yuv420p'}, thumbs: {sheet: '', strip: []}, usableRanges: [], user: {hook: false, ng: false, orderHint: null, lock: false}, ...(o.tagged === false ? {} : {tags: tags()})}) as Clip;
const catalogOf = (clips: Clip[]): Catalog => ({version: 1, slug: 's', materialsDir: 'd', dominantFps: 30, createdAt: '', updatedAt: '', facts: [], clips}) as Catalog;
const briefOf = (name = 'テスト食堂'): Brief => ({version: 1, persona: 'standard', shop: {name, area: 'y', genre: '', pr: false}, materialMode: 'raw', format: 'F0', savePriorities: [], ngClipIds: []}) as unknown as Brief;
const cutsOf = (texts: string[]): ReelData => ({version: 1, fps: 30, cuts: texts.map((t, i) => ({id: `c${i}`, src: 'uploads/a.mov', inSec: 0, outSec: 1, main: {text: t}}))}) as unknown as ReelData;
const narrationOf = (n: number): Narration => ({version: 1, segments: Array.from({length: n}, (_, i) => ({id: `n${i}`, text: 'x', at: 0}))}) as unknown as Narration;

const base = (over: Partial<FlowSnapshot> = {}): FlowSnapshot => ({
  catalog: catalogOf([clip('01'), clip('02')]),
  brief: briefOf(),
  briefDirty: false,
  cuts: null,
  narration: null,
  hasScript: false,
  referencePresent: false,
  referenceAnalyzed: false,
  finalOut: false,
  ...over,
});

const statuses = (steps: ReturnType<typeof briefFlowOf>) => steps.map((s) => `${s.id}:${s.status}`);

describe('recommendRoute', () => {
  it('参考動画 > 台本 > 型 の順で勧める', () => {
    expect(recommendRoute({hasScript: false, referencePresent: false, referenceAnalyzed: false})).toBe('plan');
    expect(recommendRoute({hasScript: true, referencePresent: false, referenceAnalyzed: false})).toBe('script');
    expect(recommendRoute({hasScript: true, referencePresent: true, referenceAnalyzed: false})).toBe('reference');
    expect(recommendRoute({hasScript: false, referencePresent: true, referenceAnalyzed: true})).toBe('reference');
  });

  it('3 つの作り方には説明とスクロール先が揃っている', () => {
    for (const id of ROUTE_ORDER) {
      const r = ROUTE_INFO[id];
      expect(r.id).toBe(id);
      for (const k of ['title', 'when', 'makes', 'then', 'tour'] as const) expect(r[k]).not.toBe('');
    }
    expect(isBriefRoute('plan')).toBe(true);
    expect(isBriefRoute('')).toBe(false);
    expect(isBriefRoute('nope')).toBe(false);
  });
});

describe('briefFlowOf', () => {
  it('素材が無ければ最初の工程が「いま」', () => {
    const steps = briefFlowOf(base({catalog: null, brief: null}), 'plan');
    expect(statuses(steps)).toEqual(['materials:now', 'brief:todo', 'build:todo', 'telop:todo', 'narration:todo', 'finish:todo']);
    expect(steps[0].detail).toContain('カタログ実行');
    expect(steps[0].action).toEqual({label: 'Materials へ', tab: 'materials'});
  });

  it('タグが残っていれば本数を出し、素材の工程は未完了', () => {
    const steps = briefFlowOf(base({catalog: catalogOf([clip('01'), clip('02', {tagged: false})])}), 'plan');
    expect(steps[0].status).toBe('now');
    expect(steps[0].detail).toContain('1 本');
  });

  it('Brief は店名入りで保存されていないと「いま」。未保存は保存を促す', () => {
    expect(statuses(briefFlowOf(base({brief: briefOf('')}), 'plan'))[1]).toBe('brief:now');
    const dirty = briefFlowOf(base({briefDirty: true}), 'plan');
    expect(dirty[1].status).toBe('now');
    expect(dirty[1].detail).toContain('未保存');
    expect(dirty[1].action?.tour).toBe('brief-form');
  });

  it('構成の工程は選んだ作り方の名前とスクロール先を持つ', () => {
    for (const route of ROUTE_ORDER) {
      const steps = briefFlowOf(base(), route);
      expect(steps[2].status).toBe('now');
      expect(steps[2].label).toContain(ROUTE_INFO[route].title);
      expect(steps[2].action).toEqual({label: `${ROUTE_INFO[route].title} へ`, tab: 'brief', tour: ROUTE_INFO[route].tour});
    }
    // 型に流し込むときだけ、冒頭フックの選択を促す
    expect(briefFlowOf(base(), 'plan')[2].detail).toContain('冒頭フック');
    expect(briefFlowOf(base(), 'script')[2].detail).not.toContain('冒頭フック');
  });

  it('型に流し込んだ直後は仮置きのテロップが残るので、テロップの工程が「いま」になり件数を出す', () => {
    const steps = briefFlowOf(base({cuts: cutsOf(['{{g01:hook}}', '{{g02:proof}}', '確定'])}), 'plan');
    expect(statuses(steps)).toEqual(['materials:done', 'brief:done', 'build:done', 'telop:now', 'narration:todo', 'finish:todo']);
    expect(steps[3].detail).toContain('2 件');
    expect(steps[3].detail).toContain('Claude に頼む');
  });

  it('台本から組み立てた場合はテロップとナレーションが揃って入るので、次は仕上げ', () => {
    const steps = briefFlowOf(base({hasScript: true, cuts: cutsOf(['地元の9割が知らない', '一度は行っとこ']), narration: narrationOf(2)}), 'script');
    expect(statuses(steps)).toEqual(['materials:done', 'brief:done', 'build:done', 'telop:done', 'narration:done', 'finish:now']);
    expect(steps[3].detail).toContain('台本のテロップ');
    expect(steps[5].action?.tab).toBe('render');
  });

  it('本番レンダーがあれば全部済み（「いま」は無い）', () => {
    const steps = briefFlowOf(base({cuts: cutsOf(['a']), narration: narrationOf(1), finalOut: true}), 'reference');
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('途中が飛んでいても「いま」は最初の未完了 1 つだけ', () => {
    // ナレーションはあるのにテロップが仮置きのまま
    const steps = briefFlowOf(base({cuts: cutsOf(['{{g01:hook}}']), narration: narrationOf(1)}), 'plan');
    expect(statuses(steps)).toEqual(['materials:done', 'brief:done', 'build:done', 'telop:now', 'narration:done', 'finish:todo']);
    expect(steps.filter((s) => s.status === 'now')).toHaveLength(1);
  });
});

describe('personaEffects', () => {
  it('文体・締め・フックの型・既定の型・ボイスの効き先を 1 行ずつ出す', () => {
    const p = makePersona({id: 'x', label: 'X', tone: '標準語', cta: ['行ってみて'], ctaPatterns: ['行ってみて'], hookStyle: 'areaDigit', defaultFormat: 'F7', narrationRules: ['語尾に「〜わ」を使わない'], narration: {voiceId: '', voiceTitle: '', speed: 1.2, charsPerSec: 8, charsPerSecMeasured: 8}});
    const lines = personaEffects(p);
    expect(lines[0]).toContain('標準語');
    expect(lines[1]).toContain('行ってみて');
    expect(lines[2]).toContain('エリア名＋一桁数字');
    expect(lines[3]).toContain('F7');
    expect(lines.join('\n')).toContain('禁則 1 条');
    expect(lines[lines.length - 1]).toContain('ボイス未設定');
    const voiced = personaEffects(makePersona({id: 'y', label: 'Y', narration: {voiceId: 'a'.repeat(32), voiceTitle: 'yui', speed: 1.2, charsPerSec: 8, charsPerSecMeasured: 8}}));
    expect(voiced[voiced.length - 1]).toContain('yui');
  });
});
