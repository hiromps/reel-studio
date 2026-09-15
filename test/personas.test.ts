import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BUILTIN_PERSONAS, defaultPersonaId, findPersona, getPersona, listPersonas, setPersonas} from '@shared/personas';
import {validateCuts} from '@shared/validate';
import {FORMAT_SPECS} from '@shared/format-specs';
import {ReelDataSchema} from '@shared/schema';
import {loadPersonasFromDisk, personasProblem, savePersonas} from '../core/personas-store';
import {personasFile, resetSettings} from '../core/settings';
import {TEST_PERSONAS, fixtures, makePersona, readJson} from './helpers';

afterEach(() => {
  // 他のテストが見る一覧をテスト用に戻す
  setPersonas(Object.values(TEST_PERSONAS));
});

describe('人格レジストリ', () => {
  it('setPersonas で一覧が丸ごと入れ替わり、find / get / default が引ける', () => {
    setPersonas([makePersona({id: 'alpha', label: 'A'}), makePersona({id: 'beta', label: 'B'})]);
    expect(listPersonas().map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(findPersona('beta')?.label).toBe('B');
    expect(findPersona('nope')).toBeUndefined();
    expect(getPersona('alpha').label).toBe('A');
    expect(defaultPersonaId()).toBe('alpha');
  });

  it('未登録の id は Settings を案内する例外', () => {
    expect(() => getPersona('ghost')).toThrow(/人格「ghost」が登録されていません.*Settings/);
  });

  it('id の形（英小文字で始まる・英数字とハイフン）を守らないと登録できない', () => {
    expect(() => setPersonas([makePersona({id: 'Bad Id'})])).toThrow();
    expect(() => setPersonas([makePersona({id: '9lives'})])).toThrow();
    expect(() => setPersonas([makePersona({id: 'ok-id-1'})])).not.toThrow();
  });

  it('hookStyle で「エリア名＋一桁数字」の検査（HOOK_TEXT_PATTERN）が切り替わる', () => {
    const cuts = ReelDataSchema.parse(readJson(path.join(fixtures, 'reunion-hiro.cuts.json')));
    // 先頭テロップを数字の無い文言にして、areaDigit の人格だけが指摘することを見る
    const first = cuts.cuts[0];
    if (first.main) first.main.text = 'まさかの紅茶専門店';
    const strict = validateCuts(cuts, {spec: FORMAT_SPECS.F7, persona: makePersona({id: 'strict', hookStyle: 'areaDigit'})});
    const free = validateCuts(cuts, {spec: FORMAT_SPECS.F7, persona: makePersona({id: 'free', hookStyle: 'free'})});
    expect(strict.warnings.some((i) => i.code === 'HOOK_TEXT_PATTERN')).toBe(true);
    expect(free.warnings.some((i) => i.code === 'HOOK_TEXT_PATTERN')).toBe(false);
  });
});

describe('personas.json', () => {
  let home: string;
  const useHome = () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-personas-'));
    process.env.REEL_STUDIO_HOME = home;
    resetSettings();
  };

  it('無ければ同梱のサンプルで seed され、レジストリにも入る', () => {
    useHome();
    const list = loadPersonasFromDisk();
    expect(fs.existsSync(personasFile())).toBe(true);
    expect(list.map((p) => p.id)).toEqual(BUILTIN_PERSONAS.map((p) => p.id));
    expect(listPersonas()).toHaveLength(BUILTIN_PERSONAS.length);
    expect(personasProblem()).toBeNull();
  });

  it('保存すると読み直せて、壊れたファイルは同梱の人格で動きつつ problem に残る', () => {
    useHome();
    loadPersonasFromDisk();
    savePersonas([makePersona({id: 'mine', label: '自分'})]);
    expect(loadPersonasFromDisk().map((p) => p.id)).toEqual(['mine']);
    fs.writeFileSync(personasFile(), '{broken');
    expect(loadPersonasFromDisk().map((p) => p.id)).toEqual(BUILTIN_PERSONAS.map((p) => p.id));
    expect(personasProblem()).toMatch(/読めません/);
    expect(() => savePersonas([])).toThrow();
  });
});
