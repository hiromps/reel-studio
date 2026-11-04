import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SCRIPT_SKILL_MAX_BYTES, ScriptSkillSchema, ScriptSkillLibrarySchema, scriptSkillCatalog, resolveScriptSkill, scriptSkillInfo, scriptSkillPrompt} from '../shared/script-skill';
import {BriefSchema} from '../shared/schema/brief';
import {readBrief, writeBrief} from '../core/project';
import {SettingsPatchSchema} from '../shared/schema/settings';
import {defaultSettings, loadSettings, mergeSettings, resetSettings, saveSettings, settingsView} from '../core/settings';
import {aiScriptDraft} from '../core/script-draft';
import {makeBrief, makeCatalog, makeClip} from './helpers';

vi.mock('../core/agent', () => ({runAgent: vi.fn()}));
vi.mock('../core/look', () => ({ensureLooks: vi.fn(async () => 0)}));
import {runAgent} from '../core/agent';

const content = '---\nname: oc-eat-reel-script\ndescription: 関西グルメの台本を作る\n---\n\n# 台本\n具体的な約束 → 映像での証拠 → 行く場面\n価格は確認済みの事実だけ使う\n';
const skill = ScriptSkillSchema.parse({fileName: 'SKILL.md', content});
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.REEL_STUDIO_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-script-skill-'));
  process.env.REEL_STUDIO_HOME = home;
  resetSettings(); vi.clearAllMocks();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REEL_STUDIO_HOME; else process.env.REEL_STUDIO_HOME = previousHome;
  resetSettings(); fs.rmSync(home, {recursive: true, force: true});
});

describe('台本スキルの読み込み', () => {
  it('日本語・BOM・CRLF を読み込み、名前・説明・本文を表示用に取り出す', () => {
    const read = ScriptSkillSchema.parse({fileName: '台本.MD', content: '\uFEFF' + content.replace(/\n/g, '\r\n')});
    expect(read).toEqual({...skill, fileName: '台本.MD'});
    expect(scriptSkillInfo(read.content)).toMatchObject({name: 'oc-eat-reel-script', description: '関西グルメの台本を作る', body: expect.stringContaining('# 台本')});
    expect(scriptSkillInfo('---\nname: "food-reel"\ndescription: >\n  一つの動画を\n  一貫した台本にする\n---\n# 本文')).toMatchObject({name: 'food-reel', description: '一つの動画を 一貫した台本にする'});
    expect(scriptSkillInfo('# 独自ルール\n本文').name).toBe('独自ルール');
  });

  it.each([
    {fileName: '../SKILL.md', content},
    {fileName: 'skill.txt', content},
    {fileName: 'SKILL.md', content: '   '},
    {fileName: 'SKILL.md', content: '\0binary'},
    {fileName: 'SKILL.md', content: '\uFFFD文字化け'},
    {fileName: 'SKILL.md', content: '---\nname: unclosed'},
    {fileName: 'SKILL.md', content: '---\nname: empty\n---\n '},
    {fileName: 'SKILL.md', content: '---\n---\n '},
    {fileName: 'SKILL.md', content: 'あ'.repeat(Math.ceil(SCRIPT_SKILL_MAX_BYTES / 3))},
  ])('空・形式違い・不正な文字・サイズ超過を拒否する: $fileName', (input) => {
    expect(ScriptSkillSchema.safeParse(input).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({scriptSkill: input}).success).toBe(false);
  });

  it('保存後に元ファイルなしで復元でき、無関係な設定保存でも維持し、無効化・置換・削除できる', () => {
    saveSettings(mergeSettings(defaultSettings(), SettingsPatchSchema.parse({scriptSkill: skill})));
    resetSettings();
    expect(loadSettings().scriptSkill).toEqual(skill);
    saveSettings(mergeSettings(loadSettings(), {agent: {model: 'sonnet'}}));
    expect(loadSettings().scriptSkill).toEqual(skill);
    const view = settingsView({bin: '', available: false, source: 'none', version: null}, '');
    expect(view.settings.scriptSkill).toEqual(skill);
    saveSettings(mergeSettings(loadSettings(), {scriptSkill: {...skill, enabled: false}}));
    resetSettings();
    expect(loadSettings().scriptSkill?.enabled).toBe(false);
    expect(scriptSkillPrompt(loadSettings().scriptSkill)).toBe('');
    saveSettings(mergeSettings(loadSettings(), {scriptSkill: {...skill, content: '# 新しい台本\n新しい本文'}}));
    expect(loadSettings().scriptSkill?.content).toContain('新しい本文');
    saveSettings(mergeSettings(loadSettings(), {scriptSkill: null}));
    resetSettings();
    expect(loadSettings().scriptSkill).toBeUndefined();
    expect(loadSettings().agent.model).toBe('sonnet');
  });
});

