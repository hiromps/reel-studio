// 案件フォルダ（work/<slug>-reel/）の探索・作成・エンジン同期。
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {BriefSchema, type Brief, type PersonaId} from '../shared/schema/brief';
import {ReelDataSchema, type ReelData} from '../shared/schema/cuts';
import {NarrationSchema, type Narration} from '../shared/schema/narration';
import {CatalogSchema} from '../shared/schema/catalog';
import {findPersona, getPersona} from '../shared/personas';
import {resolveClip} from '../shared/validate';
import {fileStamp} from '../shared/time';
import {
  briefSkeleton,
  CONTRACT_FILES,
  DOC_FILES,
  emptyProjectMeta,
  parseProjectMeta,
  ProjectMetaSchema,
  withArchived,
  type ContractName,
  type EngineDiff,
  type EngineFamily,
  type ProjectInfo,
  type ProjectMeta,
} from '../shared/project';
import {readJsonFile, readJsonLoose, writeJsonAtomic, backupFile} from './json-io';
import {exec} from './exec';
import {isReferencePresent} from '../shared/reference';

// 案件の「形」は shared/project.ts が正（クラウド側からも読めるように fs 非依存で置いてある）。
// ここからは今までどおり core/project.ts の名前で使えるよう再輸出する。
export {CONTRACT_FILES, type ContractName, type EngineDiff, type EngineFamily, type ProjectInfo, type ProjectMeta};

export const engineFamily = (dir: string): EngineFamily => {
  const p = path.join(dir, 'src', 'telops.tsx');
  if (!fs.existsSync(p)) return 'unknown';
  const src = fs.readFileSync(p, 'utf8');
  if (/cinecaption/i.test(src)) return 'yui';
  if (/Zen Old Mincho/i.test(src)) return 'instagram';
  if (/Noto Serif JP/i.test(src)) return 'standard';
  return 'unknown';
};

/** slug または パス → 案件ディレクトリの絶対パス */
export const resolveProjectDir = (ref: string): string => {
  if (path.isAbsolute(ref) || ref.includes('/') || ref.includes('\\')) return path.resolve(ref);
  const withSuffix = ref.endsWith(studioConfig.projectSuffix) ? ref : `${ref}${studioConfig.projectSuffix}`;
  return path.join(studioConfig.workDir, withSuffix);
};

/**
 * HTTP から来た slug 専用の解決。**必ず work/ の直下に閉じる。**
 * resolveProjectDir はパスや絶対パスも受ける（CLI の `--project <dir>` のため）が、
 * URL に案件を入れるようになったので、そのままでは任意のフォルダをブラウザから読めてしまう。
 */
export const resolveProjectDirStrict = (ref: string): string => {
  const name = String(ref ?? '').trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || path.isAbsolute(name)) throw new Error(`案件名が不正です: ${ref}`);
  const withSuffix = name.endsWith(studioConfig.projectSuffix) ? name : `${name}${studioConfig.projectSuffix}`;
  const dir = path.join(studioConfig.workDir, withSuffix);
  if (path.dirname(dir) !== studioConfig.workDir) throw new Error(`案件名が不正です: ${ref}`);
  return dir;
};

export const projectSlug = (dir: string): string => path.basename(dir);

const templateSrcFiles = (): string[] => {
  const dir = path.join(studioConfig.templateDir, 'src');
  return fs.readdirSync(dir).filter((f) => /\.(tsx?|jsx?)$/.test(f));
};

export const engineDiff = (dir: string): EngineDiff => {
  const family = engineFamily(dir);
  if (family !== 'standard') return {stale: false, family, files: []};
  const files = templateSrcFiles().map((f) => {
    const t = path.join(studioConfig.templateDir, 'src', f);
    const p = path.join(dir, 'src', f);
    if (!fs.existsSync(p)) return {file: `src/${f}`, status: 'missing' as const};
    const same = fs.readFileSync(t).equals(fs.readFileSync(p));
    return {file: `src/${f}`, status: same ? ('ok' as const) : ('differs' as const)};
  });
  return {stale: files.some((f) => f.status !== 'ok'), family, files};
};

