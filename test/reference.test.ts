// バズ動画の型を写す：分析結果のまとめ・検算・台本の書き出し（shared/reference.ts）と、
// 案件フォルダへの取り込み・複製・取り消し（core/reference.ts）。ffmpeg があれば実際の動画で材料作りも確かめる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  attachCutsToSegments,
  checkMimicPlan,
  cutBoundaries,
  describeReference,
  emptyReference,
  fitMimicToReference,
  fmtSec,
  isReferenceAnalyzed,
  isReferencePresent,
  mergeAnalysis,
  referenceStats,
  ReferenceSchema,
  renderMimicScript,
  sheetCount,
  sheetSpan,
  sheetTileOf,
  speechCoverage,
  tempoStats,
  type MimicPlan,
  type Reference,
} from '@shared/reference';
import {parseSections} from '@shared/script';
import {copyReferenceFrom, deleteReference, importReferenceVideo, prepareReferenceFrames, readReference, referenceStudioDir, writeReference} from '../core/reference';
import {exec} from '../core/exec';

const source = (): NonNullable<Reference['source']> => ({file: 'reference/source.mp4', originalName: 'buzz.mp4', durationSec: 12, fps: 30, width: 1080, height: 1920, hasAudio: true, importedAt: '2026-09-22T00:00:00.000Z'});

/** 12 秒・6 カット・3 区間の分析済み参考動画 */
const analyzed = (): Reference =>
  ReferenceSchema.parse({
    version: 1,
    source: source(),
    analyzedAt: '2026-09-22T01:00:00.000Z',
    model: 'opus',
    costUsd: 1.2,
    sceneCuts: [1, 2.5, 5, 8, 10],
    speech: [
      {startSec: 0.2, endSec: 2.2},
      {startSec: 5.5, endSec: 9.5},
    ],
    cuts: [
      {index: 1, startSec: 0, endSec: 1, telop: '生野区で9割が知らない', shot: {kind: 'sizzle', angle: 'close', subject: '肉'}, role: 'hook'},
      {index: 2, startSec: 1, endSec: 2.5, telop: '生野区で9割が知らない', shot: {kind: 'eating', angle: 'mid', subject: '肉'}, role: 'hook'},
      {index: 3, startSec: 2.5, endSec: 5, telop: '焼肉たべる', badge: '生野区', shot: {kind: 'signage', angle: 'wide', subject: '看板'}, role: 'reveal'},
      {index: 4, startSec: 5, endSec: 8, telop: '駅から徒歩3分', shot: {kind: 'exterior', angle: 'wide', subject: '外観'}, role: 'info'},
      {index: 5, startSec: 8, endSec: 10, telop: '', shot: {kind: 'sizzle', angle: 'close', subject: '肉'}, role: 'sizzle'},
      {index: 6, startSec: 10, endSec: 12, telop: '一度は行っとこ', shot: {kind: 'serving', angle: 'mid', subject: '皿'}, role: 'cta'},
    ],
    segments: [
      {id: '1_hook', label: 'フック', fromSec: 0, toSec: 2.5, role: 'hook', purpose: '止めさせる', telopPattern: 'エリア＋数字で言い切る', cutCount: 2, cutIndices: [1, 2], narration: true},
      {id: '2_reveal', label: '店名リビール', fromSec: 2.5, toSec: 5, role: 'reveal', purpose: '正体を明かす', telopPattern: '店名', cutCount: 1, cutIndices: [3], narration: false},
      {id: '3_body', label: '本編と締め', fromSec: 5, toSec: 12, role: 'info', purpose: '保存させる', telopPattern: '実用情報の体言止め', cutCount: 3, cutIndices: [4, 5, 6], narration: true},
    ],
    pattern: {hookType: '数字で言い切る', hookText: '生野区で9割が知らない', revealSec: 2.5, revealStyle: '看板', ctaText: '一度は行っとこ', ctaStyle: '来店を促す言い切り', telopStyle: '10 文字前後・句点なし', tempoStyle: '前半 1 秒・後半 2〜3 秒', saveReasons: ['アクセス']},
    summary: '冒頭で地元民も知らないと言い切り、看板で正体を早く明かす',
    mimicRules: ['冒頭は料理の寄り 1 秒', '店名は 2.5 秒で看板と一緒に'],
  });

