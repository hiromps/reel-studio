import {afterAll, afterEach, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {enforceStyleData, globalStylePrompt, learnStyleRules, loadStyleRules, shouldLearnStyleInstruction} from '../core/style-memory';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-style-test-'));
const previousHome = process.env.REEL_STUDIO_HOME;
process.env.REEL_STUDIO_HOME = dir;

afterEach(() => { fs.rmSync(path.join(dir, 'style-memory.json'), {force: true}); });
afterAll(() => {
  if (previousHome === undefined) delete process.env.REEL_STUDIO_HOME;
  else process.env.REEL_STUDIO_HOME = previousHome;
  fs.rmSync(dir, {recursive: true, force: true});
});

it('共通ルールを案件をまたいで保存し、同じ指示は重複させない', () => {
  expect(learnStyleRules(['大げさな断言を避ける', '大げさな断言を避ける'])).toHaveLength(1);
  expect(loadStyleRules().map((r) => r.text)).toEqual(['大げさな断言を避ける']);
  expect(globalStylePrompt()).toContain('大げさな断言を避ける');
  expect(globalStylePrompt()).toContain('やで');
  expect(globalStylePrompt()).toContain('体言止め');
});

it('全体に通用する文体の注意だけを学習候補にする', () => {
  expect(shouldLearnStyleInstruction('○○やでという語尾はやめてください')).toBe(true);
  expect(shouldLearnStyleInstruction('この動画では価格を表示しないで')).toBe(false);
  expect(shouldLearnStyleInstruction('テロップをナレーションに合わせて')).toBe(false);
});

it('生成結果のテロップとナレーションだけから禁止語尾を除く', () => {
  const input = {sections: [{telop: '最高やで', narration: 'いい店です。', why: 'やでを避ける'}], telops: ['うどんやで', '麺まであるで', 'うまさが段違いです'], summary: 'やでを避ける'};
  const output = enforceStyleData(input);
  expect(output.sections[0]).toMatchObject({telop: '最高', narration: 'いい店。', why: 'やでを避ける'});
  expect(output.telops).toEqual(['うどん', '麺まである', 'うまさが段違い']);
  expect(output.summary).toBe('やでを避ける');
});