/** マスターテンプレートの src/*.tsx で案件側を上書き（差分ファイルは .studio/backups/engine-<ts>/ に退避）。standard 以外は触らない */
export const syncEngine = (dir: string): {synced: string[]} => {
  const diff = engineDiff(dir);
  const synced: string[] = [];
  if (diff.family !== 'standard') return {synced};
  const ts = fileStamp();
  for (const f of diff.files) {
    if (f.status === 'ok') continue;
    const src = path.join(studioConfig.templateDir, f.file);
    const dst = path.join(dir, f.file);
    if (f.status === 'differs') {
      const bdir = path.join(dir, studioConfig.studioDirName, 'backups', `engine-${ts}`);
      fs.mkdirSync(bdir, {recursive: true});
      fs.copyFileSync(dst, path.join(bdir, path.basename(f.file)));
    }
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(src, dst);
    synced.push(f.file);
  }
  return {synced};
};

// ── 付帯情報（.studio/meta.json）──
// 一覧の都合だけの値を入れる場所。契約ファイルと違って画面が ETag を握らないので、
// 「投稿済みで隠す」を押しても編集中の brief / cuts とはぶつからない。
// パスは DOC_FILES から引く（ワーカーの同期が同じファイルを読み書きするので、ここでずらさない）。

export const projectMetaPath = (dir: string): string => path.join(dir, DOC_FILES.meta);

/** 無い・壊れているときは既定（隠していない）を返す */
export const readProjectMeta = (dir: string): ProjectMeta => {
  const file = projectMetaPath(dir);
  if (!fs.existsSync(file)) return emptyProjectMeta();
  try {
    return parseProjectMeta(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return emptyProjectMeta();
  }
};

export const writeProjectMeta = (dir: string, meta: ProjectMeta): ProjectMeta => {
  const data = ProjectMetaSchema.parse(meta);
  writeJsonAtomic(projectMetaPath(dir), data);
  return data;
};

/** 一覧から隠す／戻す。中身（素材・契約ファイル・書き出し）は一切触らない */
export const setProjectArchived = (dir: string, archived: boolean): ProjectMeta => writeProjectMeta(dir, withArchived(readProjectMeta(dir), archived));

/** 参考動画（型を写す元）が取り込んであるか。墓標（source: null）は無い扱い。core/reference.ts を読むと循環するのでここで軽く見る */
const hasReference = (dir: string): boolean => {
  const file = path.join(dir, DOC_FILES.reference);
  if (!fs.existsSync(file)) return false;
  try {
    return isReferencePresent(readJsonLoose(file));
  } catch {
    return false;
  }
};

export const projectInfo = (dir: string): ProjectInfo => {
  const has = {
    catalog: fs.existsSync(path.join(dir, 'catalog.json')),
    brief: fs.existsSync(path.join(dir, 'brief.json')),
    cuts: fs.existsSync(path.join(dir, 'cuts.json')),
    narration: fs.existsSync(path.join(dir, 'narration.json')),
    reference: hasReference(dir),
  };
  let persona: PersonaId | undefined;
  let format: string | undefined;
  if (has.brief) {
    try {
      const b = readJsonFile(path.join(dir, 'brief.json'), BriefSchema);
      persona = b.persona;
      format = b.format ?? findPersona(b.persona)?.defaultFormat;
    } catch {
      /* 壊れた brief は無視 */
    }
  }
  const out = {
    draft: fs.existsSync(path.join(dir, 'out', 'draft.mp4')),
    final: fs.existsSync(path.join(dir, 'out', 'final.mp4')),
    narration: fs.existsSync(path.join(dir, 'out', 'final_narration.mp4')),
  };
  const mtimes = CONTRACT_FILES.map((n) => {
    try {
      return fs.statSync(path.join(dir, `${n}.json`)).mtimeMs;
    } catch {
      return 0;
    }
  });
  const updatedAt = new Date(Math.max(fs.statSync(dir).mtimeMs, ...mtimes)).toISOString();
  return {
    slug: projectSlug(dir),
    dir,
    has,
    out,
    engine: fs.existsSync(path.join(dir, 'src')) ? engineDiff(dir) : {stale: true, family: 'unknown', files: []},
    nodeModules: fs.existsSync(path.join(dir, 'node_modules', 'remotion')),
    updatedAt,
    persona,
    format,
    archivedAt: readProjectMeta(dir).archivedAt ?? undefined,
  };
};

export const listProjects = (): ProjectInfo[] => {
  if (!fs.existsSync(studioConfig.workDir)) return [];
  return fs
    .readdirSync(studioConfig.workDir)
    .filter((d) => d.endsWith(studioConfig.projectSuffix) && fs.existsSync(path.join(studioConfig.workDir, d, 'src', 'GourmetReel.tsx')))
    .map((d) => projectInfo(path.join(studioConfig.workDir, d)))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
};

export {briefSkeleton};

const copyDir = (src: string, dst: string, skip: (rel: string) => boolean, rel = '') => {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip, r);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
};

