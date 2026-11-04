import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {ReelCutsSchema, type ReelCuts} from '../shared/schema/reel-cuts';
import {ReelDataSchema, type ReelData} from '../shared/schema/cuts';
import {NarrationSchema, type Narration} from '../shared/schema/narration';
import {defaultReelCutsConfig, ReelCutsConfigSchema, editorToReelCuts, narrationToReelCuts, reelCutsToEditor, reelCutsToNarration, reelCutsToScript, scriptToReelCuts, type ReelCutsConfig} from '../shared/reel-cuts';
import {readJsonFile, writeJsonAtomic} from './json-io';
import {settingsDir} from './settings';
import {requireLocalMedia} from './local-media';
import {assertMetadataOnly} from '../shared/media';

export const reelCutsPath = (dir: string): string => path.join(dir, 'reel-cuts.json');
export const hasReelCuts = (dir: string): boolean => fs.existsSync(reelCutsPath(dir));
export const readReelCuts = (dir: string): ReelCuts | null => hasReelCuts(dir) ? readJsonFile(reelCutsPath(dir), ReelCutsSchema) : null;

/** Re-read configuration on each operation so users can tune JSON without rebuilding. */
export const loadReelCutsConfig = (): ReelCutsConfig => {
  const configured = process.env.REEL_STUDIO_OC_EAT_CONFIG?.trim();
  const file = configured ? path.resolve(configured) : path.join(settingsDir(), 'oc-eat.json');
  return configured || fs.existsSync(file) ? readJsonFile(file, ReelCutsConfigSchema) : defaultReelCutsConfig();
};
/** A shared source change invalidates both editor documents, including same-size edits. */
export const reelProjectionEtag = (dir: string, name: string): string | null => {
  const file = path.join(dir, `${name}.json`);
  if (!hasReelCuts(dir) || (name !== 'cuts' && name !== 'narration')) return null;
  return createHash('sha256').update(fs.readFileSync(reelCutsPath(dir))).update(fs.existsSync(file) ? fs.readFileSync(file) : '').digest('hex');
};
const backups = (dir: string) => path.join(dir, '.studio', 'backups');
const existingEditor = (dir: string): ReelData | null => fs.existsSync(path.join(dir, 'cuts.json')) ? readJsonFile(path.join(dir, 'cuts.json'), ReelDataSchema) : null;
const existingNarration = (dir: string): Narration | null => fs.existsSync(path.join(dir, 'narration.json')) ? readJsonFile(path.join(dir, 'narration.json'), NarrationSchema) : null;
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** Reuse public files directly, otherwise create one cached local hard link/copy. */
export const reelClipSource = (dir: string, clip: string): string => {
  const root = path.join(dir, 'public');
  const absolute = path.isAbsolute(clip) ? clip : path.resolve(root, clip);
  const real = fs.realpathSync(absolute);
  if (!fs.statSync(real).isFile()) throw new Error('clip_path はファイルを指定してください');
  const publicReal = fs.realpathSync(root);
  if (inside(publicReal, real)) return path.relative(publicReal, real).split(path.sep).join('/');
  // A relative project path must never escape public through a symlink.
  if (!path.isAbsolute(clip)) throw new Error('clip_path が案件の public/ の範囲外です');
  const source = requireLocalMedia(real);
  const stat = fs.statSync(source);
  const key = createHash('sha256').update(`${source}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
  const relative = `uploads/reel-cuts/${key}${path.extname(source).toLowerCase()}`;
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  if (!inside(publicReal, fs.realpathSync(path.dirname(target)))) throw new Error('ローカルキャッシュの範囲外です');
  if (fs.existsSync(target) && (!inside(publicReal, fs.realpathSync(target)) || !fs.statSync(target).isFile())) throw new Error('ローカルキャッシュが不正です');
  if (!fs.existsSync(target)) {
    try {fs.linkSync(source, target);}
    catch (e) {
      if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
  return relative;
};

export const readReelEditor = (dir: string): ReelData | null => {
  const cuts = readReelCuts(dir);
  return cuts ? reelCutsToEditor(cuts, existingEditor(dir), loadReelCutsConfig(), (c) => reelClipSource(dir, c)) : null;
};
export const readReelNarration = (dir: string): Narration | null => {
  const cuts = readReelCuts(dir);
  return cuts ? reelCutsToNarration(cuts, existingNarration(dir), existingEditor(dir)?.fps ?? loadReelCutsConfig().render.fps) : null;
};

/** Validate every projection before committing the authoritative array. */
export const writeReelCuts = (dir: string, input: unknown, base?: {editor?: ReelData; narration?: Narration}): ReelCuts => {
  assertMetadataOnly(input);
  const cuts = ReelCutsSchema.parse(input).map((cut) => ({...cut, id: cut.id ?? randomUUID()}));
  const config = loadReelCutsConfig();
  const editor = ReelDataSchema.parse(reelCutsToEditor(cuts, base?.editor ?? existingEditor(dir), config, (c) => reelClipSource(dir, c)));
  const narration = reelCutsToNarration(cuts, base?.narration ?? existingNarration(dir), editor.fps);
  writeJsonAtomic(reelCutsPath(dir), cuts, {backupDir: backups(dir)});
  // These files are compatibility projections. Runtime readers use the array as authority.
  writeJsonAtomic(path.join(dir, 'cuts.json'), editor, {backupDir: backups(dir)});
  writeJsonAtomic(path.join(dir, 'narration.json'), narration, {backupDir: backups(dir)});
  return cuts;
};

export const saveReelEditor = (dir: string, editor: ReelData): void => {
  const cuts = readReelCuts(dir);
  if (!cuts) throw new Error('reel-cuts.json is missing');
  writeReelCuts(dir, editorToReelCuts(editor, cuts, loadReelCutsConfig(), (c) => reelClipSource(dir, c)), {editor});
};
export const saveReelNarration = (dir: string, narration: Narration): void => {
  const cuts = readReelCuts(dir);
  if (!cuts) throw new Error('reel-cuts.json is missing');
  // Mark audio invalid before projecting against the newly supplied speech text.
  const previous = existingNarration(dir);
  let updated = narrationToReelCuts(narration, cuts, existingEditor(dir)?.fps ?? loadReelCutsConfig().render.fps);
  if (narration.speed !== previous?.speed && narration.speed !== undefined) updated = ReelCutsSchema.parse(updated.map((c) => ({...c, speed: narration.speed})));
  const base = {...narration, segments: narration.segments.map((s) => ({...s, reelFingerprint: previous?.segments.find((p) => p.id === s.id)?.reelFingerprint}))};
  writeReelCuts(dir, updated, {narration: base});
};
export const readReelScript = (dir: string): string | null => {
  const cuts = readReelCuts(dir);
  return cuts ? reelCutsToScript(cuts, existingEditor(dir)?.fps ?? loadReelCutsConfig().render.fps) : null;
};
export const saveReelScript = (dir: string, text: string): void => {
  const cuts = readReelCuts(dir);
  if (!cuts) throw new Error('reel-cuts.json is missing');
  writeReelCuts(dir, scriptToReelCuts(text, cuts, existingEditor(dir)?.fps ?? loadReelCutsConfig().render.fps));
};
