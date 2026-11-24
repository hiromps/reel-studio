import {describe, expect, it} from 'vitest';
import {BGM_DEFAULTS, bgmCandidates, bgmResolved, checkBgm, hasMixAudio, safeBgmFileName} from '../shared/bgm';
import {NarrationSchema} from '../shared/schema/narration';
import {loopPlayback, mixClipsOf, planPlayback} from '../src/editor/mixPreview';
import {bgmBar} from '../src/editor/tracks';
import {sameSelection} from '../src/editor/selection';
import {FISH_MODELS, fishModelSupportsTags} from '../shared/fish-models';
import {ReelCutsConfigSchema} from '../shared/reel-cuts';
import ocEat from '../shared/config/oc-eat.json';
import type {SfxLibrary} from '../shared/sfx';

const lib: SfxLibrary = {
  version: 1,
  sounds: [
    {file: 'BGM/cafe.mp3', label: 'カフェ', roles: [], durSec: 30},
    {file: 'hook/alarm.mp3', label: 'アラーム', roles: ['hook'], durSec: 1.5},
    {file: 'loops/jazz.mp3', label: 'ジャズ', roles: [], durSec: 60},
  ],
};

describe('BGM の候補', () => {
  it('BGM フォルダの曲を先に、短い効果音は出さない', () => {
    const c = bgmCandidates(lib);
    expect(c.map((x) => [x.sound.file, x.inFolder])).toEqual([
      ['BGM/cafe.mp3', true],
      ['loops/jazz.mp3', false],
    ]);
  });
});

describe('narration.json の bgm', () => {
  it('bgm を保存・読み込みできる', () => {
    const n = NarrationSchema.parse({voice: '', segments: [], bgm: {file: 'BGM/cafe.mp3', gainDb: -20}});
    expect(n.bgm?.file).toBe('BGM/cafe.mp3');
    expect(hasMixAudio(n)).toBe(true);
    expect(hasMixAudio({segments: [], sfx: []})).toBe(false);
  });
  it('既定値を埋める', () => {
    expect(bgmResolved({file: 'x.mp3'})).toEqual({gainDb: BGM_DEFAULTS.gainDb, startSec: 0, fadeInSec: 0.5, fadeOutSec: 1.5, loop: true, duck: true});
  });
});

describe('BGM の点検', () => {
  it('音源が無い・飛ばしすぎ・繰り返し無しで足りない', () => {
    expect(checkBgm({file: 'BGM/none.mp3'}, {lib}).map((x) => x.code)).toContain('BGM_MISSING_FILE');
    expect(checkBgm({file: 'BGM/cafe.mp3', startSec: 31}, {lib}).map((x) => x.code)).toContain('BGM_START_AFTER_END');
    expect(checkBgm({file: 'BGM/cafe.mp3', startSec: 20, loop: false}, {lib, videoSec: 20}).map((x) => x.code)).toContain('BGM_TOO_SHORT');
    expect(checkBgm({file: 'BGM/cafe.mp3', startSec: 20}, {lib, videoSec: 20})).toEqual([]);
  });
});

describe('取り込むファイル名', () => {
  it('フォルダ区切りや使えない拡張子を弾く', () => {
    expect(safeBgmFileName('../../evil/曲.MP3')).toBe('曲.mp3');
    expect(safeBgmFileName('a.exe')).toBeNull();
    expect(safeBgmFileName('.mp3')).toBeNull();
  });
});

describe('プレビューの BGM', () => {
  const narration = NarrationSchema.parse({voice: '', segments: [], bgm: {file: 'BGM/cafe.mp3', startSec: 10, gainDb: -20}});
  it('繰り返す BGM は planPlayback に入らず loopPlayback で位置を出す', () => {
    const clips = mixClipsOf(narration, '/media', lib);
    const bgm = clips.find((c) => c.kind === 'bgm')!;
    expect(bgm.loop).toBe(true);
    expect(planPlayback(clips, () => 30, 0)).toEqual([]);
    // 曲 30 秒・頭 10 秒飛ばし → 動画 25 秒目は 35 秒 → 2 周目の 5 秒目
    expect(loopPlayback(bgm, 30, 25)?.offsetSec).toBeCloseTo(5);
    expect(loopPlayback(bgm, 30, 0.2)?.fadeInLeftSec).toBeCloseTo(0.3);
  });
  it('繰り返さない BGM は頭を飛ばした位置から鳴る', () => {
    const n = {...narration, bgm: {...narration.bgm!, loop: false}};
    const plan = planPlayback(mixClipsOf(n, '/media', lib), () => 30, 4);
    expect(plan[0].offsetSec).toBeCloseTo(14);
    expect(plan[0].durationSec).toBeCloseTo(16);
  });
});

describe('タイムラインの B 段', () => {
  const n = (bgm: object) => NarrationSchema.parse({voice: '', segments: [], bgm});
  it('繰り返すなら動画の最後まで帯を引き、継ぎ目の位置を出す', () => {
    // 曲 30 秒・頭 10 秒飛ばし・動画 45 秒 → 20 秒目と 50 秒目（動画外）で頭に戻る
    const b = bgmBar(n({file: 'BGM/cafe.mp3', startSec: 10}), 45, 10, lib)!;
    expect(b.width).toBe(450);
    expect(b.loopX).toEqual([200]);
    expect(b.fadeInW).toBeCloseTo(5);
    expect(b.fadeOutW).toBeCloseTo(15);
  });
  it('繰り返さないなら曲が尽きた所で帯が終わり、フェードアウトは付かない', () => {
    const b = bgmBar(n({file: 'BGM/cafe.mp3', startSec: 10, loop: false}), 45, 10, lib)!;
    expect(b.endSec).toBe(20);
    expect(b.fadeOutW).toBe(0);
  });
  it('BGM が無ければ帯を出さない・音源が無ければ missing', () => {
    expect(bgmBar(NarrationSchema.parse({voice: '', segments: []}), 45, 10, lib)).toBeNull();
    expect(bgmBar(n({file: 'BGM/none.mp3'}), 45, 10, lib)?.missing).toBe(true);
    expect(sameSelection({kind: 'bgm'}, {kind: 'bgm'})).toBe(true);
  });
});

describe('Fish Audio のモデル', () => {
  it('Drama 3 を選べて、感情タグ付きの音声と共通カットの設定に使える', () => {
    expect(FISH_MODELS.map((m) => m.id)).toContain('drama-3');
    expect(fishModelSupportsTags('drama-3')).toBe(true);
    expect(fishModelSupportsTags('s1')).toBe(false);
    expect(ReelCutsConfigSchema.parse(ocEat).fish.supported_models).toContain('drama-3');
  });
});