/** テンプレートを複製して案件を作る（既存フォルダには不足ファイルだけ足す） */
export const createProject = (slug: string, opt: {persona: PersonaId; shopName?: string; materialsDir?: string}): {dir: string; created: boolean} => {
  const dir = resolveProjectDir(slug);
  const created = !fs.existsSync(dir);
  // cuts.json はテンプレートに入っているサンプル（uploads/sample.mp4 を指す 2 カット）なので持ってこない。
  // 持ってくると新品の案件が「構成はもうある」ように見えて、プレビューが存在しない素材を読みにいく
  copyDir(studioConfig.templateDir, dir, (rel) => rel.startsWith('node_modules') || rel.startsWith('out') || rel === 'cuts.json');
  fs.mkdirSync(path.join(dir, 'public', 'uploads'), {recursive: true});
  fs.mkdirSync(path.join(dir, studioConfig.studioDirName), {recursive: true});
  const briefPath = path.join(dir, 'brief.json');
  if (!fs.existsSync(briefPath)) writeJsonAtomic(briefPath, briefSkeleton(opt.persona, opt.shopName));
  return {dir, created};
};

/** npm install（npm.cmd を直接 spawn できないため npm-cli.js を node で実行） */
/**
 * 同じ素材から別バージョンを作るときに、素材を**ハードリンク**で共有する。
 *
 * 同じ撮影素材で「hiro 版 / さゆり版」や「焼肉たべる版 / 焼肉伍龍版（同じ店の二毛作）」を
 * 作る場面が多い。素材をコピーすると 1 案件 400MB 前後が丸ごと増え、プロキシとサムネイルも
 * 作り直しになる。ハードリンクなら中身は 1 つのまま両方から見える。
 *
 * **ジャンクション（ディレクトリのリンク）は使わない。** `rm -rf` でリンク先の実ファイルまで
 * 消えるため（このリポジトリで過去に踏んでいる）。ハードリンクは片方を消しても
 * もう片方が残るので、案件フォルダをうっかり消しても元素材は無事。
 * 同じボリュームでないとリンクできないので、失敗したら普通のコピーに落ちる。
 */
const linkOrCopyDir = (src: string, dst: string): {linked: number; copied: number} => {
  let linked = 0;
  let copied = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, {recursive: true});
    for (const e of fs.readdirSync(from, {withFileTypes: true})) {
      const s2 = path.join(from, e.name);
      const d2 = path.join(to, e.name);
      if (e.isDirectory()) {
        walk(s2, d2);
        continue;
      }
      if (fs.existsSync(d2)) continue;
      try {
        fs.linkSync(s2, d2);
        linked++;
      } catch {
        fs.copyFileSync(s2, d2); // 別ボリューム・リンク非対応なら実体コピー
        copied++;
      }
    }
  };
  if (!fs.existsSync(src)) return {linked, copied};
  walk(src, dst);
  return {linked, copied};
};

