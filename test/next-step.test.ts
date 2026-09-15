// 「次にやること」の判定。初めての人がどの画面へ行けばいいかを決めるので、順序を固定しておく。
import {describe, expect, it} from 'vitest';
import {countPlaceholders, countUntagged, nextStepOf, type StudioSnapshot} from '../src/components/nextStep';
import type {Brief, Catalog, Clip, ClipTags, ReelData} from '../shared/schema';

const clean = {catalog: false, brief: false, cuts: false};

const tags = (): ClipTags => ({
  kind: 'eating',
  signage: false,
  signageSize: 'none',
  angle: 'mid',
  motion: 'handheld',
  sizzleScore: 3,
  quality: 3,
  hasSpeech: false,
  subject: '',
  description: '',
  source: 'claude',
  taggedAt: '2026-09-10T00:00:00.000Z',
});

const clip = (id: string, o: {tagged?: boolean; ng?: boolean} = {}): Clip =>
  ({
    id,
    original: `${id}.mov`,
    slug: id,
    src: `uploads/${id}.mov`,
    probe: {codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: 30, durationSec: 5, hasAudio: true, pixFmt: 'yuv420p'},
    thumbs: {sheet: '', strip: []},
    usableRanges: [],
    user: {hook: false, ng: !!o.ng, orderHint: null, lock: false},
    ...(o.tagged === false ? {} : {tags: tags()}),
  }) as Clip;

const catalogOf = (clips: Clip[]): Catalog =>
  ({version: 1, slug: 's', materialsDir: 'd', dominantFps: 30, createdAt: '', updatedAt: '', facts: [], clips}) as Catalog;

const briefOf = (): Brief => ({version: 1, persona: 'standard', shop: {name: 'x', area: 'y', genre: '', pr: false}, materialMode: 'raw', format: 'F0', savePriorities: [], ngClipIds: []}) as unknown as Brief;

const cutsOf = (texts: (string | undefined)[]): ReelData =>
  ({
    fps: 30,
    theme: 'pop',
    cuts: texts.map((t, i) => ({id: `c${i}`, src: `uploads/${i}.mov`, inSec: 0, outSec: 1.5, ...(t === undefined ? {} : {main: {text: t}})})),
  }) as ReelData;

const snap = (o: Partial<StudioSnapshot>): StudioSnapshot => ({active: 'p', catalog: null, brief: null, cuts: null, narration: null, caption: null, dirty: clean, ...o});

describe('countUntagged', () => {
  it('タグ無しを数える。NG にしたものは除く', () => {
    expect(countUntagged(catalogOf([clip('a'), clip('b', {tagged: false}), clip('c', {tagged: false, ng: true})]))).toBe(1);
  });
});

describe('countPlaceholders', () => {
  it('main と subs の {{...}} を数える', () => {
    const cuts = cutsOf(['{{g01:hook}}', '本文', undefined]);
    cuts.cuts[2].subs = [{text: '{{g02:info}}', startSec: 0, endSec: 1}, {text: 'ふつう', startSec: 1, endSec: 2}];
    expect(countPlaceholders(cuts)).toBe(2);
  });

  it('全部書けていれば 0', () => {
    expect(countPlaceholders(cutsOf(['あ', 'い']))).toBe(0);
  });
});

describe('nextStepOf', () => {
  it('案件が無ければ Projects', () => {
    expect(nextStepOf(snap({active: null})).tab).toBe('projects');
  });

  it('catalog が無ければ Materials', () => {
    expect(nextStepOf(snap({})).id).toBe('catalog');
    expect(nextStepOf(snap({catalog: catalogOf([])})).id).toBe('catalog');
  });

  it('未タグがあれば本数を出す', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a'), clip('b', {tagged: false})])}));
    expect(r.id).toBe('tag');
    expect(r.text).toContain('1 本');
  });

  it('タグが揃ったら Brief 作成へ', () => {
    expect(nextStepOf(snap({catalog: catalogOf([clip('a')])})).id).toBe('brief');
  });

  it('brief があって cuts が無ければプラン生成へ', () => {
    expect(nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf()})).id).toBe('plan');
  });

  it('テロップ未記入があれば Timeline へ', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf(), cuts: cutsOf(['{{g01:hook}}', 'ok'])}));
    expect(r.id).toBe('telop');
    expect(r.tab).toBe('timeline');
    expect(r.text).toContain('1 件');
  });

  it('テロップが埋まっていて未保存なら保存を促す', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf(), cuts: cutsOf(['ok']), dirty: {...clean, cuts: true}}));
    expect(r.id).toBe('save-cuts');
  });

  const narrationOf = (over: {needsTts?: boolean; durSec?: number} = {}) =>
    ({voice: 'v', speed: 1.6, segments: [{id: '01', at: 0.15, text: 'よみあげ', durSec: 2.0, ...over}]}) as unknown as NonNullable<StudioSnapshot['narration']>;

  it('テロップまで済んでもナレーションが無ければ先にナレーション', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf(), cuts: cutsOf(['ok'])}));
    expect(r.id).toBe('narration');
    expect(r.ready).toBeFalsy();
  });

  it('原稿はあるが音声が未生成なら TTS を促す', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf(), cuts: cutsOf(['ok']), narration: narrationOf({needsTts: true})}));
    expect(r.id).toBe('tts');
  });

  it('音声まで出来てもキャプションが無ければキャプションを促す', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf(), cuts: cutsOf(['ok']), narration: narrationOf()}));
    expect(r.id).toBe('caption');
    expect(r.ready).toBeFalsy();
  });

  it('全部済んだら Render（ready）', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a')]), brief: briefOf(), cuts: cutsOf(['ok']), narration: narrationOf(), caption: '本文 #タグ'}));
    expect(r.id).toBe('render');
    expect(r.ready).toBe(true);
  });

  it('未タグは未保存 catalog より優先する（作業の順番どおり）', () => {
    const r = nextStepOf(snap({catalog: catalogOf([clip('a', {tagged: false})]), dirty: {...clean, catalog: true}}));
    expect(r.id).toBe('tag');
  });
});
