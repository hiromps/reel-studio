// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ProjectScriptSkill} from '../src/components/ProjectScriptSkill';
import {ScriptCard} from '../src/components/ScriptCard';
import {TriageMode} from '../src/components/TriageMode';
import {SettingsPage} from '../src/pages/Settings';
import {settingsView} from '../core/settings';
import {BriefSchema} from '../shared/schema/brief';
import {makeBrief, makeCatalog, makeClip} from './helpers';
import type {ScriptSkillEntry} from '../shared/script-skill';

const mocks = vi.hoisted(() => ({store: null as any, get: vi.fn(), post: vi.fn(), reload: vi.fn()}));
vi.mock('../src/state/store', () => ({useStudio: () => mocks.store}));
vi.mock('../src/api', () => ({api: {get: mocks.get, post: mocks.post}}));
vi.mock('../src/components/ClipEditor', () => ({ClipEditor: () => React.createElement('div', {className: 'review-video', 'data-testid': 'clip-editor'}, '素材プレビュー')}));
vi.mock('../src/components/NotificationsCard', () => ({NotificationsCard: () => null}));
vi.mock('../src/components/UpdateCard', () => ({UpdateCard: () => null}));
vi.mock('../src/components/MosaicPanel', () => ({useMosaicStatus: () => ({status: null, error: null, reload: mocks.reload})}));

const skillA: ScriptSkillEntry = {id: 'lunch', fileName: 'SKILL.md', content: '---\nname: 定食の魅力を伝える\ndescription: 料理の全景と品数から、行きたくなる理由をつなぐ台本\n---\n具体的な約束を映像で示す', enabled: true};
const skillB: ScriptSkillEntry = {...skillA, id: 'cafe', content: '---\nname: カフェを紹介する\n---\n紅茶の提供から始める'};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  const brief = makeBrief({persona: 'standard'});
  const catalog = makeCatalog('test', [makeClip({id: '01', slug: 'plate', dur: 5, kind: 'serving'})]);
  mocks.store = {active: 'test', jobs: [], projects: [], personas: [], config: {scriptSkills: {entries: [skillA, skillB], defaultSkill: skillA}},
    files: {brief: {data: brief, dirty: false}, catalog: {data: catalog, dirty: false}, cuts: {data: null}, narration: {data: null}},
    supportsJob: () => true, toast: vi.fn(), reloadConfig: vi.fn(async () => {}), refreshProjects: vi.fn(async () => {}),
    saveFile: vi.fn(async () => true), addJob: vi.fn(async () => ({id: 'job-1'})), setFile: vi.fn((key, value) => {mocks.store.files[key] = {data: value, dirty: true};}),
  };
  mocks.get.mockImplementation(async (url) => ({data: url.endsWith('/script/plan') ? {data: null} : url.endsWith('/script') ? {data: null, sections: []} : {voices: []}}));
  mocks.post.mockResolvedValue({data: {provider: 'codex', models: [{id: 'gpt-test', label: 'GPT Test'}]}});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();});
const render = async (component: React.ReactElement) => {await act(async () => root.render(component));};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
const choose = async (value: string) => {await act(async () => {const select = host.querySelector('select')!; select.value = value; select.dispatchEvent(new Event('change', {bubbles: true}));});};

function captureFixture(name: string) {
  const dir = process.env.REEL_UI_REVIEW_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, {recursive: true});
  const css = ['styles.css', 'beginner.css'].map((file) => `<link rel="stylesheet" href="${pathToFileURL(path.resolve('src', file)).href}">`).join('');
  for (const select of host.querySelectorAll('select')) for (const option of select.options) option.toggleAttribute('selected', option.selected);
  fs.writeFileSync(path.join(dir, name + '.html'), `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}<style>body{min-width:0}.review-video{background:var(--panel2);display:grid;place-items:center;min-height:360px;border-radius:12px;color:var(--fg)}</style></head><body><main class="main">${host.innerHTML}</main></body></html>`);
}

it('案件ごとに選択と不使用を切り替え、保存済みの本文を登録元の削除後も表示する', async () => {
  await render(React.createElement(ProjectScriptSkill));
  await choose('cafe');
  expect(mocks.store.files.brief.data.scriptSkill).toEqual(skillB);
  await render(React.createElement(ProjectScriptSkill));
  expect(host.textContent).toContain('カフェを紹介する');
  const saved = BriefSchema.parse(JSON.parse(JSON.stringify(mocks.store.files.brief.data)));
  mocks.store.config.scriptSkills = {entries: [skillA], defaultSkill: skillA};
  mocks.store.files.brief = {data: saved, dirty: false};
  await render(React.createElement(ProjectScriptSkill));
  expect((host.querySelector('select') as HTMLSelectElement).value).toBe('__snapshot');
  expect(host.textContent).toContain('紅茶の提供から始める');
  captureFixture('project-skill');
  await choose('__none');
  expect(mocks.store.files.brief.data.scriptSkill).toBeNull();
  await render(React.createElement(ProjectScriptSkill));
  expect(host.querySelector('.skill-status')?.textContent).toContain('使わない');
  await choose('__default');
  expect(mocks.store.files.brief.data.scriptSkill).toBeUndefined();
  mocks.store.files.brief = {data: makeBrief({persona: 'standard'}), dirty: false};
  await render(React.createElement(ProjectScriptSkill));
  expect(host.querySelector('.skill-status')?.textContent).toContain('定食の魅力を伝える');
});