const plan = (over: Partial<MimicPlan> = {}): MimicPlan => ({
  sections: [
    {fromSec: 0, toSec: 2.5, label: 'フック', video: '肉の断面の寄り（id 01）→ 箸上げ', cutCount: 2, cutSec: '1.0〜1.5', telop: '地元の9割が素通りする', badge: '東大阪', narration: 'ひがしおおさかの人でも、ほとんど知らないお店です', why: 'エリア＋数字で言い切る型'},
    {fromSec: 2.5, toSec: 5, label: '店名リビール', video: '看板の引き（id 19）', cutCount: 1, cutSec: '2.5', telop: 'テスト食堂', badge: '', narration: '', why: '看板で明かす'},
    {fromSec: 5, toSec: 12, label: '本編と締め', video: '外観 → 実食 → 皿', cutCount: 3, cutSec: '2〜3', telop: '駅から徒歩5分', badge: '', narration: 'えきから あるいて ごふん、いちどは いっといて', why: '実用情報'},
  ],
  notes: '参考と同じ 3 区間',
  unmatched: [],
  ...over,
});

describe('cutBoundaries / tempoStats', () => {
  it('シーン検出の時刻から区間を作り、近すぎる境界は落とす', () => {
    const cuts = cutBoundaries([0.05, 1.0, 1.1, 2.5, 9.95], 10);
    expect(cuts).toEqual([
      {startSec: 0, endSec: 1},
      {startSec: 1, endSec: 2.5},
      {startSec: 2.5, endSec: 10},
    ]);
  });

  it('境界が無ければ全体で 1 カット。尺が無ければ空', () => {
    expect(cutBoundaries([], 4)).toEqual([{startSec: 0, endSec: 4}]);
    expect(cutBoundaries([1, 2], 0)).toEqual([]);
  });

  it('多すぎるときは間隔を広げてカット数を抑える', () => {
    const times = Array.from({length: 200}, (_, i) => (i + 1) * 0.5);
    const cuts = cutBoundaries(times, 101, {maxCuts: 50});
    expect(cuts.length).toBeLessThanOrEqual(50);
    expect(cuts[0].startSec).toBe(0);
    expect(cuts[cuts.length - 1].endSec).toBe(101);
  });

  it('テンポの統計', () => {
    const st = tempoStats(
      [
        {startSec: 0, endSec: 1},
        {startSec: 1, endSec: 3},
        {startSec: 3, endSec: 6},
      ],
      6,
    );
    expect(st).toEqual({count: 3, avgSec: 2, medianSec: 2, minSec: 1, maxSec: 3, cutsPer10Sec: 5});
    expect(tempoStats([])).toMatchObject({count: 0, avgSec: 0});
  });

  it('声の割合は尺に対する比率（重なりは尺で頭打ち）', () => {
    expect(speechCoverage([{startSec: 0, endSec: 5}], 10)).toBe(0.5);
    expect(speechCoverage([{startSec: 0, endSec: 50}], 10)).toBe(1);
    expect(speechCoverage([], 0)).toBe(0);
  });
});

