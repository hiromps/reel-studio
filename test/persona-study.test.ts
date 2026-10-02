// 人格を分析済みの動画から作る：Instagram の投稿一覧の読み方・動画の選び方・下書き → Persona・プロンプト（shared/persona-study.ts）と、
// 置き場（core/persona-study.ts）。Smartgram にも claude にも繋がない（fetch は差し替える）。
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPersonaPrompt,
  DEFAULT_STUDY_VIDEOS,
  describePersonaDraft,
  isVideoPost,
  MAX_STUDY_VIDEOS,
  normalizeInstagramUser,
  PERSONA_DRAFT_SCHEMA,
  personaFromDraft,
  PersonaDraftSchema,
  PersonaStudySchema,
  pickInstagramPost,
  pickInstagramPosts,
  postsFetchCount,
  selectStudyPosts,
  studyFolderName,
  studyFromPost,
  usableSources,
  type InstagramPost,
  type PersonaDraft,
} from '@shared/persona-study';
import {ReferenceSchema, type Reference} from '@shared/reference';
import {JOB_TYPES, PROJECTLESS_JOBS, isHeavyJob} from '@shared/jobs';
import {InstagramMcpError, mcpToolJson} from '@shared/instagram-mcp';
import {generatePersona, listStudies, personaStudiesDir, readStudy, studyDir} from '../core/persona-study';
import {resetInstagramMcpEnv} from '../core/instagram-mcp';
import {resetSettings} from '../core/settings';
import {listPersonas} from '@shared/personas';
import {makePersona} from './helpers';

/** get_user_posts が実際に返す形（2026-10-02 に確認。URL は短くしてある） */
const rawPosts = () => ({
  posts: [
    {id: '1', code: 'Ddn8GJfvtiO', caption: '寿司食べ放題で話題の店に🦀\n\n頂いたもの🍽️\n・コース 8,500円\n\n———\n\n#心斎橋グルメ #海鮮居酒屋 #店名', mediaType: 'video', thumbnailUrl: 'https://cdn.example/t1.jpg', takenAt: '2026-09-23T09:00:05.000Z', likeCount: 316, commentCount: 2, username: 'oc.eat', fullName: 'おっしー', videoUrl: 'https://cdn.example/v1.mp4?sig=1'},
    {id: '2', code: 'Db2HgeRzPsN', caption: 'ファクトリーカフェ\n\n#久宝寺 #久宝寺グルメ #久宝寺カフェ #八尾グルメ', mediaType: 'video', thumbnailUrl: 'https://cdn.example/t2.jpg', takenAt: '2026-08-10T04:08:33.000Z', likeCount: 869, commentCount: 9, username: 'oc.eat', fullName: 'おっしー', videoUrl: 'https://cdn.example/v2.mp4'},
    {id: '3', code: 'Dphoto00001', caption: '写真の投稿', mediaType: 'image', thumbnailUrl: 'https://cdn.example/t3.jpg', takenAt: '2026-09-01T00:00:00.000Z', likeCount: 10, commentCount: 0, username: 'oc.eat', fullName: 'おっしー', videoUrl: null},
    {id: '4', code: 'Db2pEWLvprE', caption: '紅茶の店', mediaType: 'video', thumbnailUrl: null, takenAt: '2026-08-10T04:30:00.000Z', likeCount: 100, commentCount: 1, username: 'oc.eat', fullName: 'おっしー', videoUrl: 'https://cdn.example/v4.mp4'},
  ],
});

