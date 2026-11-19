// 素材フォルダを選ぶだけで案件を作るための、名前まわりの規則（fs 非依存。画面とサーバーの両方から使う）。
//
// 案件名（slug）は「店名（-人格）-reel」で運用されていて、店名は日本語のまま使う
// （例：居酒屋かぶき-reel / 本町ウワバミ-hiro-reel）。素材ファイル用の slugify（core/catalog.ts）は
// 日本語を落として英数字だけにするので、ここでは使わない。

const SUFFIX = '-reel';
/** Windows のフォルダ名に使えない文字と制御文字 */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;

/** パスの末尾のフォルダ名（区切りは \ と / の両方を受ける） */
export const folderNameOf = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).pop() ?? '';

/** パスの親フォルダ（次にダイアログを開くときの初期位置に使う）。親が無ければ空 */
export const parentDirOf = (dir: string): string => {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const name = folderNameOf(trimmed);
  return trimmed.slice(0, trimmed.length - name.length).replace(/[\\/]+$/, '');
};

/** フォルダ名 → 案件名の元（-reel は付けない）。使えない文字を落とすだけで、日本語と空白は残す */
export const slugBaseFromFolder = (folderName: string): string => {
  let s = folderName.normalize('NFC').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();
  // 案件フォルダそのものを選んだ場合に「-reel-reel」にならないようにする
  while (s.toLowerCase().endsWith(SUFFIX)) s = s.slice(0, -SUFFIX.length).trim();
  // 末尾のドットと空白は Windows が黙って落とす（作ったフォルダと名前が食い違う）
  return s.replace(/[. ]+$/, '').replace(/^\.+/, '');
};

const norm = (slug: string) => {
  const s = slug.trim().toLowerCase();
  return s.endsWith(SUFFIX) ? s.slice(0, -SUFFIX.length) : s;
};

/** その名前の案件が既にあるか（-reel の有無と大文字小文字は区別しない。Windows のフォルダ名と同じ扱い） */
export const slugTaken = (slug: string, existing: readonly string[]): boolean => {
  const n = norm(slug);
  return !!n && existing.some((e) => norm(e) === n);
};

/**
 * 既存の案件と重ならない案件名を返す（-reel は付けない）。
 * 重なったら「-人格」を付け、それでも重なれば「-2」「-3」…を付ける。
 * 同じ素材で人格違いの版を作る運用（店名-hiro / 店名-umaimon）にそのまま合う。
 */
export const suggestSlug = (base: string, personaId: string, existing: readonly string[]): string => {
  if (!base) return '';
  if (!slugTaken(base, existing)) return base;
  const persona = slugBaseFromFolder(personaId);
  const withPersona = persona ? `${base}-${persona}` : base;
  if (!slugTaken(withPersona, existing)) return withPersona;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${withPersona}-${n}`;
    if (!slugTaken(candidate, existing)) return candidate;
  }
  return withPersona;
};

/**
 * 固定素材フォルダから読み込んだクリップの original に付ける印。
 * 案件の素材と同じファイル名でもぶつからず、固定素材フォルダの場所を変えても同じクリップとして突き合わせられる
 */
export const FIXED_ORIGINAL_PREFIX = '固定素材/';
export const isFixedOriginal = (original: string): boolean => original.startsWith(FIXED_ORIGINAL_PREFIX);

/** 固定素材フォルダの状態（GET /api/fixed-materials の返り値） */
export type FixedMaterials = {
  /** 固定素材フォルダの絶対パス（無ければ作ってから返す） */
  dir: string;
  /** フォルダ直下の動画（カタログ実行が読む範囲と同じ） */
  videos: string[];
};

/** 素材フォルダを調べた結果（POST /api/materials-folders/inspect の返り値） */
export type FolderInspection = {
  /** 選ばれたフォルダの絶対パス */
  dir: string;
  folderName: string;
  /** フォルダ直下の動画の本数（カタログ実行が読む範囲と同じ） */
  videoCount: number;
  /** 動画が入っているサブフォルダ名（直下に 1 本も無いときの案内用） */
  subfoldersWithVideos: string[];
  /** 同じ素材フォルダを既に読み込んでいる案件（新しい順） */
  sameMaterials: string[];
};

/** よく使う素材フォルダ（GET /api/materials-folders の返り値） */
export type MaterialsFolders = {
  /** 既存の案件が読み込んだ素材フォルダ。新しい順・重複なし・いまも存在するものだけ */
  recent: {dir: string; slug: string}[];
};