describe('コンタクトシートの割り付け', () => {
  it('1 枚 = 12 コマ = 6 秒。枚数と範囲が合う', () => {
    expect(sheetCount(12)).toBe(3); // 25 コマ → 3 枚
    expect(sheetSpan(0)).toEqual({fromSec: 0, toSec: 5.5});
    expect(sheetSpan(1)).toEqual({fromSec: 6, toSec: 11.5});
  });

  it('秒 → シート・段・列', () => {
    expect(sheetTileOf(0)).toEqual({sheet: 0, row: 0, col: 0});
    expect(sheetTileOf(1.5)).toEqual({sheet: 0, row: 1, col: 0}); // 3 コマ目
    expect(sheetTileOf(6)).toEqual({sheet: 1, row: 0, col: 0});
  });
});

describe('attachCutsToSegments', () => {
  const cuts = [
    {startSec: 0, endSec: 1},
    {startSec: 1, endSec: 2.5},
    {startSec: 2.5, endSec: 5},
    {startSec: 5, endSec: 12.4}, // 末尾が区間からはみ出している
  ];
  const segs = analyzed().segments.map((s) => ({...s, cutIndices: [], cutCount: 0, narration: false}));

  it('中点で区間に入れ、はみ出したカットもいちばん近い区間に数える', () => {
    const r = attachCutsToSegments(segs, cuts, [{startSec: 0, endSec: 2}]);
    expect(r.map((s) => s.cutIndices)).toEqual([[1, 2], [3], [4]]);
    expect(r.map((s) => s.cutCount)).toEqual([2, 1, 1]);
    expect(r.map((s) => s.narration)).toEqual([true, false, false]);
  });
});

describe('mergeAnalysis', () => {
  it('AI の返答をシーン検出の秒数に重ね、区間を尺の中に収めて id を揃える', () => {
    const base = ReferenceSchema.parse({version: 1, source: source()});
    const prep = {sceneCuts: [2.5, 5], cuts: [{startSec: 0, endSec: 2.5}, {startSec: 2.5, endSec: 5}, {startSec: 5, endSec: 12}], frames: ['reference/frames/001.jpg', undefined, 'reference/frames/003.jpg'], sheets: ['reference/sheets/01.jpg'], speech: []};
    const res = {
      cuts: [
        {index: 1, telop: ' 生野区で9割が知らない ', orientation: 'vertical' as const, badge: '', kind: 'sizzle' as const, angle: 'close' as const, subject: '肉', description: '断面', role: 'hook' as const},
        {index: 9, telop: '一覧に無い番号', orientation: 'none' as const, badge: '', kind: 'other' as const, angle: 'mid' as const, subject: '', description: '', role: 'filler' as const},
      ],
      segments: [
        {id: '', label: '', fromSec: 5, toSec: 99, role: 'info' as const, purpose: '', telopPattern: '', notes: ''},
        {id: 'hook', label: 'フック', fromSec: 0, toSec: 5, role: 'hook' as const, purpose: '止める', telopPattern: '数字', notes: ''},
        {id: 'hook', label: '重複', fromSec: 5, toSec: 5.05, role: 'info' as const, purpose: '', telopPattern: '', notes: ''},
      ],
      pattern: {hookType: '数字', hookText: 'x', revealSec: -1, revealStyle: '', ctaText: '', ctaStyle: '', telopStyle: '', tempoStyle: '', saveReasons: [' アクセス ', ''], narrationStyle: ''},
      summary: ' 伸びる理由 ',
      mimicRules: ['a', ' ', 'b'],
    };
    const r = mergeAnalysis(base, prep, res, {model: 'sonnet', costUsd: 0.5, analyzedAt: '2026-09-22T02:00:00.000Z'});
    expect(r.cuts).toHaveLength(3);
    expect(r.cuts[0]).toMatchObject({index: 1, startSec: 0, endSec: 2.5, telop: '生野区で9割が知らない', role: 'hook', frame: 'reference/frames/001.jpg'});
    expect(r.cuts[1]).toMatchObject({index: 2, telop: '', role: 'filler', shot: {kind: 'other'}});
    expect(r.cuts[1].frame).toBeUndefined();
    // 尺の外は 12 で止め、0.1 秒未満の区間は落とし、空の id は並び順で付け直す（2 番目なので s2）
    expect(r.segments.map((s) => [s.id, s.fromSec, s.toSec])).toEqual([
      ['hook', 0, 5],
      ['s2', 5, 12],
    ]);
    expect(r.segments[0]).toMatchObject({cutCount: 2, cutIndices: [1, 2]});
    expect(r.pattern.revealSec).toBeNull();
    expect(r.pattern.saveReasons).toEqual(['アクセス']);
    expect(r.summary).toBe('伸びる理由');
    expect(r.mimicRules).toEqual(['a', 'b']);
    expect(r).toMatchObject({model: 'sonnet', costUsd: 0.5, analyzedAt: '2026-09-22T02:00:00.000Z', sheets: ['reference/sheets/01.jpg']});
    expect(isReferenceAnalyzed(r)).toBe(true);
  });
});

