import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Narration, ReelData} from '../shared/schema';
import {telopNarrationConfirmation} from '../shared/telop-narration';

const state = vi.hoisted(() => ({cuts: null as ReelData | null, narration: null as Narration | null,
  available: true, write: vi.fn(), voiceExists: vi.fn(), generate: vi.fn()}));
const defaults = {voice: 'default', voiceTitle: '既定', speed: 1.2};
vi.mock('../shared/personas', () => ({getPersona: () => ({narration: {voiceId: 'default', voiceTitle: '既定', speed: 1.2}})}));
vi.mock('../core/project', () => ({
  readBrief: () => ({persona: 'test'}), readCuts: () => state.cuts, readNarration: () => state.narration,
  writeNarration: (_dir: string, data: Narration) => {state.write(data); state.narration = data;},
}));
vi.mock('../core/tts', () => ({generateTts: (...args: unknown[]) => state.generate(...args),
  ttsAvailable: () => state.available, voiceExists: (...args: unknown[]) => state.voiceExists(...args), NO_FISH_KEY: 'キー未設定'}));
import {generateTelopNarration} from '../core/telop-narration';

beforeEach(() => {
  vi.clearAllMocks();
  state.cuts = {fps: 30, cuts: [{src: 'a', inSec: 0, outSec: 1, main: {text: 'そのまま！'}}]};
  state.narration = {voice: 'chosen', speed: 1.1, segments: [{id: 'original', at: 0, text: '前の原稿', durSec: 1}]};
  state.available = true;
  state.voiceExists.mockResolvedValue(true);
  state.generate.mockResolvedValue({made: ['made'], skipped: [], chars: 5, modelId: 'test'});
});
const fingerprint = () => telopNarrationConfirmation(state.cuts!, state.narration, defaults).fingerprint;

describe('テロップ音声化ジョブ', () => {
  it('文言をコピーして音声生成まで続行し、新しい音声IDだけを生成する', async () => {
    const old = state.narration!;
    const r = await generateTelopNarration('project', {fingerprint: fingerprint()});
    expect(r.made).toBe(1);
    expect(state.narration!.segments[0]).toMatchObject({text: 'そのまま！', at: 0, needsTts: true});
    expect(state.narration!.segments[0].id).toMatch(/^telop_[a-f0-9]{32}_001$/);
    expect(state.generate).toHaveBeenCalledWith('project', expect.objectContaining({ids: [state.narration!.segments[0].id]}));
    expect(old.segments[0].id).toBe('original');
  });

  it('確認後に変わった原稿やテロップを上書きしない', async () => {
    const confirmed = fingerprint(); state.cuts!.cuts[0].main!.text = '後から変更';
    await expect(generateTelopNarration('project', {fingerprint: confirmed})).rejects.toThrow('確認後に');
    expect(state.write).not.toHaveBeenCalled(); expect(state.generate).not.toHaveBeenCalled();
  });

  it.each(['key', 'voice', 'abort'])('事前確認 %s の失敗では元原稿を変更しない', async mode => {
    const controller = new AbortController();
    if (mode === 'key') state.available = false;
    if (mode === 'voice') state.voiceExists.mockResolvedValue(false);
    if (mode === 'abort') controller.abort();
    await expect(generateTelopNarration('project', {fingerprint: fingerprint(), signal: controller.signal})).rejects.toThrow();
    expect(state.write).not.toHaveBeenCalled(); expect(state.generate).not.toHaveBeenCalled();
  });

  it('ボイス確認の待ち時間中に変更された場合も上書きしない', async () => {
    const confirmed = fingerprint();
    state.voiceExists.mockImplementation(async () => {state.narration!.segments[0].text = '編集中'; return true;});
    await expect(generateTelopNarration('project', {fingerprint: confirmed})).rejects.toThrow('確認後に');
    expect(state.write).not.toHaveBeenCalled();
  });

  it('生成が失敗してもコピー済み原稿を残し、通常の音声生成で再試行できる', async () => {
    state.generate.mockRejectedValueOnce(new Error('通信失敗'));
    await expect(generateTelopNarration('project', {fingerprint: fingerprint()})).rejects.toThrow('通信失敗');
    expect(state.narration!.segments[0]).toMatchObject({text: 'そのまま！', needsTts: true});
    expect(state.narration!.segments[0].id).not.toBe('original');
  });
});
