// 効果音ライブラリ（<dataRoot>/sfx/）の読み書きと、cuts.json からの自動配置。
//
// 音源そのものは**公開リポジトリに入れない**（効果音ラボは素材の再配布が禁止。利用は商用でも自由）。
// なので sfx/ は .gitignore 済みで、ここでは「フォルダにあるファイルを拾って library.json に台帳を作る」
// という扱いにしている。ファイルを足したら scanLibrary() が拾う。
import fs from 'node:fs';
import path from 'node:path';
import {execOk} from './exec';
import {readJsonFile, writeJsonAtomic} from './json-io';
import {readCuts, readNarration, writeNarration} from './project';
import {loadCatalog} from './catalog';
import {studioConfig} from '../studio.config';
import {SfxLibrarySchema, assignSounds, checkSfx, sfxCandidates, thinCandidates, type SfxLibrary, type SfxPlacementOptions, type SfxRole, type SfxSound} from '../shared/sfx';
import {cutRanges, totalSec} from '../shared/timeline';
import type {Cut, ReelData} from '../shared/schema/cuts';
import type {Sfx} from '../shared/schema/narration';

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.flac']);

export const sfxDir = (): string => studioConfig.sfxDir;
export const libraryPath = (): string => path.join(sfxDir(), 'library.json');

/** sfx/<file> の実パス。ライブラリの外を指す file は受け付けない */
export const sfxFilePath = (file: string): string | null => {
  const safe = path.normalize(file).replace(/^([.][.][\\/])+/, '');
  if (path.isAbsolute(safe)) return null;
  const abs = path.join(sfxDir(), safe);
  if (path.relative(sfxDir(), abs).startsWith('..')) return null;
  return fs.existsSync(abs) ? abs : null;
};

export const readLibrary = (): SfxLibrary => {
  const p = libraryPath();
  if (!fs.existsSync(p)) return {version: 1, sounds: []};
  try {
    return readJsonFile(p, SfxLibrarySchema);
  } catch {
    return {version: 1, sounds: []};
  }
};

export const writeLibrary = (lib: SfxLibrary) => {
  fs.mkdirSync(sfxDir(), {recursive: true});
  writeJsonAtomic(libraryPath(), SfxLibrarySchema.parse(lib));
};

const audioDurationSec = async (file: string): Promise<number> => {
  try {
    const r = await execOk('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nokey=1', file]);
    return Math.round((Number(r.stdout.trim()) || 0) * 1000) / 1000;
  } catch {
    return 0;
  }
};

/**
 * sfx/ を見て library.json を作り直す。**既存の roles / default* は保持する**
 * （役割の割り当ては人が決めるもので、スキャンで消してはいけない）。
 */
export const scanLibrary = async (opt: {onLine?: (l: string) => void} = {}): Promise<{lib: SfxLibrary; added: string[]; removed: string[]}> => {
  const log = opt.onLine ?? (() => {});
  const dir = sfxDir();
  fs.mkdirSync(dir, {recursive: true});
  const prev = readLibrary();
  const byFile = new Map(prev.sounds.map((s) => [s.file, s]));

  const files: string[] = [];
  const walk = (sub: string) => {
    for (const e of fs.readdirSync(path.join(dir, sub), {withFileTypes: true})) {
      const rel = sub ? path.posix.join(sub, e.name) : e.name;
      if (e.isDirectory()) walk(rel);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) files.push(rel);
    }
  };
  walk('');

  const sounds: SfxSound[] = [];
  const added: string[] = [];
  for (const file of files.sort()) {
    const old = byFile.get(file);
    const durSec = old?.durSec ?? (await audioDurationSec(path.join(dir, file)));
    if (!old) added.push(file);
    sounds.push({
      file,
      // 既定の表示名は元のファイル名（効果音ラボの日本語名をそのまま活かす）
      label: old?.label ?? path.basename(file, path.extname(file)),
      roles: old?.roles ?? [],
      durSec,
      defaultTrimSec: old?.defaultTrimSec,
      defaultFadeOutSec: old?.defaultFadeOutSec,
      defaultGainDb: old?.defaultGainDb,
      source: old?.source,
    });
  }
  const removed = prev.sounds.filter((s) => !files.includes(s.file)).map((s) => s.file);
  const lib: SfxLibrary = {version: 1, sounds};
  writeLibrary(lib);
  log(`効果音ライブラリ: ${sounds.length} 音${added.length ? `（新規 ${added.length}）` : ''}${removed.length ? `（消えた ${removed.length}）` : ''}`);
  for (const f of added) log(`  + ${f}`);
  for (const f of removed) log(`  - ${f}（ファイルが無くなりました）`);
  const noRole = sounds.filter((s) => !s.roles.length).map((s) => s.label);
  if (noRole.length) log(`  ! 役割が未設定: ${noRole.join(', ')}（自動配置では使われません）`);
  return {lib, added, removed};
};

