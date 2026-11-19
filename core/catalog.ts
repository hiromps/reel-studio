// 素材カタログ化：素材フォルダ → リネームコピー／プロキシ → probe → サムネイル → catalog.json。
// 既存 catalog.json の tags / usableRanges / user はマージして保持する（original 名で突合）。
import fs from 'node:fs';
import path from 'node:path';
import {CatalogSchema, type Catalog, type Clip} from '../shared/schema/catalog';
import {ffprobe, nominalFps} from './ffprobe';
import {ensureLooks} from './look';
import {makeProxy, needsProxy} from './proxy';
import {makeThumbnails} from './thumbnails';
import {detectScenes} from './scene';
import {detectSpeech} from './silence';
import {readJsonFile, writeJsonAtomic} from './json-io';
import {studioConfig} from '../studio.config';
import {FIXED_ORIGINAL_PREFIX} from '../shared/project-from-folder';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mts', '.m2ts']);

export const slugify = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'clip';

/** 比較用。区切り・末尾の区切り・大文字小文字（Windows）の違いを吸収する */
const samePath = (a: string, b: string): boolean => {
  const k = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return k(a) === k(b);
};

const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', {numeric: true, sensitivity: 'base'});

export const listMaterials = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()) && fs.statSync(path.join(dir, f)).isFile())
    .sort(naturalCompare);

/** 読み込む素材 1 本。key は catalog の original（既存クリップとの突き合わせに使う） */
type MaterialEntry = {key: string; abs: string; name: string};

/**
 * カタログ実行が読む素材の一覧。案件の素材フォルダ直下 → 固定素材フォルダ直下 の順。
 * 固定素材は original に「固定素材/」を付けて、案件の素材と同名でもぶつからないようにする
 */
export const collectMaterials = (materialsDir: string, fixedDir?: string | null): MaterialEntry[] => {
  const own = listMaterials(materialsDir).map((f) => ({key: f, abs: path.join(materialsDir, f), name: f}));
  if (!fixedDir || !fs.existsSync(fixedDir) || !fs.statSync(fixedDir).isDirectory() || samePath(fixedDir, materialsDir)) return own;
  const fixed = listMaterials(fixedDir).map((f) => ({key: `${FIXED_ORIGINAL_PREFIX}${f}`, abs: path.join(fixedDir, f), name: f}));
  return [...own, ...fixed];
};

export type CatalogOptions = {
  /** 生成素材の追加。既存クリップと元の素材フォルダを保持する。 */
  append?: boolean;
  generated?: Clip['generated'];
  materialsDir: string;
  /**
   * 固定素材フォルダ（毎回入れるロゴ・外観など）。指定すると直下の動画も読み込む。
   * null / 省略＝読み込まない。フォルダが無い・動画が無いときは何もしない（エラーにしない）
   */
  fixedDir?: string | null;
  projectDir: string;
  slug: string;
  proxy?: boolean;
  thumbs?: boolean;
  scenes?: boolean;
  speech?: boolean;
  /** サムネ・プロキシを既存でも作り直す */
  force?: boolean;
  onLine?: (msg: string) => void;
  onProgress?: (done: number, total: number, label: string) => void;
};

export const catalogPath = (projectDir: string) => path.join(projectDir, 'catalog.json');
export const studioDir = (projectDir: string) => path.join(projectDir, studioConfig.studioDirName);

/** 顔モザイクをかけたクリップの、退避してある元のファイル（かけていなければ null）。存在は確かめない */
export const mosaicOriginalAbs = (projectDir: string, clip: Pick<Clip, 'mosaic'> | undefined): string | null =>
  clip?.mosaic?.applied && clip.mosaic.original ? path.join(studioDir(projectDir), clip.mosaic.original) : null;

export const loadCatalog = (projectDir: string): Catalog | null => {
  const p = catalogPath(projectDir);
  return fs.existsSync(p) ? readJsonFile(p, CatalogSchema) : null;
};

export const saveCatalog = (projectDir: string, catalog: Catalog) => {
  catalog.updatedAt = new Date().toISOString();
  writeJsonAtomic(catalogPath(projectDir), CatalogSchema.parse(catalog), {backupDir: path.join(studioDir(projectDir), 'backups')});
};

