// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ReelData} from '@shared/schema';
import {EditorPage} from '../src/editor/EditorPage';

const player = vi.hoisted(() => ({
  onFrame: (_frame: number) => {},
  onPlayState: (_playing: boolean) => {},
  pause: vi.fn(),
  seekTo: vi.fn(),
}));

vi.mock('../src/api', () => ({api: {get: async () => ({data: {version: 1, sounds: []}})}}));
vi.mock('../src/state/store', () => ({useStudio: () => ({active: 'test', mediaBase: null, jobs: [], files: {cuts: {dirty: false}, narration: {dirty: false}, catalog: {dirty: false}}, supportsJob: () => true})}));
vi.mock('../src/components/Preview', async () => {
  const {forwardRef, useImperativeHandle} = await import('react');
  return {
    Preview: forwardRef((props: {onFrame: (frame: number) => void; onPlayState: (playing: boolean) => void}, ref) => {
      player.onFrame = props.onFrame;
      player.onPlayState = props.onPlayState;
      useImperativeHandle(ref, () => ({pause: player.pause, seekTo: player.seekTo, getCurrentFrame: () => 0, setVolume: () => {}}));
      return null;
    }),
  };
});
vi.mock('../src/editor/useEditorModel', async () => {
  const {useState} = await import('react');
  const {cutRanges} = await import('@shared/timeline');
  const cuts: ReelData = {fps: 30, cuts: Array.from({length: 12}, (_, i) => ({id: `c${i}`, src: `uploads/${i}.mp4`, inSec: 0, outSec: 1}))};
  const ranges = cutRanges(cuts);
  return {
    useEditorModel: () => {
      const [selection, setSelection] = useState<import('../src/editor/selection').Selection>(null);
      const [frame, setFrame] = useState(0);
      return {
        cuts, narration: null, catalog: null, brief: null, selection, setSelection, frame, setFrame,
        fps: 30, total: 12, ranges, currentCut: ranges.findIndex((r) => frame >= r.from && frame < r.from + r.dur),
        groups: [], groupOfCut: new Map(), history: {canUndo: false, canRedo: false},
        clipOf: () => undefined, slotOf: () => undefined, estimateSec: () => 1,
      };
    },
  };
});
vi.mock('../src/components/EmptyState', () => ({EmptyState: () => null}));
vi.mock('../src/components/AiJobStatus', () => ({AiJobStatus: () => null}));
vi.mock('../src/components/Storyboard', () => ({Storyboard: () => null}));
vi.mock('../src/components/useBinDrag', () => ({useBinDrag: () => ({drag: null, handleProps: () => ({})})}));
vi.mock('../src/components/useDebounced', () => ({useDebounced: (value: unknown) => value}));
vi.mock('../src/hooks/useHotkeys', () => ({useHotkeys: () => {}}));
vi.mock('../src/editor/Bin', () => ({Bin: () => null}));
vi.mock('../src/editor/Transport', () => ({PreviewOptions: () => null, Transport: () => null}));
vi.mock('../src/editor/Inspector', () => ({
  CutInspector: ({index}: {index: number}) => React.createElement('output', {'data-inspector': true}, index + 1),
  NarrationInspector: () => null, ReelInspector: () => null, SfxInspector: () => null, TelopInspector: () => null,
}));
vi.mock('../src/editor/ValidationPanel', () => ({ValidationPanel: () => null}));
vi.mock('../src/editor/AiMenu', () => ({AiMenu: () => null}));
vi.mock('../src/editor/ThumbnailSection', () => ({ThumbnailSection: () => null, patchThumbnail: () => {}}));
vi.mock('../src/editor/useMixPreview', () => ({useMixPreview: () => ({})}));
vi.mock('../src/components/PreviewReady', () => ({PreviewReady: () => null}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('editor playback selection', () => {
  it('follows playback from cut 8 to cut 12 without pausing or seeking', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const selectedIndex = () => Number(container.querySelector<HTMLElement>('.ctl-clip.selected')?.dataset.dndIndex);
    try {
      await act(async () => root.render(React.createElement(EditorPage, {onTab: () => {}})));
      // jsdom はスクロールを実装していないため、カードの描画だけ確認する。
      for (const clip of container.querySelectorAll<HTMLElement>('.ctl-clip')) clip.scrollIntoView = vi.fn();
      await act(async () => container.querySelector('[data-dnd-index="7"]')!.dispatchEvent(new MouseEvent('click', {bubbles: true})));
      expect(selectedIndex()).toBe(7);
      expect(player.seekTo).toHaveBeenLastCalledWith(219);

      // 再生状態の通知がなくても、再生バーの位置そのものに選択が追従する。
      await act(async () => player.onFrame(330));
      expect(selectedIndex()).toBe(11);
      await act(async () => player.onFrame(219));
      expect(selectedIndex()).toBe(7);

      await act(async () => player.onPlayState(true));
      player.pause.mockClear();
      player.seekTo.mockClear();
      await act(async () => player.onFrame(329));
      expect(selectedIndex()).toBe(10);
      await act(async () => player.onFrame(330));
      expect(selectedIndex()).toBe(11);
      expect(container.querySelector('[data-inspector]')?.textContent).toBe('12');
      expect(container.querySelector<HTMLElement>('.tl-playhead')?.style.left).toBe('990px');
      await act(async () => player.onFrame(340));
      expect(selectedIndex()).toBe(11);
      expect(player.pause).not.toHaveBeenCalled();
      expect(player.seekTo).not.toHaveBeenCalled();

      await act(async () => player.onFrame(0));
      expect(selectedIndex()).toBe(0);
      await act(async () => player.onPlayState(false));
      await act(async () => container.querySelector('[data-dnd-index="7"]')!.dispatchEvent(new MouseEvent('click', {bubbles: true})));
      expect(selectedIndex()).toBe(7);
      const pointer = (type: string, clientX: number) => {
        const event = new MouseEvent(type, {bubbles: true, button: 0, clientX});
        Object.defineProperties(event, {pointerId: {value: 1}, pointerType: {value: 'mouse'}});
        return event;
      };
      await act(async () => container.querySelector('.tl-ruler')!.dispatchEvent(pointer('pointerdown', 990)));
      expect(selectedIndex()).toBe(11);
      await act(async () => container.querySelector('.tl-scroll')!.dispatchEvent(pointer('pointermove', 405)));
      expect(selectedIndex()).toBe(4);
      await act(async () => container.querySelector('.tl-scroll')!.dispatchEvent(pointer('pointerup', 405)));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