// ───────────────────────── 自動配置 ─────────────────────────

/** 実食・シズル寄りのカット（catalog のタグで判定） */
const EAT_KINDS = new Set(['eating', 'sizzle']);

/**
 * cuts.json と catalog.json から役割つきの候補を出す。
 * catalog が無い（手作り cuts）場合はタグが引けないので transition / eat / reveal は出さない。
 */
export const placementInputs = (projectDir: string, cuts: ReelData) => {
  const catalog = loadCatalog(projectDir);
  const ranges = cutRanges(cuts);
  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const clipOf = (c: Cut) => {
    const real = alias.get(c.src) ?? c.src;
    return catalog?.clips.find((x) => x.src === real || x.proxyOf === real);
  };

  const transitionAtList: number[] = [];
  const eatAtList: number[] = [];
  let revealAt: number | undefined;

  cuts.cuts.forEach((c, i) => {
    const at = ranges[i].startSec;
    const clip = clipOf(c);
    const prev = i > 0 ? clipOf(cuts.cuts[i - 1]) : undefined;
    // 被写体が変わる境界だけ。同じ素材・同じ被写体の連続では鳴らさない（うるさくなる）
    if (i > 0 && clip?.tags?.subject && prev?.tags?.subject && clip.tags.subject !== prev.tags.subject) transitionAtList.push(at);
    if (clip?.tags?.kind && EAT_KINDS.has(clip.tags.kind) && (clip.tags.sizzleScore ?? 0) >= 4) eatAtList.push(at);
    // 店名が読める看板カットの最初＝リビール
    if (revealAt === undefined && clip?.tags?.signage && (clip.tags.signageSize ?? 'none') !== 'none' && i > 0) revealAt = at;
  });

  // meta.slots に reveal 役があればそちらを優先する（型が決めたリビール位置）
  const slotReveal = (cuts.meta?.slots ?? []).findIndex((s) => /reveal/i.test(String((s as {role?: string}).role ?? '')));
  if (slotReveal >= 0 && ranges[slotReveal]) revealAt = ranges[slotReveal].startSec;

  return {transitionAtList, eatAtList, revealAt};
};

export type AutoSfxResult = {sfx: Sfx[]; missing: SfxRole[]; issues: ReturnType<typeof checkSfx>; videoSec: number; candidates: number};

/**
 * 効果音を自動で置いて narration.json に書く。
 * ライブラリに役割が割り当てられていない音は使わない（＝何も置かない）ので、
 * まず library.json の roles を埋めてもらう前提。
 */
export const autoPlaceSfx = async (projectDir: string, opt: SfxPlacementOptions & {write?: boolean; onLine?: (l: string) => void} = {}): Promise<AutoSfxResult> => {
  const log = opt.onLine ?? (() => {});
  const cuts = readCuts(projectDir);
  const videoSec = opt.videoSec ?? totalSec(cuts);
  const lib = readLibrary();
  const inputs = placementInputs(projectDir, cuts);
  const all = sfxCandidates(cuts, inputs);
  const thinned = thinCandidates(all, videoSec, opt);
  const {sfx, missing} = assignSounds(thinned, lib);
  const narration = readNarration(projectDir);
  const issues = checkSfx(sfx, {videoSec, lib, minGapSec: opt.minGapSec, narration: narration?.segments});

  log(`効果音の候補 ${all.length} → 間引き ${thinned.length} → 音が当たったもの ${sfx.length}（動画 ${videoSec.toFixed(2)} 秒）`);
  for (const s of sfx) log(`  ${s.at.toFixed(2)}s [${s.role}] ${s.label ?? s.file}`);
  if (missing.length) log(`  ! 役割に音が登録されていません: ${missing.join(', ')}（sfx/library.json の roles を埋めてください）`);
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);

  if (opt.write !== false) {
    if (!narration) throw new Error('narration.json が無いので効果音を書けません（先にナレーション原稿を作る）');
    writeNarration(projectDir, {...narration, sfx});
    log(`narration.json の sfx を ${sfx.length} 件に更新しました`);
  }
  return {sfx, missing, issues, videoSec, candidates: all.length};
};
