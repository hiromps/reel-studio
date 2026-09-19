// 仕上げパイプラインの段取り（何が済んでいて何を走らせるか）。
import {describe, expect, it} from 'vitest';
import {buildSelectionIssues, defaultBuildSelection, orderBuildSteps, planBuild, type BuildFacts} from '../shared/build';
import {pushSnapshot, redoSnapshot, undoSnapshot} from '../src/hooks/undoStack';

const facts = (over: Partial<BuildFacts> = {}): BuildFacts => ({
  hasCuts: true,
  cutCount: 12,
  placeholders: 0,
  validationErrors: 0,
  fatalErrors: 0,
  hasNarration: false,
  segments: 0,
  needsTts: 0,
  hasFinal: false,
  finalStale: false,
  hasMixed: false,
  hasCaption: false,
  ttsAvailable: true,
  claudeAvailable: true,
  ...over,
});

const statusOf = (f: BuildFacts) => Object.fromEntries(planBuild(f).map((s) => [s.id, s.status]));

describe('planBuild', () => {
  it('まっさら（cuts だけ）なら全部 todo', () => {
    expect(statusOf(facts())).toEqual({caption: 'todo', narration: 'todo', tts: 'todo', render: 'todo', mix: 'todo', deliver: 'todo'});
    expect(defaultBuildSelection(planBuild(facts()))).toEqual(['caption', 'narration', 'tts', 'render', 'mix', 'deliver']);
  });

  it('全部済んでいれば納品だけ', () => {
    const f = facts({hasNarration: true, segments: 10, needsTts: 0, hasFinal: true, hasMixed: true, hasCaption: true});
    expect(statusOf(f)).toEqual({caption: 'done', narration: 'done', tts: 'done', render: 'done', mix: 'done', deliver: 'todo'});
    expect(defaultBuildSelection(planBuild(f))).toEqual(['deliver']);
  });

  it('cuts を直したら render・mix・deliver をやり直す', () => {
    const f = facts({hasNarration: true, segments: 10, hasFinal: true, finalStale: true, hasMixed: true, hasCaption: true});
    const s = statusOf(f);
    expect(s.render).toBe('todo');
    expect(s.mix).toBe('todo');
    expect(defaultBuildSelection(planBuild(f))).toEqual(['render', 'mix', 'deliver']);
  });

  it('素材の中身を差し替えた（顔モザイク）ら、cuts.json が同じでもレンダーし直す', () => {
    const f = facts({hasNarration: true, segments: 10, hasFinal: true, finalStale: true, finalStaleBy: 'media', hasMixed: true, hasCaption: true});
    const render = planBuild(f).find((s) => s.id === 'render');
    expect(render?.status).toBe('todo');
    expect(render?.detail).toContain('顔モザイク');
    expect(defaultBuildSelection(planBuild(f))).toEqual(['render', 'mix', 'deliver']);
  });

  it('原稿を直して音声が古ければ tts と mix', () => {
    const f = facts({hasNarration: true, segments: 10, needsTts: 2, hasFinal: true, hasMixed: true, hasCaption: true, mixStaleReason: '音声を作り直したあと mix していない'});
    expect(defaultBuildSelection(planBuild(f))).toEqual(['tts', 'mix', 'deliver']);
    expect(planBuild(f).find((s) => s.id === 'mix')?.detail).toContain('mix していない');
  });

  it('テロップ未記入なら原稿は blocked、render は todo のまま（承知で通せる）', () => {
    const s = planBuild(facts({placeholders: 3}));
    expect(s.find((x) => x.id === 'narration')?.status).toBe('blocked');
    expect(s.find((x) => x.id === 'render')?.status).toBe('todo');
    expect(s.find((x) => x.id === 'tts')?.status).toBe('blocked');
  });

  it('鍵や CLI が無ければ blocked', () => {
    expect(statusOf(facts({ttsAvailable: false})).tts).toBe('blocked');
    expect(statusOf(facts({claudeAvailable: false})).narration).toBe('blocked');
    expect(statusOf(facts({claudeAvailable: false})).caption).toBe('blocked');
    // 原稿がもうあれば CLI 無しでも tts は走らせられる
    expect(statusOf(facts({claudeAvailable: false, hasNarration: true, segments: 3, needsTts: 3})).tts).toBe('todo');
  });

  it('致命的な E があれば render 以降は blocked', () => {
    const s = statusOf(facts({fatalErrors: 1}));
    expect(s.render).toBe('blocked');
    expect(s.mix).toBe('blocked');
    expect(s.deliver).toBe('blocked');
  });

  it('cuts が無ければ AI 工程も blocked', () => {
    const s = statusOf(facts({hasCuts: false, cutCount: 0}));
    expect(s.caption).toBe('blocked');
    expect(s.narration).toBe('blocked');
  });
});

describe('buildSelectionIssues', () => {
  it('前提の工程を選んでいないと指摘する', () => {
    const steps = planBuild(facts());
    expect(buildSelectionIssues(steps, ['mix'])).toEqual(expect.arrayContaining([expect.stringContaining('本番レンダー'), expect.stringContaining('音声を生成')]));
    expect(buildSelectionIssues(steps, ['narration', 'tts', 'render', 'mix', 'deliver'])).toEqual([]);
  });
  it('前提が済んでいれば指摘しない', () => {
    const steps = planBuild(facts({hasNarration: true, segments: 5, hasFinal: true}));
    expect(buildSelectionIssues(steps, ['mix', 'deliver'])).toEqual([]);
  });
  it('blocked を選ぶと理由を出す', () => {
    const steps = planBuild(facts({ttsAvailable: false}));
    expect(buildSelectionIssues(steps, ['tts']).join('\n')).toContain('FISH_API_KEY');
  });
  it('実行順に並べ直す', () => {
    expect(orderBuildSteps(['deliver', 'tts', 'narration'])).toEqual(['narration', 'tts', 'deliver']);
  });
});

describe('undoStack', () => {
  it('push → undo → redo', () => {
    let s = pushSnapshot<string>({past: [], future: []}, 'a');
    s = pushSnapshot(s, 'b');
    const u1 = undoSnapshot(s, 'c');
    expect(u1.snapshot).toBe('b');
    const u2 = undoSnapshot(u1.stack, 'b');
    expect(u2.snapshot).toBe('a');
    expect(undoSnapshot(u2.stack, 'a').snapshot).toBeNull();
    const r = redoSnapshot(u2.stack, 'a');
    expect(r.snapshot).toBe('b');
    expect(redoSnapshot(r.stack, 'b').snapshot).toBe('c');
  });
  it('上限を超えたら古いものから落ちる。push でやり直し履歴は消える', () => {
    let s = {past: [] as string[], future: [] as string[]};
    for (const x of ['a', 'b', 'c', 'd']) s = pushSnapshot(s, x, 3);
    expect(s.past).toEqual(['b', 'c', 'd']);
    const u = undoSnapshot(s, 'e');
    expect(u.stack.future).toEqual(['e']);
    expect(pushSnapshot(u.stack, 'f').future).toEqual([]);
  });
});
