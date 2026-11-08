// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {ScriptSkillCard} from '../src/components/ScriptSkillCard';
import {SCRIPT_SKILL_MAX_BYTES, type ScriptSkill, type ScriptSkillEntry} from '../shared/script-skill';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const skill: ScriptSkill = {fileName: 'SKILL.md', content: '---\nname: oc-eat-reel-script\ndescription: 関西グルメの台本\n---\n# 台本\n約束から証拠へ', enabled: true};
const mounted: Array<{root: ReturnType<typeof createRoot>; host: HTMLElement}> = [];
afterEach(() => {for (const {root, host} of mounted.splice(0)) {act(() => root.unmount()); host.remove();}});

async function setup(initial?: ScriptSkill) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); mounted.push({root, host});
  let stored = initial;
  let skills: ScriptSkillEntry[] | undefined;
  const save = vi.fn(async (patch) => {if ('scriptSkill' in patch) stored = patch.scriptSkill ?? undefined; if ('scriptSkills' in patch) skills = patch.scriptSkills; await render(); return true;});
  const render = async () => {await act(async () => root.render(React.createElement(ScriptSkillCard, {skill: stored, skills, save})));};
  await render();
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const select = async (file: Pick<File, 'name' | 'size' | 'text'>) => {
    const input = host.querySelector('input[type=file]')!;
    Object.defineProperty(input, 'files', {configurable: true, value: [file]});
    await act(async () => input.dispatchEvent(new Event('change', {bubbles: true})));
  };
  return {host, save, render, button, select};
}
const file = (content = skill.content, name = 'SKILL.md') => ({name, size: new TextEncoder().encode(content).length, text: async () => content});

it('複数のスキルを追加して選べ、置き換えや削除で他の登録を消さない', async () => {
  const {host, save, render, button, select} = await setup(skill);
  const second = '# カフェ専用\n提供シーンから始める';
  await select(file(second));
  await act(async () => button('このスキルを追加').click()); await render();
  const added = save.mock.calls[0][0].scriptSkills;
  expect(added).toHaveLength(2);
  expect(added[0]).toMatchObject(skill);
  expect(added[1].content).toBe(second);
  expect(save.mock.calls[0][0]).not.toHaveProperty('scriptSkill');
  const choose = async (id: string) => {await act(async () => {const menu = host.querySelector('select')!; menu.value = id; menu.dispatchEvent(new Event('change', {bubbles: true}));});};
  await choose(added[1].id);
  await select(file('# 改良版\n断面を見せる'));
  await act(async () => button('選択中のスキルと置き換える').click()); await render();
  expect(save.mock.lastCall![0].scriptSkills[0].content).toBe(skill.content);
  expect(save.mock.lastCall![0].scriptSkills[1]).toMatchObject({id: added[1].id, content: '# 改良版\n断面を見せる'});
  await choose(added[1].id);
  await act(async () => button('スキルを削除').click()); await render();
  expect(save.mock.lastCall![0].scriptSkills).toEqual([added[0]]);
  expect(save.mock.lastCall![0]).not.toHaveProperty('scriptSkill');
});

it('読み込んだ内容を確認して保存し、有効・無効と削除を切り替える', async () => {
  const {host, save, render, button, select} = await setup();
  expect(host.textContent).toContain('未設定');
  await select(file());
  expect(host.textContent).toContain('oc-eat-reel-script');
  expect(host.textContent).toContain('関西グルメの台本');
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe(skill.content);
  expect(save).not.toHaveBeenCalled();
  await act(async () => button('このスキルを追加').click()); await render();
  expect(save).toHaveBeenLastCalledWith({scriptSkill: skill, scriptSkills: [{...skill, id: expect.any(String)}]}, expect.any(String));
  await act(async () => button('無効にする').click()); await render();
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({scriptSkill: {...skill, enabled: false}}), expect.any(String));
  await act(async () => button('有効にする').click()); await render();
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({scriptSkill: skill}), expect.any(String));
  await act(async () => button('スキルを削除').click()); await render();
  expect(save).toHaveBeenLastCalledWith({scriptSkill: null, scriptSkills: []}, expect.any(String));
  expect(host.textContent).toContain('未設定');
});

