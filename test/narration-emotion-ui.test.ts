// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {defaultEmotionTags} from '../shared/emotion-tags';
import type {Narration} from '../shared/schema';
const mock = vi.hoisted(() => ({store: null as any, save: vi.fn(), add: vi.fn(), get: vi.fn(), failSave: false, events: [] as string[]}));
vi.mock('../src/state/store', () => ({useStudio: () => mock.store}));
vi.mock('../src/api', () => ({api: {get: mock.get}}));
vi.mock('../src/hooks/useAiModel', () => ({useAiModel: () => ['test', () => {}], AiModelSelect: () => null}));
vi.mock('../src/components/BuildCard', () => ({BuildCard: () => null}));
vi.mock('../src/components/CaptionCard', () => ({CaptionCard: () => null}));
vi.mock('../src/components/SfxCard', () => ({SfxCard: () => null}));
vi.mock('../src/components/TrialCard', () => ({TrialCard: () => null}));
vi.mock('../src/components/FinishedVideo', () => ({FinishedVideo: () => null}));
import {RenderPage} from '../src/pages/Render';
import {NarrationInspector} from '../src/editor/Inspector';

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
let current: Narration;
const Harness = () => {
  const [narration, setNarration] = useState<Narration>({voice: 'voice-test', speed: 1, segments: [
    {id: 'a', at: 0, text: 'お肉がとろけます', durSec: 1.2}, {id: 'b', at: 2, text: '店内も素敵です', durSec: 1.2},
  ]});
  const [dirty, setDirty] = useState(false); current = narration;
  mock.store = {active: 'food', jobs: [], config: {tts: true}, mediaBase: '/p/food/full', projects: [{slug: 'food', out: {final: true}}],
    supportsJob: () => true, logs: {}, toast: vi.fn(), refreshProjects: vi.fn(async () => {}), fetchJobLog: vi.fn(),
    files: {narration: {data: narration, dirty, etag: 'etag'}, brief: {data: null, dirty: false}, cuts: {data: null, dirty: false}},
    setFile: (_name: string, value: Narration) => {setNarration(value); setDirty(true);},
    saveFile: async (name: string) => {mock.events.push('save:' + name); mock.save(name); if (mock.failSave) return false; setDirty(false); return true;},
    addJob: async (...args: any[]) => {mock.events.push('generate'); mock.add(...args); return {id: 'job-1'};},
  };
  return React.createElement(RenderPage, {onTab: () => {}});
};
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true}); mock.failSave = false; mock.events = []; mock.save.mockClear(); mock.add.mockClear();
  mock.get.mockImplementation(async (url: string) => ({data: url === '/api/emotion-tags' ? defaultEmotionTags() : {voices: []}}));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {act(() => root.unmount()); host.remove();});
it('selects emotion on the narration audio, saves it and queues exactly one block', async () => {
  await act(async () => root.render(React.createElement(Harness)));
  const row = host.querySelector('.narr-audio-block')!;
  const excited = [...row.querySelectorAll<HTMLButtonElement>('.emotion-chip')].find(b => b.textContent?.includes('興奮'))!;
  const other = current.segments[1];
  act(() => excited.click());
  expect(current.segments[0]).toMatchObject({emotion_tag: 'excited', needsTts: true});
  expect(current.segments[0].durSec).toBeUndefined(); expect(current.segments[1]).toBe(other);
  expect(row.querySelector('audio')).toBeNull();
  expect(excited.getAttribute('aria-pressed')).toBe('true');
  const generate = row.querySelector<HTMLButtonElement>('button.primary')!;
  expect(generate.disabled).toBe(false);
  await act(async () => generate.click());
  expect(mock.events).toEqual(['save:narration', 'generate']);
  expect(mock.add).toHaveBeenCalledWith('tts', {ids: ['a'], force: true}, 'food');
  expect(host.querySelectorAll('audio')).toHaveLength(1);
});
it('does not generate after a conflict or failed save', async () => {
  await act(async () => root.render(React.createElement(Harness)));
  act(() => host.querySelector<HTMLButtonElement>('.narr-audio-block .emotion-chip')!.click());
  mock.failSave = true;
  await act(async () => host.querySelector<HTMLButtonElement>('.narr-audio-block button.primary')!.click());
  expect(mock.save).toHaveBeenCalledWith('narration'); expect(mock.add).not.toHaveBeenCalled();
});
it('offers the same emotion controls beside the selected narration in the editor', async () => {
  const segment = {id: 'a', at: 0, text: 'お肉がとろけます', durSec: 1.2};
  const patch = vi.fn();
  const m: any = {narration: {voice: 'test', segments: [segment]}, patchSeg: patch, removeSeg: vi.fn(), pushHistory: vi.fn(), setNarr: vi.fn(), estimateSec: () => 1.2, ranges: []};
  const generate = vi.fn();
  await act(async () => root.render(React.createElement(NarrationInspector, {m, index: 0, onSeekCut: vi.fn(), onPlay: vi.fn(), playing: null, onRegenerate: generate, onSaveToLibrary: vi.fn(), ttsBlockedBy: null})));
  const calm = [...host.querySelectorAll<HTMLButtonElement>('.emotion-chip')].find(b => b.textContent?.includes('落ち着き'))!;
  act(() => calm.click()); expect(patch).toHaveBeenCalledWith(0, {emotion_tag: 'calm', needsTts: true, durSec: undefined});
  act(() => host.querySelector<HTMLButtonElement>('button.primary')!.click()); expect(generate).toHaveBeenCalledWith('a');
});