it('有効なスキルを生成へ渡し、無効化・削除後は従来のテンポと字幕ルールに戻る', async () => {
  const dir = path.join(home, 'project'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(makeCatalog('skill-test', [makeClip({id: '01', slug: 'plate', dur: 5, kind: 'serving'})])));
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard', targetSec: 4})));
  vi.mocked(runAgent).mockImplementation(async () => ({data: {sections: [{fromSec: 0, toSec: 4, label: '約束と証拠', video: '料理 id 01', cutCount: 2, cutSec: '2', telop: 'この一皿を楽しむ', narration: '', why: '主役を見せる'}], notes: '行く場面へつなぐ', unmatched: []}, costUsd: 0.01}) as any);
  saveSettings(mergeSettings(defaultSettings(), {scriptSkill: skill}));
  const log = vi.fn();
  await aiScriptDraft(dir, {request: '料理の魅力を伝えて', onLine: log});
  const prompt = vi.mocked(runAgent).mock.calls[0][0].prompt;
  expect(prompt).toContain(content);
  expect(prompt).toContain('今回の依頼・確定した案件情報・事実確認を優先');
  expect(prompt).toContain('リンク先の references 等は提供されていない');
  expect(prompt).toContain('指定の JSON スキーマ');
  expect(prompt).not.toContain('1 カット 0.7〜0.8 秒');
  expect(prompt).not.toContain('金額なし・保存やいいねを促さない');
  expect(prompt).not.toContain('フックの型: 「エリア＋一桁数字」');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('台本スキルを適用: SKILL.md（oc-eat-reel-script / 設定の既定）'));
  expect(fs.readFileSync(path.join(dir, 'script.md'), 'utf8')).toContain('この一皿を楽しむ');
  for (const next of [{...skill, enabled: false}, null]) {
    saveSettings(mergeSettings(loadSettings(), {scriptSkill: next}));
    await aiScriptDraft(dir, {request: '料理の魅力を伝えて'});
    const fallback = vi.mocked(runAgent).mock.lastCall![0].prompt;
    expect(fallback).not.toContain(content);
    expect(fallback).toContain('1 カット 0.7〜0.8 秒');
    expect(fallback).toContain('金額なし・保存やいいねを促さない');
  }
});

it('複数スキルと旧設定を保持し、IDの重複や登録数の超過を拒否する', () => {
  const first = {...skill, id: 'first'};
  const second = {...skill, content: '# 別のスキル\n短い言葉で書く', id: 'second'};
  saveSettings(mergeSettings(defaultSettings(), {scriptSkill: skill, scriptSkills: [first, second]}));
  saveSettings(mergeSettings(loadSettings(), {tts: {modelId: 's1'}})); resetSettings();
  expect(scriptSkillCatalog(loadSettings()).entries).toEqual([first, second]);
  expect(scriptSkillCatalog({scriptSkill: skill}).entries).toEqual([{...skill, id: 'legacy-default'}]);
  expect(ScriptSkillLibrarySchema.safeParse([first, first]).success).toBe(false);
  expect(ScriptSkillLibrarySchema.safeParse(Array.from({length: 21}, (_, i) => ({...first, id: String(i)}))).success).toBe(false);
});

it('案件ごとの選択・不使用・既定の区別を保存し、登録元の削除や変更で選択済み本文を変えない', () => {
  const selected = {...skill, content: '# 案件専用\n価格は証拠と同時に表示する', id: 'project-skill'};
  const a = BriefSchema.parse({...makeBrief({persona: 'standard'}), scriptSkill: selected});
  const b = BriefSchema.parse({...makeBrief({persona: 'standard'}), scriptSkill: null});
  const c = BriefSchema.parse(makeBrief({persona: 'standard'}));
  for (const [key, brief] of [['a', a], ['b', b], ['c', c]] as const) {fs.mkdirSync(path.join(home, key)); writeBrief(path.join(home, key), brief);}
  const settings = {scriptSkill: skill, scriptSkills: [{...selected, content: '# 新しい登録内容\n短くする'}]};
  expect(resolveScriptSkill(readBrief(path.join(home, 'a'))!, settings)?.content).toBe(selected.content);
  expect(resolveScriptSkill(readBrief(path.join(home, 'b'))!, settings)).toBeUndefined();
  expect(resolveScriptSkill(readBrief(path.join(home, 'c'))!, settings)).toEqual(skill);
  expect(resolveScriptSkill(a, {scriptSkills: []})).toEqual(selected);
  expect(a.scriptSkill?.content).toBe(selected.content);
});

it('二つの案件で異なる台本スキルを生成へ渡し、使わない案件へ既定のスキルを混ぜない', async () => {
  saveSettings(mergeSettings(defaultSettings(), {scriptSkill: skill}));
  const selected = {...skill, id: 'cafe', content: '# カフェ専用\n紅茶の提供から始める'};
  const other = {...skill, id: 'lunch', content: '# ランチ専用\n品数とおかわりを見せる'};
  vi.mocked(runAgent).mockImplementation(async () => ({data: {sections: [{fromSec: 0, toSec: 4, label: '主役', video: '料理 id 01', cutCount: 2, cutSec: '2', telop: 'この一皿', narration: '', why: '魅力を示す'}], notes: '', unmatched: []}, costUsd: 0}) as any);
  for (const [key, selection] of [['cafe', selected], ['lunch', other], ['none', null]] as const) {
    const dir = path.join(home, key); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(makeCatalog(key, [makeClip({id: '01', slug: 'plate', dur: 5, kind: 'serving'})])));
    writeBrief(dir, BriefSchema.parse({...makeBrief({persona: 'standard', targetSec: 4}), scriptSkill: selection}));
    await aiScriptDraft(dir, {request: '魅力を伝えて'});
    const prompt = vi.mocked(runAgent).mock.lastCall![0].prompt;
    if (selection) expect(prompt).toContain(selection.content);
    else expect(prompt).not.toContain('設定で読み込んだ台本スキル');
    expect(prompt).not.toContain(content);
    if (selection === selected) expect(prompt).not.toContain(other.content);
    if (selection === other) expect(prompt).not.toContain(selected.content);
  }
});