it('置き換えを取り消すと既存スキルを保持し、無効なアップロードでも保存を行わない', async () => {
  const {host, save, button, select} = await setup(skill);
  await select(file('# 別スキル\n別のルール'));
  await act(async () => button('取り消す').click());
  expect(host.textContent).toContain('oc-eat-reel-script');
  for (const invalid of [file('', 'SKILL.md'), file('binary', 'skill.exe'), {...file(), size: SCRIPT_SKILL_MAX_BYTES + 1}, {...file(), text: async () => {throw new Error('読み込みに失敗');}}]) {
    await select(invalid);
    expect(host.querySelector('[role=alert]')).not.toBeNull();
    expect(host.textContent).toContain('oc-eat-reel-script');
  }
  expect(save).not.toHaveBeenCalled();
});

it('保存中は操作を止め、保存に失敗しても選んだ内容を残して再試行できる', async () => {
  const {host, save, button, select} = await setup();
  await select(file());
  let resolve!: (value: boolean) => void;
  save.mockImplementationOnce(() => new Promise<boolean>((r) => {resolve = r;}));
  act(() => button('このスキルを追加').click());
  expect(button('このスキルを追加').disabled).toBe(true);
  expect((host.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  await act(async () => resolve(false));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('保存できません');
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe(skill.content);
  await act(async () => button('このスキルを追加').click());
  expect(save).toHaveBeenCalledTimes(2);
});

it('登録済みスキルの名前を変えると、一覧と既定の両方が新しい名前になり、同名の警告が消える', async () => {
  const {host, save, render, button, select} = await setup(skill);
  await select(file(skill.content.replace('関西グルメの台本', 'azu の台本')));
  await act(async () => button('このスキルを追加').click()); await render();
  const added = save.mock.lastCall![0].scriptSkills;
  expect(host.textContent).toContain('同じ名前のスキルがほかにもあります');
  const options = () => [...host.querySelectorAll('option')].map((o) => o.textContent);
  expect(options()).toEqual(['oc-eat-reel-script（関西グルメの台本）（既定）', 'oc-eat-reel-script（azu の台本）']);
  await act(async () => {const menu = host.querySelector('select')!; menu.value = added[1].id; menu.dispatchEvent(new Event('change', {bubbles: true}));});
  const name = host.querySelector('input[aria-label="スキルの名前"]') as HTMLInputElement;
  expect(name.value).toBe('oc-eat-reel-script');
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Azu'); name.dispatchEvent(new Event('input', {bubbles: true}));});
  await act(async () => button('名前を変更').click()); await render();
  const renamed = save.mock.lastCall![0];
  expect(renamed).not.toHaveProperty('scriptSkill');
  expect(renamed.scriptSkills[0]).toEqual(added[0]);
  expect(renamed.scriptSkills[1]).toMatchObject({id: added[1].id, content: expect.stringContaining('name: Azu\n')});
  expect(options()).toEqual(['oc-eat-reel-script（既定）', 'Azu']);
  expect(host.textContent).not.toContain('同じ名前のスキルがほかにもあります');
  // 既定のスキルの名前を変えると、既定の写しも一緒に変わる
  await act(async () => {const menu = host.querySelector('select')!; menu.value = added[0].id; menu.dispatchEvent(new Event('change', {bubbles: true}));});
  const first = host.querySelector('input[aria-label="スキルの名前"]') as HTMLInputElement;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(first, 'oc.eat'); first.dispatchEvent(new Event('input', {bubbles: true}));});
  await act(async () => button('名前を変更').click()); await render();
  expect(save.mock.lastCall![0].scriptSkill.content).toContain('name: oc.eat\n');
  expect(options()).toEqual(['oc.eat（既定）', 'Azu']);
});