describe('fitMimicToReference / checkMimicPlan', () => {
  it('区間数が同じなら秒数を参考に強制し、カット数が 0 なら参考のものを入れる', () => {
    const p = plan({sections: plan().sections.map((s, i) => ({...s, fromSec: s.fromSec + 0.3, toSec: s.toSec + 0.3, cutCount: i === 0 ? 0 : s.cutCount}))});
    const r = fitMimicToReference(p, analyzed());
    expect(r.fitted).toBe(true);
    expect(r.plan.sections.map((s) => [s.fromSec, s.toSec, s.cutCount])).toEqual([
      [0, 2.5, 2],
      [2.5, 5, 1],
      [5, 12, 3],
    ]);
  });

  it('区間数が違えば合わせない（検算で E になる）', () => {
    const p = plan({sections: plan().sections.slice(0, 2)});
    expect(fitMimicToReference(p, analyzed()).fitted).toBe(false);
    const issues = checkMimicPlan(p, analyzed());
    expect(issues.some((i) => i.severity === 'E' && i.code === 'MIMIC_SECTION_COUNT')).toBe(true);
  });

  it('参考どおりなら E は無い', () => {
    expect(checkMimicPlan(plan(), analyzed()).filter((i) => i.severity === 'E')).toEqual([]);
  });

  it('秒数のずれ・テロップの流用・長さ・句点・声の欠け・カット数の違いを指摘する', () => {
    const p = plan({
      sections: [
        {...plan().sections[0], fromSec: 0, toSec: 3, telop: '生野区で9割が知らない。', cutCount: 5},
        {...plan().sections[1], telop: 'とても長いテロップの文言がここに入っています'},
        {...plan().sections[2], narration: ''},
      ],
    });
    const codes = checkMimicPlan(p, analyzed(), {maxTelopChars: 13}).map((i) => `${i.severity}:${i.code}`);
    expect(codes).toContain('E:MIMIC_SECTION_TIME');
    expect(codes).toContain('W:MIMIC_TELOP_COPIED');
    expect(codes).toContain('W:MIMIC_TELOP_PERIOD');
    expect(codes).toContain('W:MIMIC_CUTS_DIFFER');
    expect(codes).toContain('W:MIMIC_TELOP_LONG');
    expect(codes).toContain('W:MIMIC_NARRATION_MISSING');
  });

  it('区間が無ければ E', () => {
    expect(checkMimicPlan(plan({sections: []}), analyzed())[0]).toMatchObject({severity: 'E', code: 'MIMIC_NO_SECTIONS'});
  });
});

