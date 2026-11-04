import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {defaultEmotionTags, EmotionTagsSchema, emotionId, fishEmotionTag} from '../shared/emotion-tags';
import {loadEmotionTags} from '../core/emotion-tags';
import {createReelCut, defaultReelCutsConfig, reelFishText} from '../shared/reel-cuts';
import {readReelCuts, writeReelCuts} from '../core/reel-cuts';
import {readCuts, readNarration, writeCuts, writeNarration} from '../core/project';
import {generateTts, needsTtsIds, resetFishEnv} from '../core/tts';
import {generateEmotionAudition} from '../core/emotion-audition';
import {resetSettings} from '../core/settings';

vi.mock('../core/exec', () => ({execOk: async () => ({stdout: '1.2'}), exec: vi.fn()}));
let dir: string; let root: string; let bodies: any[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'emotion-test-')); dir = path.join(root, 'work', 'food');
  vi.stubEnv('REEL_STUDIO_DATA_ROOT', root); vi.stubEnv('FISH_API_KEY', 'test'); vi.stubEnv('FISH_MODEL_ID', 's2.1-pro'); resetSettings(); resetFishEnv();
  fs.mkdirSync(path.join(dir, 'public', 'uploads'), {recursive: true}); fs.writeFileSync(path.join(dir, 'public', 'uploads', 'dish.mp4'), 'video');
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(url).toMatch(/^https:\/\/api\.fish\.audio\//);
    if (init.method !== 'POST') return new Response('{}');
    bodies.push(JSON.parse(init.body as string));
    const wav = Buffer.alloc(64); wav.write('RIFF'); wav.write('WAVE', 8);
    return new Response(wav);
  }));
});
afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetSettings(); resetFishEnv(); fs.rmSync(root, {recursive: true, force: true});});
const cut = (id: string, emotion_tag: string | null = null) => createReelCut('uploads/dish.mp4', defaultReelCutsConfig(), {id, line: 'お肉のうまみが広がります', emotion_tag, intensity: 5});

it('loads all eight fixed choices and validates additions without a hardcoded ID enum', () => {
  const cfg = defaultEmotionTags(); expect(cfg.tags).toHaveLength(8);
  for (const tag of cfg.tags) expect(fishEmotionTag(tag.id, cfg)).toBe(tag.fish_tag);
  expect(emotionId('[excited]', cfg)).toBe('excited'); expect(emotionId('', cfg)).toBeNull();
  expect(() => fishEmotionTag('missing', cfg)).toThrow('emotion_tags.json');
  const file = path.join(root, 'emotion_tags.json'); vi.stubEnv('REEL_STUDIO_EMOTION_TAGS_CONFIG', file);
  cfg.tags.push({id: 'happy', label: 'よろこび', fish_tag: '[happy]', color: '#286050', note: '新しい固定タグ'});
  fs.writeFileSync(file, JSON.stringify(cfg)); expect(loadEmotionTags().tags.at(-1)?.id).toBe('happy');
  cfg.tags.at(-1)!.label = 'うれしい'; fs.writeFileSync(file, JSON.stringify(cfg)); expect(loadEmotionTags().tags.at(-1)?.label).toBe('うれしい');
  cfg.tags.push(cfg.tags[0]); expect(EmotionTagsSchema.safeParse(cfg).success).toBe(false);
});

it('explicit tags override intensity and none adds no markers or extra character count', () => {
  expect(reelFishText(cut('a', 'whispering'), defaultReelCutsConfig())).toBe('[whispering] お肉のうまみが広がります');
  expect(reelFishText(cut('a'), defaultReelCutsConfig())).toBe('お肉のうまみが広がります');
});

it('round-trips IDs and null through editor, narration and the canonical array', () => {
  writeReelCuts(dir, [cut('a', 'excited'), cut('b', 'calm')]);
  const editor = readCuts(dir); editor.cuts[0].emotion_tag = 'moved'; writeCuts(dir, editor);
  expect(readReelCuts(dir)?.[0].emotion_tag).toBe('moved');
  expect(readNarration(dir)?.segments[0].emotion_tag).toBe('moved');
  const narration = readNarration(dir)!; narration.segments[0].emotion_tag = null; writeNarration(dir, narration);
  expect(readReelCuts(dir)?.[0].emotion_tag).toBeNull(); expect(readCuts(dir).cuts[0].emotion_tag).toBeNull();
});