/** 分析済みの参考動画（reference.test.ts と同じ形） */
const analyzed = (over: Partial<Reference> = {}): Reference =>
  ReferenceSchema.parse({
    version: 1,
    source: {file: 'reference/source.mp4', originalName: 'buzz.mp4', durationSec: 12, fps: 30, width: 1080, height: 1920, hasAudio: true, importedAt: '2026-09-22T00:00:00.000Z'},
    analyzedAt: '2026-09-22T01:00:00.000Z',
    model: 'opus',
    costUsd: 1.2,
    sceneCuts: [2.5, 5],
    speech: [{startSec: 0.2, endSec: 2.2}],
    cuts: [
      {index: 1, startSec: 0, endSec: 2.5, telop: '生野区で9割が知らない', shot: {kind: 'sizzle', angle: 'close', subject: '肉'}, role: 'hook'},
      {index: 2, startSec: 2.5, endSec: 5, telop: '焼肉たべる', badge: '生野区', shot: {kind: 'signage', angle: 'wide', subject: '看板'}, role: 'reveal'},
      {index: 3, startSec: 5, endSec: 12, telop: '一度は行っとこ', shot: {kind: 'serving', angle: 'mid', subject: '皿'}, role: 'cta'},
    ],
    segments: [
      {id: '1_hook', label: 'フック', fromSec: 0, toSec: 2.5, role: 'hook', purpose: '止めさせる', telopPattern: 'エリア＋数字で言い切る', cutCount: 1, cutIndices: [1], narration: true},
      {id: '2_reveal', label: '店名リビール', fromSec: 2.5, toSec: 5, role: 'reveal', purpose: '正体を明かす', telopPattern: '店名', cutCount: 1, cutIndices: [2], narration: false},
      {id: '3_cta', label: '締め', fromSec: 5, toSec: 12, role: 'cta', purpose: '来店を促す', telopPattern: '言い切り', cutCount: 1, cutIndices: [3], narration: true},
    ],
    pattern: {hookType: '数字で言い切る', hookText: '生野区で9割が知らない', revealSec: 2.5, revealStyle: '看板', ctaText: '一度は行っとこ', ctaStyle: '来店を促す言い切り', telopStyle: '10 文字前後・句点なし', tempoStyle: '前半 1 秒・後半 2〜3 秒', saveReasons: ['アクセス']},
    summary: '冒頭で地元民も知らないと言い切る',
    mimicRules: ['冒頭は料理の寄り 1 秒'],
    ...over,
  });

const draft = (over: Partial<PersonaDraft> = {}): PersonaDraft =>
  PersonaDraftSchema.parse({
    label: 'おっしー風（関西・発見型）',
    tone: '関西弁控えめ・体言止めの短文',
    cta: ['一度は行っとこ', 'ぜひ行ってみて'],
    ctaPatterns: ['行っとこ', '行ってみて'],
    hookStyle: 'areaDigit',
    narrationRules: ['語尾に「〜わ」を使わない'],
    defaultFormat: 'F7',
    theme: 'human',
    allowEmptyReveal: true,
    captionGuide: '# キャプションの型\n\n1. フック 2 行',
    hashtagBank: '# ハッシュタグの選び方\n\nエリア → ジャンル → 店名',
    hashtags: 3,
    maxChars: 600,
    summary: '地元民も知らないと言い切って発見させる',
    evidence: ['動画 1 の締め「一度は行っとこ」'],
    ...over,
  });

