import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, expect, it} from 'vitest';
import {preflight} from '../core/render';
import {studioConfig} from '../studio.config';

let projectDir: string;
const base = {fps: 30, cuts: [{id: 'c01', src: 'grid.mp4', inSec: 0, outSec: 23 / 30}]};
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-preflight-'));
  fs.cpSync(path.join(studioConfig.templateDir, 'src'), path.join(projectDir, 'src'), {recursive: true});
  fs.mkdirSync(path.join(projectDir, 'node_modules', '@remotion', 'cli'), {recursive: true});
  fs.writeFileSync(path.join(projectDir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), '');
  fs.mkdirSync(path.join(projectDir, 'public'), {recursive: true});
  fs.writeFileSync(path.join(projectDir, 'public', 'grid.mp4'), '');
  fs.writeFileSync(path.join(projectDir, 'cuts.json'), JSON.stringify(base));
});
it('CLIプリセットを実際のレンダーデータへ適用し、元cutsは保持する', () => {
  const pf = preflight({projectDir, zoomPreset: 'viral_zoom'});
  expect(pf.cuts.cuts[0].zoom?.scale_end).toBe(1.45);
  expect(JSON.parse(fs.readFileSync(path.join(projectDir, 'cuts.json'), 'utf8'))).toEqual(base);
});
it('個別JSON設定を優先し、未知のキーとプリセットは拒否する', () => {
  const zoomConfig = path.join(projectDir, 'zoom.json');
  fs.writeFileSync(zoomConfig, JSON.stringify({cuts: {c01: {mode: 'pull'}}}));
  expect(preflight({projectDir, zoomPreset: 'viral_zoom', zoomConfig}).cuts.cuts[0].zoom?.scale_start).toBe(1.2);
  expect(() => preflight({projectDir, zoomPreset: 'typo'})).toThrow();
  fs.writeFileSync(zoomConfig, JSON.stringify({cuts: {typo: {mode: 'push'}}}));
  expect(() => preflight({projectDir, zoomConfig})).toThrow('typo');
});
it('--propsの尺と設定を検証対象にし、プロジェクト側のcutsは保持する', () => {
  const props = path.join(projectDir, 'alternate.json');
  fs.writeFileSync(props, JSON.stringify({...base, cuts: [{...base.cuts[0], outSec: 11 / 30}]}));
  const pf = preflight({projectDir, props, zoomPreset: 'viral_zoom'});
  expect(pf.validation.summary.totalFrames).toBe(11);
  expect(pf.cuts.cuts[0].zoom?.scale_end).toBe(1.45);
  expect(JSON.parse(fs.readFileSync(path.join(projectDir, 'cuts.json'), 'utf8'))).toEqual(base);
});
it('alias適用で保存するときも一時ズームプリセットをcuts.jsonへ書き込まない', () => {
  fs.writeFileSync(path.join(projectDir, 'cuts.json'), JSON.stringify({...base, meta: {aliases: [{from: 'grid.mp4', to: 'alias.mp4'}]}}));
  preflight({projectDir, zoomPreset: 'viral_zoom', allowErrors: true});
  const saved = JSON.parse(fs.readFileSync(path.join(projectDir, 'cuts.json'), 'utf8'));
  expect(saved.cuts[0].zoom).toBeUndefined();
  expect(saved.meta.aliases[0].applied).toBe(true);
  expect(fs.existsSync(path.join(projectDir, 'public', 'alias.mp4'))).toBe(true);
});