const mode = (xs: number[]): number => {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best = xs[0] ?? 60;
  let bestN = -1;
  for (const [k, n] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function buildCatalog(opt: CatalogOptions): Promise<{catalog: Catalog; changed: string[]; warnings: string[]}> {
  const log = opt.onLine ?? (() => {});
  const warnings: string[] = [];
  const ownCount = listMaterials(opt.materialsDir).length;
  if (!ownCount) throw new Error(`動画ファイルが無い: ${opt.materialsDir}`);
  // 固定素材（毎回入れるロゴ・外観など）は案件の素材の後ろに足す。追加（append）では足さない
  const entries = collectMaterials(opt.materialsDir, opt.append ? null : opt.fixedDir);
  const files = entries.map((e) => e.key);
  const fixedCount = entries.length - ownCount;
  if (fixedCount > 0) log(`固定素材 ${fixedCount} 本も読み込みます: ${opt.fixedDir}`);
  // 案件フォルダが無いまま掘り進めると、slug を間違えた・フォルダをリネームした直後などに
  // 空の案件が黙って生まれ、素材の再コピーとタグ付けを丸ごとやり直すことになる
  if (!fs.existsSync(path.join(opt.projectDir, 'brief.json')) && !fs.existsSync(path.join(opt.projectDir, 'src', 'GourmetReel.tsx')))
    throw new Error(`案件フォルダが見つかりません: ${opt.projectDir}\n  reel new で作るか、slug（フォルダ名）を確認してください。GUI なら Projects で案件を開き直してください`);
  const uploadsDir = path.join(opt.projectDir, 'public', 'uploads');
  const sdir = studioDir(opt.projectDir);
  fs.mkdirSync(uploadsDir, {recursive: true});
  fs.mkdirSync(sdir, {recursive: true});

  const existing = loadCatalog(opt.projectDir);
  const byOriginal = new Map((existing?.clips ?? []).map((c) => [c.original, c]));
  let nextId = (existing?.clips ?? []).reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1;
  const clips: Clip[] = [];
  const changed: string[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < files.length; i++) {
    const entry = entries[i];
    const file = entry.key;
    const src = entry.abs;
    const prev = byOriginal.get(file);
    const id = prev?.id ?? String(nextId++).padStart(2, '0');
    const ext = path.extname(entry.name).toLowerCase();
    const slug = prev?.slug ?? slugify(path.basename(entry.name, ext));
    opt.onProgress?.(i, files.length, file);
    log(`[${id}] ${file}`);

    const srcProbe = await ffprobe(src);
    const proxy = opt.proxy !== false ? needsProxy(srcProbe) : {needed: false};
    const destName = proxy.needed ? `${id}_${slug}.mp4` : `${id}_${slug}${ext}`;
    const dest = path.join(uploadsDir, destName);
    const rel = `uploads/${destName}`;

    // 以前の src と名前が違えば（slug 変更）リネーム
    if (prev && prev.src !== rel) {
      const old = path.join(opt.projectDir, 'public', prev.src);
      if (fs.existsSync(old) && !fs.existsSync(dest)) {
        fs.renameSync(old, dest);
        log(`  rename ${prev.src} → ${rel}`);
        changed.push(rel);
      }
    }
    // 顔モザイク済みのクリップは、src がモザイク版。元の素材から作るもの（コピー・プロキシ）は退避先に作り、
    // src は触らない（ここで元の素材を上書きすると、黙ってモザイクが外れる）
    const stashed = mosaicOriginalAbs(opt.projectDir, prev);
    const baseAbs = stashed ?? dest;
    const baseRel = stashed ? path.relative(opt.projectDir, stashed).replace(/\\/g, '/') : rel;
    let rebuiltBase = false;
    if (stashed) fs.mkdirSync(path.dirname(stashed), {recursive: true});
    if (proxy.needed) {
      let reusable = fs.existsSync(baseAbs) && !opt.force;
      if (reusable) {
        try {
          const existingProbe = await ffprobe(baseAbs);
          if (existingProbe.durationSec <= 0) throw new Error('duration is zero');
        } catch (e) {
          reusable = false;
          log(`  既存のプロキシを読み取れないため作り直します: ${errText(e)}`);
        }
      }
      if (!reusable) {
        log(`  proxy (${proxy.reason}) → ${baseRel}`);
        await makeProxy(src, baseAbs, srcProbe, {onLine: (l) => log(`    ${l}`)});
        changed.push(rel);
        rebuiltBase = true;
      }
    } else {
      const same = fs.existsSync(baseAbs) && fs.statSync(baseAbs).size === fs.statSync(src).size;
      if (opt.force || !same) {
        fs.copyFileSync(src, baseAbs);
        log(`  copy → ${baseRel}`);
        changed.push(rel);
        rebuiltBase = true;
      }
    }
    if (stashed && rebuiltBase) {
      const w = `[${id}] ${file}: 元の素材を作り直しました。顔モザイクは前の元素材から作ったものなので、Materials でかけ直してください`;
      warnings.push(w);
      log(`  ! ${w}`);
    }
    // モザイク版は回転を反映した実寸で書き出してあるので、元の素材の probe ではなく src を測る
    const probe = proxy.needed || stashed ? await ffprobe(dest) : srcProbe;

    // 1 本の解析失敗で全体を落とさない（84 本のうち 1 本だけ壊れている、等）
    const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        const w = `[${id}] ${file}: ${what} 失敗 — ${errText(e)}`;
        warnings.push(w);
        log(`  ! ${what} 失敗（このクリップは ${what} 無しで続行）: ${errText(e)}`);
        return undefined;
      }
    };

    let thumbs = prev?.thumbs ?? {sheet: '', strip: []};
    const sheetAbs = path.join(sdir, 'thumbs', `${id}.jpg`);
    if (opt.thumbs !== false && (opt.force || !fs.existsSync(sheetAbs) || !thumbs.sheet)) {
      const t = await attempt('thumbs', () => makeThumbnails(dest, path.join(sdir, 'thumbs'), path.join(sdir, 'strips'), id, probe.durationSec));
      if (t) {
        thumbs = t;
        log(`  thumbs ${thumbs.strip.length} 枚`);
      }
    }
    let scenes = prev?.scenes;
    if (opt.scenes && (opt.force || !scenes)) {
      scenes = await attempt('scenes', () => detectScenes(dest));
      if (scenes) log(`  scenes ${scenes.length} 境界`);
    }
    let speech = prev?.speech;
    if (opt.speech && probe.hasAudio && (opt.force || !speech)) {
      speech = await attempt('speech', () => detectSpeech(dest, probe.durationSec));
      if (speech) log(`  speech ${speech.length} 区間`);
    }

    clips.push({
      id,
      original: file,
      generated: prev?.generated ?? opt.generated,
      slug,
      src: rel,
      proxyOf: undefined,
      probe,
      thumbs,
      tags: prev?.tags,
      usableRanges: prev?.usableRanges ?? [],
      speech,
      scenes,
      user: prev?.user ?? {hook: false, ng: false, orderHint: null, lock: false},
      color: prev?.color,
      mosaic: prev?.mosaic,
      // サムネイルを作り直していなければ、測った見た目（似た構図の判定・鮮明さ）もそのまま使える
      look: thumbs === prev?.thumbs ? prev?.look : undefined,
    });
  }
  opt.onProgress?.(files.length, files.length, 'done');

  // 素材フォルダから消えたクリップは残さない（tags は backups に残る）
  const retained = (existing?.clips ?? []).filter(c => !files.includes(c.original) && (opt.append || c.generated?.provider === 'modal'));
  const removed = opt.append ? [] : (existing?.clips ?? []).filter((c) => !files.includes(c.original) && !c.generated);
  for (const c of removed) log(`  removed from catalog: ${c.original}`);

  const catalog: Catalog = CatalogSchema.parse({
    version: 1,
    slug: opt.slug,
    materialsDir: opt.append && existing ? existing.materialsDir : opt.materialsDir,
    // 次の再読み込み（素材フォルダを指定しない実行）でも同じ選択を引き継ぐ
    includeFixed: opt.append ? existing?.includeFixed : !!opt.fixedDir,
    dominantFps: opt.append && existing ? existing.dominantFps : mode(clips.map((c) => nominalFps(c.probe.fps))),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    facts: existing?.facts ?? [],
    clips: [...retained, ...clips],
  });
  saveCatalog(opt.projectDir, catalog);
  if (opt.thumbs !== false) {
    const measured = await ensureLooks(opt.projectDir, {onLine: log}).catch((e) => {
      warnings.push(`見た目の測定に失敗（似た構図はタグで判定します）: ${errText(e)}`);
      return 0;
    });
    if (measured) return {catalog: loadCatalog(opt.projectDir) ?? catalog, changed, warnings};
  }
  return {catalog, changed, warnings};
}

