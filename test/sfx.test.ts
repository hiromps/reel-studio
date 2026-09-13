import {describe, expect, it} from 'vitest';
import {SFX_DEFAULTS, assignSounds, checkSfx, sfxCandidates, sfxEndSec, thinCandidates, type SfxCandidate, type SfxLibrary} from '@shared/sfx';
import type {ReelData} from '@shared/schema';

/** 1.5 秒ずつの n カット。texts[i] があればそのテロップを付ける */
const cutsOf = (texts: (string | undefined)[]): ReelData =>
  ({
    fps: 30,
    theme: 'pop',
    cuts: texts.map((t, i) => ({id: `c${i}`, src: `uploads/${i}.mov`, inSec: 0, outSec: 1.5, ...(t === undefined ? {} : {main: {text: t}})})),
  }) as ReelData;

const lib: SfxLibrary = {
  version: 1,
  sounds: [
    {file: 'alarm.mp3', label: 'アラーム', roles: ['hook'], durSec: 4.45, defaultTrimSec: 1.2, defaultFadeOutSec: 0.3, defaultGainDb: -3},
    {file: 'pop.mp3', label: 'ポップ', roles: ['telop', 'outro'], durSec: 0.4},
    {file: 'unused.mp3', label: '未設定', roles: [], durSec: 1},
  ],
};

describe('sfxCandidates', () => {
  it('冒頭は必ず hook', () => {
    const c = sfxCandidates(cutsOf(['a', 'b', 'c']));
    expect(c[0]).toMatchObject({at: 0, role: 'hook'});
  });

  it('テロップ出現は前半だけ・1枚目は hook と重なるので拾わない', () => {
    // 8 カット = 12 秒。前半 6 秒までのグループが対象
    const c = sfxCandidates(cutsOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).filter((x) => x.role === 'telop');
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => x.at > 0 && x.at <= 6)).toBe(true);
  });

  it('未記入テロップ（{{...}}）には置かない', () => {
    const c = sfxCandidates(cutsOf(['a', '{{g02:証拠}}', 'c'])).filter((x) => x.role === 'telop');
    expect(c.some((x) => x.at === 1.5)).toBe(false);
  });

  it('リビール・実食・場面転換は渡された位置に出る', () => {
    const c = sfxCandidates(cutsOf(['a', 'b', 'c', 'd']), {revealAt: 4.5, eatAtList: [3], transitionAtList: [1.5]});
    expect(c.find((x) => x.role === 'reveal')?.at).toBe(4.5);
    expect(c.find((x) => x.role === 'eat')?.at).toBe(3);
    expect(c.find((x) => x.role === 'transition')?.at).toBe(1.5);
  });

  it('締めは最後のテロップグループ（1グループしか無ければ置かない）', () => {
    expect(sfxCandidates(cutsOf(['a'])).some((x) => x.role === 'outro')).toBe(false);
    expect(sfxCandidates(cutsOf(['a', 'b'])).some((x) => x.role === 'outro')).toBe(true);
  });
});

describe('thinCandidates', () => {
  const c = (at: number, role: SfxCandidate['role']): SfxCandidate => ({at, role, why: ''});

  it('近すぎる候補は優先度の高い役割を残す', () => {
    const r = thinCandidates([c(0, 'transition'), c(0.3, 'hook')], 20);
    expect(r).toHaveLength(1);
    expect(r[0].role).toBe('hook');
  });

  it('間隔が空いていれば両方残る', () => {
    expect(thinCandidates([c(0, 'hook'), c(5, 'telop')], 20)).toHaveLength(2);
  });

  it('上限個数を超えたら優先度の低いものから落とす（hook は残る）', () => {
    const r = thinCandidates([c(0, 'hook'), c(2, 'transition'), c(4, 'telop'), c(6, 'transition')], 20, {max: 2});
    expect(r).toHaveLength(2);
    expect(r[0].role).toBe('hook');
    expect(r.map((x) => x.at)).toEqual([...r.map((x) => x.at)].sort((a, b) => a - b)); // 時系列は保つ
  });

  it('exclude した役割は置かない', () => {
    const r = thinCandidates([c(0, 'hook'), c(5, 'transition')], 20, {exclude: ['transition']});
    expect(r.map((x) => x.role)).toEqual(['hook']);
  });

  it('動画尺より後ろの候補は捨てる', () => {
    expect(thinCandidates([c(0, 'hook'), c(25, 'outro')], 20)).toHaveLength(1);
  });

  it('既定の上限は尺に比例する（20秒なら6個）', () => {
    const many = Array.from({length: 20}, (_, i) => c(i * 1.5, 'transition'));
    expect(thinCandidates(many, 20).length).toBeLessThanOrEqual(Math.round(20 * SFX_DEFAULTS.perSec));
  });
});