it('AI生成前に案件のスキル選択を保存し、保存に失敗したら生成しない', async () => {
  mocks.store.files.brief.data.scriptSkill = skillB;
  mocks.store.files.brief.dirty = true;
  localStorage.setItem('reel-studio:script-request:test', '料理の魅力を伝えて');
  const card = React.createElement(ScriptCard, {aiModel: 'test', onModel: () => {}});
  await render(card);
  expect(host.querySelector('.skill-status')?.textContent).toContain('カフェを紹介する');
  captureFixture('script-create');
  mocks.store.saveFile.mockResolvedValueOnce(false);
  await act(async () => button('AIで台本を作る').click());
  expect(mocks.store.addJob).not.toHaveBeenCalled();
  await act(async () => button('AIで台本を作る').click());
  expect(mocks.store.saveFile).toHaveBeenCalledWith('brief');
  expect(mocks.store.saveFile.mock.invocationCallOrder[1]).toBeLessThan(mocks.store.addJob.mock.invocationCallOrder[0]);
  expect(mocks.store.addJob).toHaveBeenCalledWith('ai-script-draft', {model: 'test', request: '料理の魅力を伝えて'});
});

it('選別の3ボタンを映像より上に置き、フックの状態表示と必要・不要の判定を維持する', async () => {
  const clips = [makeClip({id: '01', slug: 'plate', dur: 5, kind: 'serving'}), makeClip({id: '02', slug: 'cake', dur: 4, kind: 'eating'})];
  const onDecide = vi.fn();
  const props = {clips, mediaBase: '', onDecide, onUpdate: vi.fn(), onUndo: vi.fn(), canUndo: false, onClose: vi.fn()};
  await render(React.createElement(TriageMode, props));
  const actions = host.querySelector('.triage-actions')!;
  const editor = host.querySelector('[data-testid=clip-editor]')!;
  expect(actions.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(actions.closest('.modal-body')).toBeNull();
  await act(async () => button('フック候補').click());
  expect(onDecide).toHaveBeenLastCalledWith('01', {hook: true});
  clips[0] = {...clips[0], user: {...clips[0].user, hook: true}};
  await render(React.createElement(TriageMode, props));
  expect(button('フック候補').getAttribute('aria-pressed')).toBe('true');
  captureFixture('triage');
  await act(async () => button('必要K').click());
  expect(onDecide).toHaveBeenLastCalledWith('01', {ng: false});
  await act(async () => button('不要X').click());
  expect(onDecide).toHaveBeenLastCalledWith('02', {ng: true});
  expect(host.textContent).toContain('2 本を判定しました');
});

it('設定はAIとスキルを先頭に表示し、音声・保存先・詳細は閉じて必要な時に開ける', async () => {
  const view = settingsView({bin: 'claude', available: false, source: 'none', version: null}, 'template');
  view.settings.agent.provider = 'codex'; view.settings.scriptSkills = [skillA, skillB]; view.settings.scriptSkill = skillA;
  mocks.get.mockImplementation(async (url) => ({data: url === '/api/settings' ? view : {voices: []}}));
  await render(React.createElement(SettingsPage, {onCreate: () => {}}));
  const page = host.querySelector('[data-tour=settings]')!;
  const topCards = [...page.children].filter((el) => el.tagName === 'SECTION');
  expect(topCards).toHaveLength(2);
  expect(topCards[0].textContent).toContain('使うAIを選ぶ');
  expect(topCards[1].textContent).toContain('AIの台本スキル');
  const groups = [...host.querySelectorAll<HTMLDetailsElement>('.settings-section')];
  expect(groups).toHaveLength(5);
  expect(groups.some(group => group.textContent?.includes('Modal Cloud GPU'))).toBe(true);
  expect(groups.every((group) => !group.open)).toBe(true);
  expect(host.querySelector<HTMLDetailsElement>('.beginner-details')!.open).toBe(false);
  const audioGroup = groups.find(group => group.querySelector('summary')?.textContent?.includes('音声・話し方'))!;
  act(() => {audioGroup.open = true;});
  expect(audioGroup.textContent).toContain('音声生成');
  act(() => {audioGroup.open = false;});
  captureFixture('settings');
});
