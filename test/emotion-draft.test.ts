import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
const mock = vi.hoisted(() => ({agent: vi.fn()}));
vi.mock('../core/agent', () => ({runAgent: mock.agent}));
import {draftReelSpeech} from '../core/reel-speech-draft';
import {aiScriptDraft} from '../core/script-draft';
import {defaultEmotionTags} from '../shared/emotion-tags';
import {createReelCut, defaultReelCutsConfig} from '../shared/reel-cuts';
import {readReelCuts, writeReelCuts} from '../core/reel-cuts';
import {makeBrief, makeCatalog} from './helpers';
let root: string; let dir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-draft-')); dir = path.join(root, 'work', 'food');
  vi.stubEnv('REEL_STUDIO_DATA_ROOT', root);
  fs.mkdirSync(path.join(dir, 'public', 'uploads'), {recursive: true}); fs.writeFileSync(path.join(dir, 'public', 'uploads', 'dish.mp4'), 'video');
  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(makeBrief({persona: 'standard'})));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(makeCatalog('food', [])));
  writeReelCuts(dir, [createReelCut('uploads/dish.mp4', defaultReelCutsConfig(), {id: 'peak', slot: 'sizzle'}), createReelCut('uploads/dish.mp4', defaultReelCutsConfig(), {id: 'end', slot: 'interior'})]);
  mock.agent.mockResolvedValue({data: {cuts: [{id: 'peak', line: 'お肉がじゅわっと広がります', emotion_tag: 'excited'}, {id: 'end', line: 'ゆっくり味わってください', emotion_tag: 'calm'}], notes: 'ピークから余韻へ'}, costUsd: 0.01});
});
afterEach(() => {vi.unstubAllEnvs(); fs.rmSync(root, {recursive: true, force: true});});
it('uses runtime IDs as the generation enum and saves line and emotion against stable cut IDs', async () => {
  const result = await draftReelSpeech(dir, {request: 'シズルを山場に'});
  const args = mock.agent.mock.calls.at(-1)![0];
  expect(args.schema.properties.cuts.items.properties.emotion_tag.enum).toEqual(defaultEmotionTags().tags.map(t => t.id));
  expect(args.prompt).toContain('sizzle/eating/self_eat'); expect(args.prompt).toContain('interior/exterior');
  expect(readReelCuts(dir)?.map(c => c.emotion_tag)).toEqual(['excited', 'calm']);
  expect(result.cuts.map(c => c.duration)).toEqual([2, 2]);
});
it('supports the existing script-generator entry point for canonical cuts', async () => {
  const result = await aiScriptDraft(dir, {request: '食べたくなる台本', assemble: true});
  expect(result.scriptFile).toBe(path.join(dir, 'reel-cuts.json')); expect(result.plan.sections).toHaveLength(2);
  expect(result.script).toContain('reel-cut:peak');
});
it('rejects unlisted IDs and never writes a partial or reordered AI result', async () => {
  const before = readReelCuts(dir);
  mock.agent.mockResolvedValueOnce({data: {cuts: [{id: 'peak', line: '文', emotion_tag: 'made-up'}], notes: ''}, costUsd: 0});
  await expect(draftReelSpeech(dir, {})).rejects.toThrow(); expect(readReelCuts(dir)).toEqual(before);
  mock.agent.mockResolvedValueOnce({data: {cuts: [{id: 'end', line: '文', emotion_tag: 'calm'}, {id: 'peak', line: '文', emotion_tag: 'excited'}], notes: ''}, costUsd: 0});
  await expect(draftReelSpeech(dir, {})).rejects.toThrow('順序'); expect(readReelCuts(dir)).toEqual(before);
});