describe('renderMimicScript', () => {
  it('「台本から組み立てる」が読める見出しで、区間の秒数が小数のまま残る', () => {
    const text = renderMimicScript(plan(), analyzed(), {shopName: 'テスト食堂'});
    const sections = parseSections(text);
    expect(sections.map((s) => [s.fromSec, s.toSec, s.label])).toEqual([
      [0, 2.5, 'フック'],
      [2.5, 5, '店名リビール'],
      [5, 12, '本編と締め'],
    ]);
    expect(text).toContain('# 参考動画の型を写した台本（テスト食堂）');
    expect(text).toContain('映像： 肉の断面の寄り（id 01）→ 箸上げ');
    expect(text).toContain('カット割り： 2 カット（1 カット 1.0〜1.5 秒）');
    expect(text).toContain('テロップ： 地元の9割が素通りする');
    expect(text).toContain('バッジ： 東大阪');
    expect(text).toContain('ナレーション： ひがしおおさかの人でも、ほとんど知らないお店です');
    expect(text).toContain('狙い： 看板で明かす');
    // 参考動画の文言そのものは台本に入れない（先頭のコメントは型の説明だけ）
    expect(text).not.toContain('生野区で9割が知らない');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('横書き・撮り足しの候補・空のテロップも書く', () => {
    const text = renderMimicScript(plan({sections: [{...plan().sections[0], orientation: 'horizontal', telop: ''}], unmatched: ['湯気の寄り']}), analyzed());
    expect(text).toContain('テロップの向き： 横書き');
    expect(text).toContain('テロップ： \n');
    expect(text).toContain('# - 湯気の寄り');
  });
});

describe('parseSections の小数', () => {
  it('【2.5〜6.2秒】や 0:03.5 を読める', () => {
    const s = parseSections('【2.5〜6.2秒】本編\n【0:03.5〜0:10秒】締め\n【0〜3秒】従来');
    expect(s.map((x) => [x.fromSec, x.toSec])).toEqual([
      [0, 3],
      [2.5, 6.2],
      [3.5, 10],
    ]);
  });
});

describe('describeReference / referenceStats / fmtSec', () => {
  it('分析済みなら型の要約と区間が出る', () => {
    const lines = describeReference(analyzed());
    expect(lines[0]).toContain('buzz.mp4（12 秒・6 カット・平均 2 秒/カット・声 50%）');
    expect(lines.join('\n')).toContain('フック: 数字で言い切る「生野区で9割が知らない」');
    expect(lines.join('\n')).toContain('0〜2.5秒 フック（hook） / 2 カット（1, 1.5 秒）');
    expect(lines.join('\n')).toContain('写すときの規則:');
  });

  it('取り込んだだけなら「まだ分析していません」', () => {
    const r = ReferenceSchema.parse({version: 1, source: source()});
    expect(describeReference(r)[1]).toContain('まだ分析していません');
    expect(referenceStats(r)).toMatchObject({count: 1, durationSec: 12});
    expect(isReferenceAnalyzed(r)).toBe(false);
  });

  it('墓標は「無い」扱い', () => {
    expect(isReferencePresent(emptyReference())).toBe(false);
    expect(isReferencePresent(analyzed())).toBe(true);
    expect(isReferencePresent(null)).toBe(false);
    expect(describeReference(emptyReference())[0]).toContain('取り込まれていません');
  });

  it('fmtSec は小数 1 桁、整数はそのまま', () => {
    expect(fmtSec(2)).toBe('2');
    expect(fmtSec(2.54)).toBe('2.5');
    expect(fmtSec(2.56)).toBe('2.6');
    expect(fmtSec(0.04)).toBe('0');
  });
});

// ───────────────────────── 案件フォルダ ─────────────────────────

describe('案件フォルダの取り込み・複製・取り消し（ffmpeg を使う）', () => {
  let root: string;
  let video: string | null = null;
  const project = (name: string) => {
    const dir = path.join(root, `${name}-reel`);
    fs.mkdirSync(path.join(dir, '.studio'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'brief.json'), '{}');
    return dir;
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-reference-'));
    // 4 秒・2 場面（色が切り替わる）・音声つきの動画を作る。ffmpeg が無ければこの describe の実動画テストは飛ばす
    const out = path.join(root, 'buzz.mp4');
    const r = await exec('ffmpeg', [
      '-y', '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=180x320:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
    ]).catch(() => null);
    if (r && r.code === 0 && fs.existsSync(out)) video = out;
  }, 120_000);
  afterAll(() => fs.rmSync(root, {recursive: true, force: true}));

  it('動画でないもの・無いものは断る', async () => {
    const dir = project('a');
    const txt = path.join(root, 'memo.txt');
    fs.writeFileSync(txt, 'x');
    await expect(importReferenceVideo(dir, txt)).rejects.toThrow(/動画ファイルではありません/);
    await expect(importReferenceVideo(dir, path.join(root, 'none.mp4'))).rejects.toThrow(/見つかりません/);
    expect(readReference(dir)).toBeNull();
  });

  it('取り込むと .studio/reference/ に実体が入り、reference.json は source だけになる', async () => {
    if (!video) return;
    const dir = project('b');
    const r = await importReferenceVideo(dir, video);
    expect(r.source).toMatchObject({file: 'reference/source.mp4', originalName: 'buzz.mp4', hasAudio: true});
    expect(r.source!.durationSec).toBeGreaterThan(3.5);
    expect(fs.existsSync(path.join(referenceStudioDir(dir), 'source.mp4'))).toBe(true);
    expect(fs.existsSync(video)).toBe(true); // 元は消さない（move 指定なし）
    expect(readReference(dir)?.analyzedAt).toBeUndefined();
    expect(isReferenceAnalyzed(readReference(dir))).toBe(false);
  }, 60_000);

  it('材料作り：色が変わる 2 秒でカットが切れ、コマとコンタクトシートと声の区間ができる', async () => {
    if (!video) return;
    const dir = project('c');
    const ref = await importReferenceVideo(dir, video);
    const prep = await prepareReferenceFrames(dir, ref);
    expect(prep.cuts.length).toBeGreaterThanOrEqual(2);
    expect(prep.cuts[0].startSec).toBe(0);
    expect(Math.abs(prep.cuts[0].endSec - 2)).toBeLessThan(0.2);
    expect(prep.frames.length).toBe(prep.cuts.length);
    for (const f of prep.frames) expect(fs.existsSync(path.join(dir, '.studio', f!))).toBe(true);
    expect(prep.sheets.length).toBe(1); // 4 秒 = 9 コマ → 1 枚
    expect(fs.existsSync(path.join(dir, '.studio', prep.sheets[0]))).toBe(true);
    expect(prep.speech.length).toBeGreaterThan(0); // sine は無音ではない
  }, 120_000);

  it('別の案件から複製すると分析とコマが一緒に来る。取り消すと墓標が残り readReference は null', () => {
    const src = project('d');
    const dst = project('e');
    const framesDir = path.join(referenceStudioDir(src), 'frames');
    fs.mkdirSync(framesDir, {recursive: true});
    fs.writeFileSync(path.join(framesDir, '001.jpg'), 'jpg');
    writeReference(src, analyzed());
    const r = copyReferenceFrom(dst, src);
    expect(r.segments).toHaveLength(3);
    expect(readReference(dst)?.summary).toBe(analyzed().summary);
    expect(fs.existsSync(path.join(referenceStudioDir(dst), 'frames', '001.jpg'))).toBe(true);
    expect(() => copyReferenceFrom(dst, dst)).toThrow(/同じ案件/);
    expect(() => copyReferenceFrom(dst, project('f'))).toThrow(/分析がありません/);

    deleteReference(dst);
    expect(readReference(dst)).toBeNull();
    expect(fs.existsSync(referenceStudioDir(dst))).toBe(false);
    // ファイルは残っていて、中身は墓標（クラウドへ「消した」を伝えるため）
    const raw = JSON.parse(fs.readFileSync(path.join(dst, 'reference.json'), 'utf8'));
    expect(raw.source).toBeNull();
    expect(isReferencePresent(raw)).toBe(false);
  });
});