it('regenerates only the changed cut and invalidates only users of an edited tag definition', async () => {
  writeReelCuts(dir, [cut('a', 'excited'), cut('b', 'calm')]);
  const n = readNarration(dir)!; n.voice = 'test-emotion'; writeNarration(dir, n);
  expect((await generateTts(dir)).chars).toBe(2 * [...cut('a').line].length);
  expect(bodies.map(b => b.text)).toEqual(['[excited] お肉のうまみが広がります', '[calm] お肉のうまみが広がります']);
  expect((await generateTts(dir)).made).toEqual([]);
  const c = readReelCuts(dir)!; c[0].emotion_tag = 'surprised'; writeReelCuts(dir, c);
  expect((await generateTts(dir)).made).toEqual(['oc_a']);
  expect((await generateTts(dir)).made).toEqual([]);
  const cfg = defaultEmotionTags(); cfg.tags.find(t => t.id === 'calm')!.fish_tag = '[relaxed]';
  const file = path.join(root, 'emotion_tags.json'); fs.writeFileSync(file, JSON.stringify(cfg)); vi.stubEnv('REEL_STUDIO_EMOTION_TAGS_CONFIG', file);
  expect((await generateTts(dir)).made).toEqual(['oc_b']); expect(bodies.at(-1).text).toMatch(/^\[relaxed\]/);
});

it('saves all audition WAVs locally, reuses them and leaves the reel and its audio untouched', async () => {
  writeReelCuts(dir, [cut('a')]); const before = fs.readFileSync(path.join(dir, 'reel-cuts.json'), 'utf8');
  const first = await generateEmotionAudition(dir, {voice: 'test-emotion'});
  expect(first.samples).toHaveLength(8); expect(bodies).toHaveLength(8);
  for (const sample of first.samples) expect(fs.existsSync(path.join(dir, sample.file))).toBe(true);
  const again = await generateEmotionAudition(dir, {voice: 'test-emotion'});
  expect(again.samples.every(s => s.cached)).toBe(true); expect(bodies).toHaveLength(8);
  expect(fs.readFileSync(path.join(dir, 'reel-cuts.json'), 'utf8')).toBe(before);
  await expect(generateEmotionAudition(dir, {voice: 'test-emotion', text: '[custom] 音声'})).rejects.toThrow('タグ');
});

it('adds emotions to ordinary narration audio, regenerates one block and keeps unrelated local audio', async () => {
  writeNarration(dir, {voice: 'test-emotion', speed: 1, segments: [
    {id: 'first', at: 0, text: 'お肉のうまみが広がります', emotion_tag: 'excited', needsTts: true},
    {id: 'second', at: 2, text: 'お店も落ち着いています', durSec: 1.2},
  ]});
  fs.mkdirSync(path.join(dir, 'narration')); const other = path.join(dir, 'narration', 'second.wav'); fs.writeFileSync(other, 'existing-audio');
  const otherBefore = fs.statSync(other).mtimeMs;
  const result = await generateTts(dir, {ids: ['first'], force: true});
  expect(result.made).toEqual(['first']); expect(result.chars).toBe([...'お肉のうまみが広がります'].length);
  expect(bodies[0].text).toBe('[excited] お肉のうまみが広がります');
  expect(readNarration(dir)?.segments[0].emotion_tag).toBe('excited');
  expect(needsTtsIds(dir, readNarration(dir)!)).toEqual([]);
  expect((await generateTts(dir)).made).toEqual([]);
  const n = readNarration(dir)!; n.segments[0].emotion_tag = 'whispering'; n.segments[0].needsTts = true; writeNarration(dir, n);
  expect((await generateTts(dir)).made).toEqual(['first']); expect(bodies.at(-1).text).toMatch(/^\[whispering\] /);
  expect(fs.readFileSync(other, 'utf8')).toBe('existing-audio'); expect(fs.statSync(other).mtimeMs).toBe(otherBefore);
  const cfg = defaultEmotionTags(); cfg.tags.find(t => t.id === 'whispering')!.fish_tag = '[soft tone]';
  const file = path.join(root, 'emotion_tags.json'); fs.writeFileSync(file, JSON.stringify(cfg)); vi.stubEnv('REEL_STUDIO_EMOTION_TAGS_CONFIG', file);
  expect(needsTtsIds(dir, readNarration(dir)!)).toEqual(['first']);
  expect((await generateTts(dir)).made).toEqual(['first']); expect(bodies.at(-1).text).toMatch(/^\[soft tone\]/);
  const cleared = readNarration(dir)!; cleared.segments[0].emotion_tag = null; cleared.segments[0].needsTts = true; writeNarration(dir, cleared);
  expect((await generateTts(dir)).made).toEqual(['first']); expect(bodies.at(-1).text).toBe('お肉のうまみが広がります');
});

it('does not attach a duration from an obsolete emotion when edited during generation', async () => {
  writeNarration(dir, {voice: 'test-emotion', segments: [{id: 'first', at: 0, text: 'お肉のうまみが広がります', emotion_tag: 'excited', needsTts: true}]});
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      const n = readNarration(dir)!; n.segments[0].emotion_tag = 'calm'; writeNarration(dir, n);
      const wav = Buffer.alloc(64); wav.write('RIFF'); wav.write('WAVE', 8); return new Response(wav);
    }
    return new Response('{}');
  }));
  await generateTts(dir);
  expect(readNarration(dir)?.segments[0]).toMatchObject({emotion_tag: 'calm', needsTts: true});
  expect(readNarration(dir)?.segments[0].durSec).toBeUndefined();
});