describe('Instagram の投稿一覧（get_user_posts）の読み方', () => {
  it('posts 配列を読み、code・直リンク・キャプション・日時・いいね数を取り出す', () => {
    const posts = pickInstagramPosts(rawPosts());
    expect(posts.map((p) => p.code)).toEqual(['Ddn8GJfvtiO', 'Db2HgeRzPsN', 'Dphoto00001', 'Db2pEWLvprE']);
    expect(posts[0]).toMatchObject({url: 'https://www.instagram.com/reel/Ddn8GJfvtiO/', mediaType: 'video', likeCount: 316, commentCount: 2, username: 'oc.eat', videoUrl: 'https://cdn.example/v1.mp4?sig=1'});
    expect(posts[0].caption).toContain('#心斎橋グルメ');
    expect(posts[2].videoUrl).toBeNull();
    expect(posts[3].thumbnailUrl).toBeNull();
  });

  it('形が多少違っても拾う（items / snake_case / 数値の mediaType / 秒の taken_at）。読めないものは落とし、同じ code は 1 回', () => {
    const posts = pickInstagramPosts({items: [{shortcode: 'Cabc12345', caption: {text: 'x'}, media_type: 2, taken_at: 1758618005, like_count: '5', video_url: 'https://a/b.mp4', user: {username: 'shop'}}, {code: 'bad code'}, {shortcode: 'Cabc12345'}]});
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({code: 'Cabc12345', caption: 'x', mediaType: 'video', takenAt: '2025-09-23T09:00:05.000Z', likeCount: 5, videoUrl: 'https://a/b.mp4', username: 'shop'});
    expect(pickInstagramPosts(null)).toEqual([]);
    expect(pickInstagramPosts({posts: 'nope'})).toEqual([]);
    expect(pickInstagramPost('str')).toBeNull();
  });

  it('https でない直リンクは拾わない（javascript: 等）', () => {
    const p = pickInstagramPost({code: 'Cabc12345', videoUrl: 'javascript:alert(1)', thumbnailUrl: 'http://insecure/x.jpg'});
    expect(p?.videoUrl).toBeNull();
    expect(p?.thumbnailUrl).toBeNull();
    expect(p && isVideoPost(p)).toBe(false);
  });
});

describe('動画の選び方', () => {
  it('直リンクのある動画だけを新しい順に count 本', () => {
    const posts = pickInstagramPosts(rawPosts());
    expect(selectStudyPosts(posts, 2).map((p) => p.code)).toEqual(['Ddn8GJfvtiO', 'Db2pEWLvprE']);
    expect(selectStudyPosts(posts, 10).map((p) => p.code)).toEqual(['Ddn8GJfvtiO', 'Db2pEWLvprE', 'Db2HgeRzPsN']);
  });

  it('count は 1〜上限に丸め、0 や NaN は既定の本数', () => {
    const many: InstagramPost[] = Array.from({length: 30}, (_, i) => ({...pickInstagramPosts(rawPosts())[0], code: `C${String(i).padStart(9, '0')}`, takenAt: ''}));
    expect(selectStudyPosts(many, 99)).toHaveLength(MAX_STUDY_VIDEOS);
    expect(selectStudyPosts(many, 0)).toHaveLength(DEFAULT_STUDY_VIDEOS);
    expect(selectStudyPosts(many, Number.NaN)).toHaveLength(DEFAULT_STUDY_VIDEOS);
    // 日時が無いものは返ってきた順を保つ
    expect(selectStudyPosts(many, 3).map((p) => p.code)).toEqual(['C000000000', 'C000000001', 'C000000002']);
  });

  it('写真が混ざるので多めに取る（MCP の上限 50 まで）', () => {
    expect(postsFetchCount(6)).toBe(12);
    expect(postsFetchCount(1)).toBe(12);
    expect(postsFetchCount(20)).toBe(40);
    expect(postsFetchCount(30)).toBe(50);
  });

  it.each([
    ['oc.eat', 'oc.eat'],
    ['@oc.eat', 'oc.eat'],
    ['  @Shop_Name.1  ', 'Shop_Name.1'],
    ['https://www.instagram.com/oc.eat/', 'oc.eat'],
    ['https://instagram.com/oc.eat?igsh=xx', 'oc.eat'],
  ])('ユーザー名として読む: %s', (input, expected) => {
    expect(normalizeInstagramUser(input)).toBe(expected);
  });

  it.each(['', '@', 'has space', 'ユーザー', 'a'.repeat(31), 'https://www.tiktok.com/@a'])('読めないユーザー名: %s', (input) => {
    expect(normalizeInstagramUser(input)).toBeNull();
  });

  it('フォルダ名は code の英数字と _- だけ', () => {
    expect(studyFolderName('Ddn8GJfvtiO')).toBe('Ddn8GJfvtiO');
    expect(studyFolderName('../x/y')).toBe('___x_y');
    expect(studyFolderName('')).toBe('post');
  });
});