describe('assignSounds', () => {
  it('役割に登録された音を当て、無い役割は missing に出す', () => {
    const r = assignSounds([{at: 0, role: 'hook', why: ''}, {at: 5, role: 'eat', why: ''}], lib);
    expect(r.sfx).toHaveLength(1);
    expect(r.sfx[0]).toMatchObject({file: 'alarm.mp3', role: 'hook', trimSec: 1.2, fadeOutSec: 0.3, gainDb: -3});
    expect(r.missing).toEqual(['eat']);
  });

  it('同じ役割が複数あれば id に連番を付ける', () => {
    const r = assignSounds([{at: 2, role: 'telop', why: ''}, {at: 6, role: 'telop', why: ''}], lib);
    expect(r.sfx.map((x) => x.id)).toEqual(['telop', 'telop2']);
  });

  it('trim の既定が無い音は素材尺と既定値の小さい方（丸ごと鳴らさない）', () => {
    const r = assignSounds([{at: 0, role: 'telop', why: ''}], lib);
    expect(r.sfx[0].trimSec).toBe(0.4); // 素材が 0.4 秒なので既定 1.2 ではなくこちら
  });
});

describe('checkSfx', () => {
  const hook = {id: 'hook', at: 0, file: 'alarm.mp3', trimSec: 1.2};

  it('ライブラリに無い音源は E', () => {
    const r = checkSfx([{id: 'x', at: 0, file: 'nope.mp3'}], {lib});
    expect(r.find((i) => i.code === 'SFX_MISSING_FILE')?.severity).toBe('E');
  });

  it('id の重複は E', () => {
    expect(checkSfx([hook, {...hook, at: 5}], {lib}).some((i) => i.code === 'SFX_DUP_ID')).toBe(true);
  });

  it('動画尺より後ろは E、はみ出しは W', () => {
    expect(checkSfx([{...hook, at: 25}], {videoSec: 20, lib}).some((i) => i.code === 'SFX_AFTER_END')).toBe(true);
    expect(checkSfx([{...hook, at: 19.8}], {videoSec: 20, lib}).some((i) => i.code === 'SFX_OVERRUN')).toBe(true);
  });

  it('近すぎる効果音は W（音が団子になる）', () => {
    expect(checkSfx([hook, {...hook, id: 'b', at: 0.5}], {lib}).some((i) => i.code === 'SFX_TOO_CLOSE')).toBe(true);
  });

  it('ナレーションに被ったら W（声が埋もれる）', () => {
    const r = checkSfx([hook], {lib, narration: [{id: '01_hook', at: 0, durSec: 1.6}]});
    expect(r.find((i) => i.code === 'SFX_OVER_NARRATION')?.message).toContain('1.20 秒');
  });

  it('被りが 0.15 秒以下なら指摘しない', () => {
    expect(checkSfx([{...hook, at: 1.5, trimSec: 0.2}], {lib, narration: [{id: 'n', at: 0, durSec: 1.6}]}).some((i) => i.code === 'SFX_OVER_NARRATION')).toBe(false);
  });

  it('数が多すぎたら W', () => {
    const many = Array.from({length: 10}, (_, i) => ({id: `s${i}`, at: i * 2, file: 'alarm.mp3', trimSec: 0.5}));
    expect(checkSfx(many, {videoSec: 20, lib}).some((i) => i.code === 'SFX_TOO_MANY')).toBe(true);
  });
});

describe('sfxEndSec', () => {
  it('trim と素材尺の短い方で終わる', () => {
    expect(sfxEndSec({id: 'a', at: 2, file: 'alarm.mp3', trimSec: 1.2}, lib)).toBeCloseTo(3.2);
    expect(sfxEndSec({id: 'a', at: 2, file: 'pop.mp3', trimSec: 5}, lib)).toBeCloseTo(2.4); // 素材が 0.4 秒
  });
});
