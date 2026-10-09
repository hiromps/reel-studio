// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import type {Narration, ReelData} from '../shared/schema';
import {useEditorModel, type EditorModel} from '../src/editor/useEditorModel';

const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));

it('ナレーションがなかった案件の初回音声化も、取り消しで音声なしに戻せる', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let model: EditorModel;
  let before: {cuts: ReelData | null; narration: Narration | null};
  const history = {push: vi.fn(snapshot => {before = snapshot;}), canUndo: true, canRedo: false, undo: () => before, redo: () => null};
  function Harness() {
    const [cuts] = useState<ReelData>({fps: 30, cuts: [{src: 'a', inSec: 0, outSec: 1, main: {text: 'そのまま'}}]});
    const [narration, setNarration] = useState<Narration | null>(null);
    mocked.store = {active: 'test', jobs: [], editorHistory: history,
      files: {cuts: {data: cuts, dirty: false}, narration: {data: narration, dirty: true}, catalog: {data: null}, brief: {data: null}},
      setFile: (_name: string, data: Narration) => setNarration(data)};
    model = useEditorModel(null); return null;
  }
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const record = model!.captureAiJob({voice: 'voice', segments: []});
    record('telop-job');
    await act(async () => mocked.store.setFile('narration', {voice: 'voice', segments: [{id: 'telop_new', at: 0, text: 'そのまま', durSec: 1}]}));
    expect(model!.narration!.segments).toHaveLength(1);
    await act(async () => model!.undo());
    expect(model!.narration!.segments).toEqual([]);
    expect(history.push).toHaveBeenCalledTimes(1);
  } finally {await act(async () => root.unmount()); vi.unstubAllGlobals();}
});