describe('study.json', () => {
  it('投稿から記録を作り、スキーマを通る', () => {
    const p = pickInstagramPosts(rawPosts())[0];
    const s = studyFromPost('oc.eat', p, '2026-10-02T00:00:00.000Z');
    expect(s).toMatchObject({version: 1, target: 'oc.eat', code: 'Ddn8GJfvtiO', url: p.url, takenAt: p.takenAt, likeCount: 316, savedAt: '2026-10-02T00:00:00.000Z'});
    expect(PersonaStudySchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('下書き → Persona', () => {
  it('id は呼び出し側のもの。ボイスは base が無ければ空（音声生成は Settings で入れるまで止まる）', () => {
    const p = personaFromDraft('osshi-style', draft());
    expect(p.id).toBe('osshi-style');
    expect(p.label).toBe('おっしー風（関西・発見型）');
    expect(p.narration).toEqual({voiceId: '', voiceTitle: '', speed: 1.2, charsPerSec: 8, charsPerSecMeasured: 8});
    expect(p.cta).toEqual(['一度は行っとこ', 'ぜひ行ってみて']);
    expect(p.ctaPatterns).toEqual(['行っとこ', '行ってみて']);
    expect(p.hookStyle).toBe('areaDigit');
    expect(p.defaultFormat).toBe('F7');
    expect(p.theme).toBe('human');
    expect(p.allowEmptyReveal).toBe(true);
    expect(p.caption).toEqual({hashtags: 3, maxChars: 600});
    expect(p.captionGuide).toContain('フック 2 行');
    expect(p.skillDir).toBeUndefined();
  });

  it('base があればボイス・話速・誘導アカウントを引き継ぎ、空の項目は base の値で埋める', () => {
    const base = makePersona({id: 'hiro', label: 'hiro', narration: {voiceId: 'a'.repeat(32), voiceTitle: 'hiro voice', speed: 1.3, charsPerSec: 7.5, charsPerSecMeasured: 7.7}, caption: {hashtags: 5, maxChars: 0, repostAccount: 'oc.eat'}});
    const p = personaFromDraft('hiro-v2', draft({cta: [], ctaPatterns: [], captionGuide: '', hashtagBank: ''}), {base});
    expect(p.narration).toEqual(base.narration);
    expect(p.caption.repostAccount).toBe('oc.eat');
    expect(p.cta).toEqual(base.cta);
    expect(p.ctaPatterns).toEqual(base.ctaPatterns);
    expect(p.captionGuide).toBe(base.captionGuide);
    expect(p.hashtagBank).toBe(base.hashtagBank);
    // 本数・長さは下書きのもの（分析から分かる）
    expect(p.caption.hashtags).toBe(3);
  });

  it('表示名は指定 > 下書き > 既定、空白と重複は落とす。不正な id は例外', () => {
    expect(personaFromDraft('x1', draft({label: ''}), {label: '  自分の名前  '}).label).toBe('自分の名前');
    expect(personaFromDraft('x1', draft({label: ''})).label).toBe('AI 生成 x1');
    const p = personaFromDraft('x1', draft({cta: [' 行ってみて ', '行ってみて', ''], ctaPatterns: []}));
    expect(p.cta).toEqual(['行ってみて']);
    expect(p.ctaPatterns).toEqual(['行ってみて']);
    expect(() => personaFromDraft('Bad Id', draft())).toThrow();
    expect(() => personaFromDraft('9x', draft())).toThrow();
  });

  it('PERSONA_DRAFT_SCHEMA（claude に渡す形）は PersonaDraftSchema と同じ項目を要求する', () => {
    const keys = Object.keys(PersonaDraftSchema.shape).sort();
    expect([...PERSONA_DRAFT_SCHEMA.required].sort()).toEqual(keys);
    expect(Object.keys(PERSONA_DRAFT_SCHEMA.properties).sort()).toEqual(keys);
    // 緩く受ける：足りない項目は既定で埋まる
    expect(PersonaDraftSchema.parse({})).toMatchObject({hookStyle: 'free', defaultFormat: 'F0', hashtags: 3, cta: []});
  });

  it('要約には締め・型・ボイス未設定の案内が入る', () => {
    const lines = describePersonaDraft(personaFromDraft('x1', draft()), draft());
    expect(lines.join('\n')).toContain('一度は行っとこ');
    expect(lines.join('\n')).toContain('F7');
    expect(lines.join('\n')).toContain('ボイス: 未設定');
    expect(lines.join('\n')).toContain('動画 1 の締め');
  });
});

describe('プロンプト', () => {
  const study = studyFromPost('oc.eat', pickInstagramPosts(rawPosts())[0], '2026-10-02T00:00:00.000Z');

  it('Instagram の動画と案件の参考動画を 1 本ずつ書き、キャプションはそのまま添える。固有名詞を人格に入れない指示がある', () => {
    const prompt = buildPersonaPrompt({target: 'oc.eat', sources: [{reference: analyzed(), study}, {reference: analyzed(), slug: 'taberu-reel', shopName: '焼肉たべる'}]});
    expect(prompt).toContain('@oc.eat の最新の動画 1 本と、案件で分析済みの参考動画 1 本');
    expect(prompt).toContain('### 動画 1: Instagram @oc.eat の投稿 Ddn8GJfvtiO（2026-09-23）');
    expect(prompt).toContain('### 動画 2: 案件「taberu-reel」の参考動画（焼肉たべる の案件で参考にしたもの）');
    expect(prompt).toContain('投稿のキャプション（そのまま）');
    expect(prompt).toContain('#心斎橋グルメ');
    // 分析の中身（describeReference）が入る
    expect(prompt).toContain('フック: 数字で言い切る「生野区で9割が知らない」');
    expect(prompt).toContain('店名・料理名・地名・価格・数字そのものは人格に入れない');
    expect(prompt).toContain('番号付きの手順');
    expect(prompt).not.toContain('出発点にする既存の人格');
    expect(prompt).toContain('「・・・」');
  });

  it('base と補足があれば書く。案件だけなら Instagram の文を出さない', () => {
    const base = makePersona({id: 'hiro', label: 'hiro 本人', tone: '関西弁の男性'});
    const prompt = buildPersonaPrompt({sources: [{reference: analyzed(), slug: 'a-reel'}], base, hint: '女性の口調で'});
    expect(prompt).toContain('元にするのは案件で分析済みの参考動画 1 本');
    expect(prompt).toContain('出発点にする既存の人格');
    expect(prompt).toContain('hiro 本人');
    expect(prompt).toContain('関西弁の男性');
    expect(prompt).toContain('利用者からの補足\n女性の口調で');
    expect(prompt).toContain('captionGuide は、動画の締め方・保存させている情報から推測できる範囲で書き');
  });

  it('分析まで済んでいない参考動画は材料にしない', () => {
    const notYet = analyzed({analyzedAt: undefined, segments: []});
    expect(usableSources([{reference: analyzed()}, {reference: notYet}])).toHaveLength(1);
  });
});

describe('ジョブ種別', () => {
  it('ai-persona は案件に属さない軽いジョブ', () => {
    expect(JOB_TYPES).toContain('ai-persona');
    expect(PROJECTLESS_JOBS.has('ai-persona')).toBe(true);
    expect(isHeavyJob('ai-persona')).toBe(false);
  });
});

describe('置き場（core/persona-study.ts）', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-persona-'));
    process.env.REEL_STUDIO_HOME = home;
    resetSettings();
  });
  afterEach(() => {
    resetSettings();
    vi.unstubAllGlobals();
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('動画は <設定の置き場>/persona-studies/<user>/<code>/ に置く（名前は安全な文字だけ）', () => {
    expect(personaStudiesDir()).toBe(path.join(home, 'persona-studies'));
    expect(studyDir('oc.eat', 'Ddn8GJfvtiO')).toBe(path.join(home, 'persona-studies', 'oc.eat', 'Ddn8GJfvtiO'));
    expect(studyDir('../evil', 'a/b')).toBe(path.join(home, 'persona-studies', '.._evil', 'a_b'));
    expect(listStudies('oc.eat')).toEqual([]);
    expect(readStudy(studyDir('oc.eat', 'nope'))).toBeNull();
  });

  it('study.json があるものを新しい順に並べ、分析の有無を付ける', () => {
    const p = pickInstagramPosts(rawPosts());
    for (const post of p.filter((x) => x.videoUrl)) {
      const dir = studyDir('oc.eat', post.code);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'study.json'), JSON.stringify(studyFromPost('oc.eat', post, '2026-10-02T00:00:00.000Z')));
    }
    fs.writeFileSync(path.join(studyDir('oc.eat', 'Db2HgeRzPsN'), 'reference.json'), JSON.stringify(analyzed()));
    const list = listStudies('oc.eat');
    expect(list.map((e) => e.study.code)).toEqual(['Ddn8GJfvtiO', 'Db2pEWLvprE', 'Db2HgeRzPsN']);
    expect(list.map((e) => e.analyzed)).toEqual([false, false, true]);
  });

  it('generatePersona は、claude や Smartgram に繋ぐ前に止まるべき入力を分かる言葉で断る', async () => {
    delete process.env.SMARTGRAM_MCP_KEY;
    resetInstagramMcpEnv();
    const taken = listPersonas()[0].id;
    // 同じ id（overwrite 無し）
    await expect(generatePersona({id: taken, projects: []})).rejects.toThrow(/既にあります/);
    // 出発点の人格が無い
    await expect(generatePersona({id: 'new-one', base: 'ghost', projects: []})).rejects.toThrow(/出発点にする人格がありません/);
    // Instagram を使うのに鍵が無い
    await expect(generatePersona({id: 'new-one', instagram: {target: 'oc.eat', count: 3}})).rejects.toThrow(/Smartgram の MCP 用 API キー/);
    // ユーザー名として読めない
    await expect(generatePersona({id: 'new-one', instagram: {target: 'has space'}})).rejects.toThrow(/ユーザー名として読めません/);
    // 材料が無い
    await expect(generatePersona({id: 'new-one', projects: []})).rejects.toThrow(/分析済みの動画がありません/);
    resetInstagramMcpEnv();
  });

  it('mcpToolJson はツールの JSON を返し、isError は分かる言葉で例外にする', async () => {
    const conn = {url: 'https://mcp.example/api/mcp', apiKey: 'growgram_mcp_test_0001'};
    const calls: {name: string; args: Record<string, unknown>}[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {params: {name: string; arguments: Record<string, unknown>}};
        calls.push({name: body.params.name, args: body.params.arguments});
        const isError = body.params.name === 'broken';
        const text = isError ? 'rate limited' : JSON.stringify(rawPosts());
        return new Response(JSON.stringify({jsonrpc: '2.0', id: 2, result: {content: [{type: 'text', text}], isError}}), {status: 200, headers: {'Content-Type': 'application/json'}});
      }),
    );
    const r = await mcpToolJson<{posts: unknown[]}>(conn, 'get_user_posts', {username: 'smartgram.jp', target: 'oc.eat', count: 12});
    expect(pickInstagramPosts(r)).toHaveLength(4);
    expect(calls[0]).toEqual({name: 'get_user_posts', args: {username: 'smartgram.jp', target: 'oc.eat', count: 12}});
    await expect(mcpToolJson(conn, 'broken', {})).rejects.toThrow(InstagramMcpError);
    await expect(mcpToolJson(conn, 'broken', {})).rejects.toThrow(/rate limited/);
  });
});