/** ブランドや時間帯で変わりやすい項目。元案件から引き継ぐと間違いになりやすいので警告する */
export const BRAND_SPECIFIC_FACT_KEYS = ['営業時間', '定休日', 'Instagram', '備考', '予約'] as const;

export type CloneOptions = {
  /** 新しい案件の人格。省略＝元と同じ */
  persona?: PersonaId;
  /** 新しい案件の店名（別ブランド版なら必ず変える） */
  shopName?: string;
  /** 元案件の brief.facts を引き継ぐ（既定 true）。別ブランドなら false も検討 */
  facts?: boolean;
  /**
   * `cuts.json` / `narration.json` も引き継ぐ（既定 false＝版ごとに作る）。
   * 台本はそのままに、ボイスやフックの一部だけ変えた版を作りたいとき用。
   * 音声ファイル（`narration/`）は引き継がない（ボイスが変わる前提のため）ので、
   * 引き継いだ narration.json は全ブロックを要再生成にする。
   */
  carryTimeline?: boolean;
  onLine?: (line: string) => void;
};

export type CloneResult = {
  dir: string;
  linked: number;
  copied: number;
  clips: number;
  carriedFacts: string[];
  reviewFacts: string[];
  /** carryTimeline を指定して、実際に cuts.json / narration.json を引き継げたか */
  carriedTimeline: boolean;
};

/**
 * 既存案件から枝分かれした案件を作る。
 *
 * 引き継ぐもの: 素材（ハードリンク）・`catalog.json`（タグ付けの成果）・`.studio` のサムネイル類・
 *               `brief.json`（店名と人格は差し替え）
 * 引き継がないもの: `cuts.json` / `narration.json` / `narration/` / `caption.txt` / `out/`
 *               — これらは版ごとに作るもの。構成・原稿・キャプションは別物になる（`carryTimeline: true` を
 *               指定したときだけ cuts.json / narration.json は例外的に引き継ぐ）
 * `brief.hook` と `brief.order.fixed` も消す（フックの選定は版ごとにユーザーが選ぶ決まり）。
 */