/** カタログ表（edit-pipeline.md Step 1 の形式）。ユーザー提示・Claude のタグ付け用 */
export const catalogToMarkdown = (c: Catalog): string => {
  const lines = ['| No. | 元ファイル名 | リネーム後 | 内容 | 尺 | fps | 種別 | 看板 | 使えそうな区間 | 備考 |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const clip of c.clips) {
    const t = clip.tags;
    const ranges = clip.usableRanges.map((r) => `${r.inSec}-${r.outSec}${r.label !== 'ok' ? `(${r.label})` : ''}`).join(' ');
    const flags = [clip.user.hook ? '★hook' : '', clip.user.ng ? 'NG' : '', clip.user.lock ? 'lock' : '', clip.user.note ?? ''].filter(Boolean).join(' ');
    lines.push(`| ${clip.id} | ${clip.original} | ${path.basename(clip.src)} | ${t?.description ?? '（未タグ）'} | ${clip.probe.durationSec.toFixed(2)}s | ${nominalFps(clip.probe.fps)} | ${t ? `${t.kind}/${t.angle}${t.hasSpeech ? '/会話' : ''}` : '-'} | ${t?.signage ? '映る' : t ? '映らず' : '-'} | ${ranges} | ${flags} |`);
  }
  return lines.join('\n');
};

