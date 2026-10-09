// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ReelDataSchema, type ReelData, type Narration} from '../shared/schema';
import {telopBlocks} from '../src/editor/tracks';
const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
import {useEditorModel, type EditorModel} from '../src/editor/useEditorModel';
import {CutInspector, TelopInspector, ReelInspector} from '../src/editor/Inspector';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let model: EditorModel;
let initial: ReelData;
let initialNarration: Narration | null;
const history = {push: vi.fn(), canUndo: false, canRedo: false, undo: vi.fn(), redo: vi.fn()};
const cut = (i: number, text: string) => ({id: 'c' + i, src: 'uploads/' + i + '.mp4', inSec: 0, outSec: 1, main: {text, orientation: 'horizontal' as const}});
function Harness() {
  const [cuts, setCuts] = useState(initial);
  const [narration, setNarration] = useState(initialNarration);
  mocked.store = {active: 'test', supportsJob: () => true, mediaBase: null, config: {fonts: []}, jobs: [], editorHistory: history, toast: vi.fn(), files: {cuts: {data: cuts, dirty: true, loading: false}, narration: {data: narration, dirty: true, loading: false}, catalog: {data: null}, brief: {data: null}}, setFile: (name: string, value: any) => name === 'cuts' ? setCuts(value) : setNarration(value)};
  model = useEditorModel(null);
  const sel = model.selection;
  return sel?.kind === 'telop' ? React.createElement(TelopInspector, {m: model, group: sel.group, onSeekCut: vi.fn()}) : sel?.kind === 'cut' ? React.createElement(CutInspector, {m: model, index: sel.index, onSeekCut: vi.fn()}) : React.createElement(ReelInspector, {m: model});
}
beforeEach(() => {
  vi.clearAllMocks();initial = {fps: 30, cuts: [cut(1, '最初'), cut(2, '本編'), cut(3, '最後')]};initialNarration = null;
  host = document.createElement('div');document.body.append(host);root = createRoot(host);
});
afterEach(() => {act(() => root.unmount());host.remove();});
const render = () => act(() => root.render(React.createElement(Harness)));
const input = () => host.querySelector<HTMLInputElement>('input.telop')!;
const type = (text: string) => act(() => {
  const el = input();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', {bubbles: true}));
});
it.each([0, 1, 2])('テロップ %s を0文字にしても選択・入力欄・フォーカスを保ち、その場で入力し直せる', group => {
  render();act(() => model.setSelection({kind: 'telop', group}));
  const el = input();act(() => el.focus());type('');
  expect(model.selection).toEqual({kind: 'telop', group});expect(input()).toBe(el);expect(document.activeElement).toBe(el);expect(el.value).toBe('');
  expect(host.textContent).toContain('0/13');
  expect(model.cuts!.cuts[group].main).toEqual({text: '', orientation: 'horizontal'});
  expect(ReelDataSchema.parse(JSON.parse(JSON.stringify(model.cuts))).cuts[group].main?.text).toBe('');
  type('変更した文言');
  expect(el.value).toBe('変更した文言');expect(model.cuts!.cuts[group].main?.text).toBe('変更した文言');
  expect(model.cuts!.cuts.filter((_, i) => i !== group).map(c => c.main?.text)).toEqual(initial.cuts.filter((_, i) => i !== group).map(c => c.main?.text));
  expect(history.push).toHaveBeenCalledOnce();
});
it('複数カットのグループも空の枠と範囲を保持して、まとめて書き直せる', () => {
  initial.cuts.splice(2, 0, cut(4, '本編'));
  render();act(() => model.setSelection({kind: 'telop', group: 1}));type('');
  expect(model.groups[1].cutIndices).toEqual([1, 2]);
  expect(telopBlocks(model.cuts!, 100, model.groups).filter(b => b.kind === 'group').map(b => b.cutIndices)).toEqual([[0], [1, 2], [3]]);
  type('新しい本編');expect(model.cuts!.cuts.map(c => c.main?.text)).toEqual(['最初', '新しい本編', '新しい本編', '最後']);
});
it('隣も空文字の場合や同じ文言を入力した場合も結合せず、入力対象を取り違えない', () => {
  initial.cuts[0].main!.text = '';
  render();act(() => model.setSelection({kind: 'telop', group: 1}));
  type('');expect(model.groups[1].cutIndices).toEqual([1]);expect(input().value).toBe('');
  type('最後');expect(model.groups[1].cutIndices).toEqual([1]);
  type('変更');expect(model.cuts!.cuts.map(c => c.main?.text)).toEqual(['', '変更', '最後']);
});
it('空文字の結合で番号が変わっても、次にクリックしたグループを正しく選ぶ', () => {
  initial.cuts[0].main!.text = '';
  render();act(() => model.setSelection({kind: 'telop', group: 1}));type('');
  act(() => model.setSelection({kind: 'telop', group: 2}));
  expect(input().value).toBe('最後');type('締め');expect(model.cuts!.cuts.map(c => c.main?.text)).toEqual(['', '', '締め']);
});
it('「テロップを外す」は明示的に削除し、次のテロップへ選択を移さない', () => {
  render();act(() => model.setSelection({kind: 'telop', group: 1}));
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'テロップを外す')!.click());
  expect(model.cuts!.cuts[1].main).toBeUndefined();expect(model.selection).toBeNull();expect(model.cuts!.cuts[2].main?.text).toBe('最後');
});
it('映像カットの文言欄でも0文字にした後の向きとフォーカスを保つ', () => {
  render();act(() => model.setSelection({kind: 'cut', index: 1}));
  const el = input();act(() => el.focus());type('');type('編集後');
  expect(input()).toBe(el);expect(document.activeElement).toBe(el);
  expect(model.cuts!.cuts[1].main).toEqual({text: '編集後', orientation: 'horizontal'});
});
it('ロック中の尺合わせボタンは現在の順番と本数を保持し、取り消し用の状態を1回積む', () => {
  initial.meta = {orderLocked: true};initial.cuts.reverse();
  initialNarration = {voice: 'v', segments: [{id: 'n1', at: 0, text: 'あ', durSec: 2.7}]};
  render();
  const fit = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('ナレーション音声に尺を合わせる'))!;
  expect(fit.title).toContain('並び順・素材・本数');act(() => fit.click());
  expect(model.cuts!.cuts.map(c => c.id)).toEqual(['c3', 'c2', 'c1']);
  expect(model.cuts!.cuts.map(c => c.src)).toEqual(initial.cuts.map(c => c.src));expect(model.cuts!.meta?.orderLocked).toBe(true);
  expect(history.push).toHaveBeenCalledOnce();
});