export const cloneProject = (srcRef: string, newSlug: string, opt: CloneOptions = {}): CloneResult => {
  const log = opt.onLine ?? (() => {});
  const src = resolveProjectDir(srcRef);
  if (!fs.existsSync(src)) throw new Error(`元の案件が見つかりません: ${srcRef}`);
  const dir = resolveProjectDir(newSlug);
  if (fs.existsSync(path.join(dir, 'brief.json'))) throw new Error(`もう存在します: ${path.basename(dir)}（別の slug にしてください）`);

  const srcBrief = readBrief(src);
  if (!srcBrief) throw new Error(`元の案件に brief.json がありません: ${path.basename(src)}`);
  const persona = opt.persona ?? srcBrief.persona;

  // エンジンと雛形
  createProject(newSlug, {persona, shopName: opt.shopName ?? srcBrief.shop.name});

  // 素材（public/）と派生物（.studio のサムネイル類）はリンクで共有する
  let linked = 0;
  let copied = 0;
  // 顔モザイクの退避ファイル（mosaic/originals）も共有する。catalog の mosaic.original が指すので、無いと「元に戻す」ができない
  for (const sub of ['public', ...['thumbs', 'strips', 'preview', path.join('mosaic', 'originals')].map((d) => path.join(studioConfig.studioDirName, d))]) {
    const r = linkOrCopyDir(path.join(src, sub), path.join(dir, sub));
    linked += r.linked;
    copied += r.copied;
  }

  // catalog.json はコピー（タグ付けの成果を引き継ぐ）。slug だけ新しい案件のものにする
  let clips = 0;
  const srcCatalog = path.join(src, 'catalog.json');
  if (fs.existsSync(srcCatalog)) {
    const c = JSON.parse(fs.readFileSync(srcCatalog, 'utf8')) as {slug?: string; clips?: unknown[]};
    c.slug = path.basename(dir);
    clips = c.clips?.length ?? 0;
    writeJsonAtomic(path.join(dir, 'catalog.json'), c);
  }

  // brief は引き継ぐが、版ごとに決めるものは消す
  const carry: Brief = {
    ...srcBrief,
    persona,
    shop: {...srcBrief.shop, name: opt.shopName ?? srcBrief.shop.name},
    facts: opt.facts === false ? {} : srcBrief.facts,
    format: opt.persona && opt.persona !== srcBrief.persona ? undefined : srcBrief.format,
    hook: undefined,
    order: {mode: 'auto'},
  };
  writeJsonAtomic(path.join(dir, 'brief.json'), BriefSchema.parse(carry), {backupDir: backupsDir(dir)});

  const carriedFacts = Object.keys(carry.facts);
  const reviewFacts = carriedFacts.filter((k) => (BRAND_SPECIFIC_FACT_KEYS as readonly string[]).includes(k));

  // 台本（cuts.json）とナレーション原稿（narration.json）。既定では版ごとに作るので触らないが、
  // carryTimeline のときだけ例外的にそのまま引き継ぐ（音声ファイルは無いので全ブロック要再生成にする）
  let carriedTimeline = false;
  let narrationSegs = 0;
  if (opt.carryTimeline) {
    const srcCutsPath = path.join(src, 'cuts.json');
    if (fs.existsSync(srcCutsPath)) {
      writeCuts(dir, readJsonFile(srcCutsPath, ReelDataSchema));
      carriedTimeline = true;
    } else {
      log(`  ! 元の案件に cuts.json が無いので引き継げません: ${path.basename(src)}`);
    }
    const srcNarrationPath = path.join(src, 'narration.json');
    if (fs.existsSync(srcNarrationPath)) {
      const srcNarration = readJsonFile(srcNarrationPath, NarrationSchema);
      narrationSegs = srcNarration.segments.length;
      writeNarration(dir, {
        ...srcNarration,
        segments: srcNarration.segments.map((s) => {
          const n = {...s, needsTts: true} as typeof s & {durSec?: number};
          delete n.durSec;
          return n;
        }),
      });
    }
  }

  log(`${path.basename(src)} から ${path.basename(dir)} を作りました`);
  log(`  素材: ${linked} 本をリンクで共有${copied ? ` / ${copied} 本はコピー` : ''}（ディスクは増えません）`);
  log(`  catalog.json: ${clips} クリップ分のタグを引き継ぎ`);
  log(`  brief.json: 店名「${carry.shop.name}」／人格 ${persona}${carry.format ? `／型 ${carry.format}` : '（型は未指定＝人格の既定）'}`);
  if (carriedTimeline) {
    log('  cuts.json を引き継ぎました（構成はそのまま）');
    if (narrationSegs) log(`  narration.json を引き継ぎました（${narrationSegs} ブロック・ボイスが無いので全ブロック要再生成）`);
    log('  引き継いでいないもの: narration/（音声ファイル） / caption.txt / out/（版ごとに作るもの）');
  } else {
    log('  引き継いでいないもの: cuts.json / narration.json / narration/ / caption.txt（版ごとに作るもの）');
  }
  log('  brief の hook と order.fixed は消しました（フックは版ごとに選び直す）');
  if (reviewFacts.length) log(`  ! 引き継いだ facts のうち ${reviewFacts.join('・')} は版で変わることがあります。必ず確認してください`);
  return {dir, linked, copied, clips, carriedFacts, reviewFacts, carriedTimeline};
};