/** Claude のタグ付け用エクスポート（サムネイルの場所と現在のタグ） */
export const exportForTagging = (projectDir: string, c: Catalog) => ({
  project: projectDir,
  instructions:
    'clips[].tags を埋めて `reel tag --import <file>` で取り込む。kind: exterior|signage|interior|menu|cooking|serving|eating|sizzle|person|conversation|detail|other、angle: wide|mid|close、sizzleScore/quality: 1-5、signage: 店名・ロゴ・看板が読めるか。' +
    'description は素材カタログの「内容」列（何が映っているか）。subject は被写体名。slug を変えると public/uploads のファイル名も変わる（英数字・ハイフンのみ）。user.lock=true のクリップは変更不可。',
  clips: c.clips.map((clip) => ({
    id: clip.id,
    original: clip.original,
    slug: clip.slug,
    src: clip.src,
    durationSec: clip.probe.durationSec,
    sheet: path.join(studioDir(projectDir), clip.thumbs.sheet).replace(/\\/g, '/'),
    strip: clip.thumbs.strip.map((s) => path.join(studioDir(projectDir), s).replace(/\\/g, '/')),
    locked: clip.user.lock,
    tags: clip.tags ?? null,
    usableRanges: clip.usableRanges,
    speech: clip.speech ?? null,
  })),
});

export type TagImport = {
  clips: {
    id: string;
    slug?: string;
    tags?: Partial<Clip['tags']> & {kind: NonNullable<Clip['tags']>['kind']};
    usableRanges?: Clip['usableRanges'];
    speech?: Clip['speech'];
    note?: string;
  }[];
  facts?: string[];
};

/** タグの取り込み。lock されたクリップは触らない。slug 変更はファイルのリネームを伴う */
export const importTags = (projectDir: string, c: Catalog, data: TagImport, source: 'claude' | 'user' = 'claude'): {updated: string[]; skipped: string[]} => {
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date().toISOString();
  for (const t of data.clips) {
    const clip = c.clips.find((x) => x.id === t.id);
    if (!clip) {
      skipped.push(`${t.id}: not found`);
      continue;
    }
    if (clip.user.lock) {
      skipped.push(`${t.id}: locked`);
      continue;
    }
    if (t.tags) {
      clip.tags = {
        kind: t.tags.kind,
        signage: t.tags.signage ?? t.tags.kind === 'signage',
        signageSize: t.tags.signageSize ?? (t.tags.signage ? 'small' : 'none'),
        angle: t.tags.angle ?? 'mid',
        motion: t.tags.motion ?? 'handheld',
        sizzleScore: t.tags.sizzleScore ?? 3,
        quality: t.tags.quality ?? 3,
        hasSpeech: t.tags.hasSpeech ?? false,
        subject: t.tags.subject ?? '',
        description: t.tags.description ?? '',
        source: t.tags.source ?? source,
        taggedAt: t.tags.taggedAt ?? now,
      };
    }
    if (t.usableRanges) clip.usableRanges = t.usableRanges;
    if (t.speech) clip.speech = t.speech;
    if (t.note !== undefined) clip.user.note = t.note;
    if (t.slug && slugify(t.slug) !== clip.slug) {
      const newSlug = slugify(t.slug);
      const ext = path.extname(clip.src);
      const newRel = `uploads/${clip.id}_${newSlug}${ext}`;
      const oldAbs = path.join(projectDir, 'public', clip.src);
      const newAbs = path.join(projectDir, 'public', newRel);
      // 実体を動かせたとき（か、既に新しい名前で存在するとき）だけ src を書き換える。
      // 動かせないのに書き換えると catalog が存在しないファイルを指す
      if (fs.existsSync(newAbs)) {
        clip.slug = newSlug;
        clip.src = newRel;
      } else if (fs.existsSync(oldAbs)) {
        fs.renameSync(oldAbs, newAbs);
        clip.slug = newSlug;
        clip.src = newRel;
      } else {
        skipped.push(`${t.id}: 実体が無いので slug は変更しない（${clip.src}）`);
      }
    }
    updated.push(t.id);
  }
  if (data.facts) c.facts = data.facts;
  saveCatalog(projectDir, c);
  return {updated, skipped};
};
