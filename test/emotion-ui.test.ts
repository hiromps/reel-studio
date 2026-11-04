// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, expect, it, vi} from 'vitest';
import {defaultEmotionTags} from '../shared/emotion-tags';
import {EmotionCutsDialog} from '../src/editor/EmotionCutsDialog';
const mock = vi.hoisted(() => ({store: null as any, get: vi.fn()}));
vi.mock('../src/state/store', () => ({useStudio: () => mock.store}));
vi.mock('../src/api', () => ({api: {get: mock.get}}));
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
beforeEach(() => {
  mock.get.mockResolvedValue({data: defaultEmotionTags()});
  mock.store = {active: 'food', jobs: [], config: {tts: true}, mediaBase: '/p/food/full', supportsJob: () => true, addJob: vi.fn(async () => ({id: 'test-job'}))};
});
it('offers one-tap per-cut chips, bulk changes and number shortcuts without affecting text inputs', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  let cuts = {fps: 30, cuts: [{id: 'a', src: 'a.mp4', inSec: 0, outSec: 2, emotion_tag: null as string | null}, {id: 'b', src: 'b.mp4', inSec: 0, outSec: 2, emotion_tag: null as string | null}]};
  const changed = vi.fn((ids: string[], emotion: string | null) => {
    cuts = {...cuts, cuts: cuts.cuts.map(c => ids.includes(c.id) ? {...c, emotion_tag: emotion} : c)}; render();
  });
  const render = () => root.render(React.createElement(EmotionCutsDialog, {cuts, narration: null, initialSelection: [], voice: 'v', onChange: changed, onClose: vi.fn()}));
  try {
    await act(async () => render());
    const rows = host.querySelectorAll('.emotion-cut-list li');
    const excited = rows[0].querySelector<HTMLButtonElement>('button')!;
    act(() => excited.click()); expect(changed).toHaveBeenLastCalledWith(['a'], 'excited'); expect(excited.getAttribute('aria-pressed')).toBe('true');
    act(() => excited.click()); expect(changed).toHaveBeenLastCalledWith(['a'], null); expect(excited.getAttribute('aria-pressed')).toBe('false');
    const all = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'すべて選択')!;
    act(() => all.click());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '6'})));
    expect(changed).toHaveBeenLastCalledWith(['a', 'b'], 'calm');
    expect([...host.querySelectorAll('.emotion-cut-list button[aria-pressed="true"]')].every(b => b.textContent?.includes('落ち着き'))).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '6'}))); expect(changed).toHaveBeenLastCalledWith(['a', 'b'], null);
    const input = document.createElement('textarea'); host.append(input);
    const calls = changed.mock.calls.length;
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', {key: '1', bubbles: true})));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '1', isComposing: true})));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '1', ctrlKey: true})));
    expect(changed).toHaveBeenCalledTimes(calls);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '7'}))); expect(changed).toHaveBeenLastCalledWith(['a', 'b'], 'hurried');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '0'}))); expect(changed).toHaveBeenLastCalledWith(['a', 'b'], null);
    expect(host.querySelector('select')).toBeNull();
  } finally {act(() => root.unmount()); host.remove();}
});

it('uses runtime JSON additions and queues local-only audition generation', async () => {
  const cfg = defaultEmotionTags(); cfg.tags.push({id: 'happy', label: 'うれしい', fish_tag: '[happy]', note: '追加', color: '#285c9d'});
  mock.get.mockResolvedValue({data: cfg});
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = () => root.render(React.createElement(EmotionCutsDialog, {cuts: {fps: 30, cuts: [{id: 'a', src: 'a.mp4', inSec: 0, outSec: 2, emotion_tag: null}]}, narration: null, initialSelection: [], voice: 'test-voice', onChange: vi.fn(), onClose: vi.fn()}));
  try {
    await act(async () => render());
    expect(host.textContent).toContain('うれしい');
    const generate = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('試聴音声を生成'))!;
    await act(async () => generate.click());
    expect(mock.store.addJob).toHaveBeenCalledWith('emotion-test', {voice: 'test-voice', text: cfg.audition.text, speed: cfg.audition.speed});
    mock.store.jobs = [{id: 'test-job', status: 'done', result: {samples: [{id: 'excited', label: '興奮', file: 'narration/emotion-tests/test.wav', cached: true}]}}];
    act(() => render());
    expect(host.querySelector('audio')?.getAttribute('src')).toBe('/p/food/full/narration/emotion-tests/test.wav');
    expect(host.querySelector('audio')?.getAttribute('preload')).toBe('none');
  } finally {act(() => root.unmount()); host.remove();}
});