export const npmInstall = async (dir: string, onLine?: (l: string) => void): Promise<boolean> => {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const useCli = fs.existsSync(npmCli);
  const r = useCli
    ? await exec(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund'], {cwd: dir, onLine})
    : await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], {cwd: dir, onLine});
  return r.code === 0;
};

// ── 契約ファイルの読み書き ──
export const readCuts = (dir: string): ReelData => readJsonFile(path.join(dir, 'cuts.json'), ReelDataSchema);
export const readBrief = (dir: string): Brief | null => (fs.existsSync(path.join(dir, 'brief.json')) ? readJsonFile(path.join(dir, 'brief.json'), BriefSchema) : null);
export const readNarration = (dir: string): Narration | null => (fs.existsSync(path.join(dir, 'narration.json')) ? readJsonFile(path.join(dir, 'narration.json'), NarrationSchema) : null);
export const backupsDir = (dir: string) => path.join(dir, studioConfig.studioDirName, 'backups');
/**
 * cuts.json の並びに合わせて brief.order.fixed を更新する。
 *
 * order.fixed は `reel plan` が cuts.json を**組み立てるときの入力**であって、
 * 出来上がった構成の正解ではない。手でタイムラインを並べ替えたら実物とズレるので、
 * 実物側に合わせておく（ズレたままだと validate が延々と指摘し、plan をかけ直すと
 * 自分で決めた並びが巻き戻る）。
 *
 * カタログが読めない・固定順を使っていない案件では何もしない。
 * ここで失敗しても cuts.json の保存は成功させる（並び順の記録より本体が大事）。
 */
export const syncFixedOrder = (dir: string, data: ReelData): string[] | null => {
  try {
    const briefFile = path.join(dir, 'brief.json');
    const catalogFile = path.join(dir, 'catalog.json');
    if (!fs.existsSync(briefFile) || !fs.existsSync(catalogFile)) return null;
    const brief = readJsonFile(briefFile, BriefSchema);
    if (brief.order.mode !== 'fixed' || !brief.order.fixed) return null;
    const catalog = readJsonFile(catalogFile, CatalogSchema);
    const aliases = new Map<string, string>();
    for (const a of data.meta?.aliases ?? []) aliases.set(a.to, a.from);
    const next = data.cuts.map((c) => resolveClip(catalog, c.src, aliases)?.id).filter((id): id is string => !!id);
    if (!next.length) return null;
    const prev = brief.order.fixed;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) return null;
    writeBrief(dir, {...brief, order: {...brief.order, fixed: next}});
    return next;
  } catch {
    return null;
  }
};

export const writeCuts = (dir: string, data: ReelData) => {
  const r = writeJsonAtomic(path.join(dir, 'cuts.json'), data, {backupDir: backupsDir(dir)});
  syncFixedOrder(dir, data);
  return r;
};
export const writeBrief = (dir: string, data: Brief) => writeJsonAtomic(path.join(dir, 'brief.json'), BriefSchema.parse(data), {backupDir: backupsDir(dir)});
export const writeNarration = (dir: string, data: Narration) => writeJsonAtomic(path.join(dir, 'narration.json'), NarrationSchema.parse(data), {backupDir: backupsDir(dir)});

// キャプションだけは JSON ではなく、そのまま Instagram に貼れる素のテキストで持つ（work/ の既存案件と同じ）
export const captionPath = (dir: string) => path.join(dir, 'caption.txt');
export const readCaption = (dir: string): string | null => (fs.existsSync(captionPath(dir)) ? fs.readFileSync(captionPath(dir), 'utf8') : null);
export const writeCaption = (dir: string, text: string) => {
  const file = captionPath(dir);
  if (fs.existsSync(file)) backupFile(file, backupsDir(dir));
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n').replace(/\s*$/, '\n'), 'utf8');
  return file;
};
export {backupFile};
