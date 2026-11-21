import React from 'react';
import {AbsoluteFill, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {MainTelopDef, PriceTelopDef} from './GourmetReel';
import {VerticalText, verticalTextCells} from './VerticalText';

// ── フォント：Noto Serif JP Bold（セリフ体太字）を public/fonts から読み込む ─────
// ネット不要のローカル TTF（Google Fonts は使わない）。
// ライセンス：SIL OFL 1.1・商用可（public/fonts/OFL_license.txt）。
const SERIF_FAMILY = 'Noto Serif JP';
const serifHandle = delayRender('load-noto-serif-jp-bold');
try {
  const face = new FontFace(SERIF_FAMILY, `url(${staticFile('fonts/NotoSerifJP-Bold.ttf')}) format('truetype')`, {weight: '700'});
  face
    .load()
    .then((f) => {
      (document as any).fonts.add(f);
      continueRender(serifHandle);
    })
    .catch(() => continueRender(serifHandle)); // 読み込み失敗時はフォールバックで続行
} catch {
  continueRender(serifHandle);
}

const jpFallback = ', "Yu Mincho", "BIZ UDMincho Medium", "MS Mincho", serif';
const fontStack = `"${SERIF_FAMILY}"${jpFallback}`;

// ── 自前フォント：案件の public/fonts/ に置いたファイルをテロップに使う ──────
// cuts.json の `font`（ファイル名）で指定する。読めなければ上の明朝で描く。
// family の付け方は shared/schema/fonts.ts の fontFamilyOf と同じ規則にしてある。
export const customFontFamily = (file: string): string => `reel-font-${file.replace(/\.[^.]+$/, '')}`;

const customFonts = new Map<string, Promise<void>>();

const loadCustomFont = (file: string): Promise<void> => {
  const cached = customFonts.get(file);
  if (cached) return cached;
  const p = (async () => {
    // 重みは範囲で宣言する。可変フォント（VF）はこうしないと太さの軸が動かず、
    // テロップの font-weight: 700 が効かない（実測。static なフォントはそのまま使われる）
    const face = new FontFace(customFontFamily(file), `url(${staticFile(`fonts/${file}`)})`, {weight: '100 900'});
    const loaded = await face.load();
    (document as Document & {fonts: {add: (f: FontFace) => void}}).fonts.add(loaded);
  })();
  // 失敗しても投げっぱなしにしない（呼び出し側は必ず続行する）
  p.catch(() => undefined);
  customFonts.set(file, p);
  return p;
};

const TelopFontContext = React.createContext<string>(fontStack);

/** そのテロップで使うフォント（自前フォントがあればその family を先頭に置いたもの） */
export const useTelopFont = (): string => React.useContext(TelopFontContext);

/**
 * 自前フォントを読み込んでから中身を描く。読み込みの間はレンダーを待たせる
 * （delayRender。待たせないと 1 枚目だけ明朝で焼き付く）。失敗しても必ず続行する。
 */
export const TelopFont: React.FC<{file?: string; children: React.ReactNode}> = ({file, children}) => {
  const [handle] = React.useState(() => (file ? delayRender(`load-telop-font-${file}`) : null));
  // レンダーは props が固定なので、待つのは最初の 1 本だけでよい
  const first = React.useRef(file);
  React.useEffect(() => {
    if (handle === null) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      continueRender(handle);
    };
    loadCustomFont(first.current!).then(finish, finish);
    return finish; // 外されたときも必ず解放する（レンダーが止まったままにならないように）
  }, [handle]);
  // 画面で選び直したとき（プレビュー）。読み込めた時点でブラウザが描き直す
  React.useEffect(() => {
    if (file && file !== first.current) void loadCustomFont(file);
  }, [file]);
  // 読めなかったときは同梱の明朝 → OS の明朝へ落ちる
  const stack = file ? `"${customFontFamily(file)}", ${fontStack}` : fontStack;
  return <TelopFontContext.Provider value={stack}>{children}</TelopFontContext.Provider>;
};

// ── ビジュアルテーマ（telop-style.md のテーマ表と対応） ─────────────
// azu = @azu_osakagourmet の分析から作った型（白文字＋明朝と同じぼかし影・画面高さ44%に横書き2行・赤タグ・数字だけ大きく）
export type ThemeName = 'pop' | 'bold' | 'human' | 'stylish' | 'azu';

type Theme = {
  fontWeight: number;
  highlight: string; // "yellow"指定時の実色（味・価格・驚き）
  accent: string; // "red"指定時の実色（警告系）
  badgeBg: string; // バッジの下地（マスタード系の金）
  priceColor: string;
  strokeColor: string; // メイン・価格の袋文字フチ色
};

// フォントは全テーマ共通（同梱の Noto Serif JP Bold、または cuts.json の font）。テーマの違いは配色のみ
const THEMES: Record<ThemeName, Theme> = {
  // まひろ基本形
  pop: {
    fontWeight: 700,
    highlight: '#FFEA00',
    accent: '#FF2D2D',
    badgeBg: '#C9971F',
    priceColor: '#FFEA00',
    strokeColor: '#000',
  },
  // ランキング・デカ盛り・検証
  bold: {
    fontWeight: 700,
    highlight: '#FFE600',
    accent: '#FF2D2D',
    badgeBg: '#C9971F',
    priceColor: '#FFE600',
    strokeColor: '#000',
  },
  // 人情ストーリー・老舗。あたたかい配色
  human: {
    fontWeight: 700,
    highlight: '#FFD966',
    accent: '#E8613C',
    badgeBg: '#C08A22',
    priceColor: '#FFD966',
    strokeColor: '#4A2E1E',
  },
  // デート・カフェ・高級系。金の上品な配色
  stylish: {
    fontWeight: 700,
    highlight: '#E6C86E',
    accent: '#C0392B',
    badgeBg: '#C9A33A',
    priceColor: '#E6C86E',
    strokeColor: '#1A1A1A',
  },
  // azu 型。白文字＋明朝と同じぼかし影、強調語は赤タグ
  azu: {
    fontWeight: 800,
    highlight: '#FFE600',
    accent: '#E60012',
    badgeBg: '#E60012',
    priceColor: '#FFFFFF',
    strokeColor: '#000',
  },
};

// ── テロップの見た目（レイアウト・書体・フチ・影） ──────────────────
// cuts.json の telopStyle で項目ごとに上書きできる。省略した項目はテーマの既定（TELOP_STYLE_PRESETS）。
// 既定は pop〜stylish が従来どおり（縦書き中央・明朝・ぼかしフチ）、azu が横書き 2 行・ゴシック・明朝と同じぼかし影。
export type TelopLayout = 'auto' | 'vertical' | 'horizontal';
export type TelopFamily = 'custom' | 'gothic' | 'serif';
export type TelopStyle = {
  /** auto = カットごとの向き（main.orientation）に従う / vertical・horizontal = 全カットをその向きにする */
  layout?: TelopLayout;
  /** 横書きの中心の高さ（画面の高さに対する割合 0.1〜0.9）。省略＝従来の上部配置 */
  y?: number;
  /** 文字の大きさ（px・1080×1920 基準） */
  size?: number;
  /** 横書きで 1 行に入れる最大文字数。0 = 折り返さない（従来） */
  lineChars?: number;
  /** custom = 設定のフォント（無ければ同梱の明朝）/ gothic = 太めのゴシック / serif = 同梱の明朝 */
  family?: TelopFamily;
  /** soft = 同梱の明朝と同じ影（ぼかしフチ）/ none = 影なし。
   *  hard（くっきり黒フチ）は素人っぽく見えるので 2026-11-08 に廃止。古い cuts.json の hard は soft として描く */
  outline?: 'soft' | 'none' | 'hard';
  /** 影の広がり（px） */
  outlineWidth?: number;
  /** 赤タグの箱の影の濃さ（0〜1）。文字の影は outline で決める */
  shadow?: number;
  /** 【名物】のように隅付き括弧で囲んだ語を赤いタグにする */
  tags?: boolean;
  /** 数字（「100倍」「2000円」など）だけ大きくする */
  bigNumbers?: boolean;
  /** 〖…〗で付けた背景色の濃さ（0〜1）。バッジの濃さと同じく、下げると映像が透ける */
  markOpacity?: number;
};
export type ResolvedTelopStyle = {
  layout: TelopLayout;
  y: number | null;
  size: number;
  lineChars: number;
  family: TelopFamily;
  outline: 'soft' | 'none';
  outlineWidth: number;
  shadow: number;
  tags: boolean;
  bigNumbers: boolean;
  markOpacity: number;
};

/** 背景色の濃さの既定。バッジの下地（badgeBgAlpha）と同じ 0.6 */
export const MARK_OPACITY_DEFAULT = 0.6;

const LEGACY_STYLE: ResolvedTelopStyle = {
  layout: 'auto',
  y: null,
  size: 80,
  lineChars: 0,
  family: 'custom',
  outline: 'soft',
  outlineWidth: 14,
  shadow: 0.3,
  tags: false,
  bigNumbers: false,
  markOpacity: MARK_OPACITY_DEFAULT,
};

export const TELOP_STYLE_PRESETS: Record<ThemeName, ResolvedTelopStyle> = {
  pop: LEGACY_STYLE,
  bold: LEGACY_STYLE,
  human: LEGACY_STYLE,
  stylish: LEGACY_STYLE,
  // azu の 101 本の画像解析：画面高さの 44%（39〜48%）に中央揃え（元は 2 行・1 行 8〜12 字）。
  // 元は白文字＋黒フチだが、黒フチは素人っぽく見えるので影は同梱の明朝と同じぼかし（2026-11-08 ユーザー指定）
  azu: {
    layout: 'horizontal',
    y: 0.44,
    size: 64,
    // 文字数での自動改行はしない（2026-11-22 ユーザー指定。大きさをテロップごとに変えられるので、割るかどうかは改行で決める）。
    // 以前は 12 文字で 2 行に割っていた。割りたい案件は「1 行の文字数」を上げれば従来どおり
    lineChars: 0,
    family: 'gothic',
    outline: 'soft',
    outlineWidth: 14,
    shadow: 0.55,
    tags: true,
    bigNumbers: true,
    markOpacity: MARK_OPACITY_DEFAULT,
  },
};

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/** テーマの既定に cuts.json の telopStyle を重ねる。画面（Inspector）とレンダーで同じ関数を使う */
export const resolveTelopStyle = (theme: ThemeName | undefined, style?: TelopStyle | null): ResolvedTelopStyle => {
  const base = TELOP_STYLE_PRESETS[theme ?? 'pop'] ?? LEGACY_STYLE;
  const s = style ?? {};
  return {
    layout: s.layout ?? base.layout,
    y: s.y === undefined ? base.y : clampNum(s.y, 0.1, 0.9, 0.44),
    size: clampNum(s.size, 30, 140, base.size),
    lineChars: Math.round(clampNum(s.lineChars, 0, 30, base.lineChars)),
    family: s.family ?? base.family,
    outline: s.outline === 'none' ? 'none' : s.outline ? 'soft' : base.outline,
    outlineWidth: clampNum(s.outlineWidth, 0, 30, base.outlineWidth),
    shadow: clampNum(s.shadow, 0, 1, base.shadow),
    tags: s.tags ?? base.tags,
    bigNumbers: s.bigNumbers ?? base.bigNumbers,
    markOpacity: clampNum(s.markOpacity, 0, 1, base.markOpacity),
  };
};

const GOTHIC_STACK = '"Noto Sans JP", "Yu Gothic UI", "Yu Gothic", "YuGothic", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo", sans-serif';

// ── 横書きの折り返し・赤タグ・大きい数字 ─────────────────────────
type Piece = {kind: 'text' | 'tag' | 'num' | 'mark'; text: string; bg?: string};

/**
 * 背景色を付ける範囲。〖文字〗は既定の色、〖文字|#RRGGBB〗はその色。テーマに関係なく効く。
 * 文字数・折り返しでは括弧と色指定を数えない（shared/telop-text.ts の stripTelopMarks と同じ規則）。
 */
export const TELOP_MARK_RE = /〖([^〖〗|]+)(?:\|(#[0-9a-fA-F]{6}))?〗/g;
export const TELOP_MARK_DEFAULT_BG = '#FFE14D';
export const stripTelopMarks = (text: string): string => text.replace(TELOP_MARK_RE, '$1');
/** 背景色に対して読める文字色（明るい背景なら黒、暗い背景なら白） */
export const markTextColor = (bg: string): string => {
  const n = parseInt(bg.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#111' : '#fff';
};
/** 〖…〗で分ける。mark 以外の部分はそのまま返す */
const splitMarks = (text: string): {text: string; bg?: string}[] => {
  const out: {text: string; bg?: string}[] = [];
  let last = 0;
  for (const m of text.matchAll(TELOP_MARK_RE)) {
    if (m.index! > last) out.push({text: text.slice(last, m.index)});
    out.push({text: m[1], bg: m[2] ?? TELOP_MARK_DEFAULT_BG});
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({text: text.slice(last)});
  return out;
};

/** 数字のかたまり（単位つき）。大きく出す範囲であり、折り返さない範囲でもある */
const NUM_RE = /[0-9０-９][0-9０-９,，.．]*(?:万|千|百)?(?:倍|円|%|％|秒|分|年|個|品|貫|杯|本|人|cm|g|kg)?/g;

/** 【…】を赤タグ、数字のかたまり（単位つき）を num に分ける。tags / bigNumbers が off のものは text のまま */
export const parseTelopPieces = (text: string, opt: {tags: boolean; bigNumbers: boolean}): Piece[] =>
  splitMarks(text).flatMap((part) => (part.bg ? [{kind: 'mark' as const, text: part.text, bg: part.bg}] : parseUnmarked(part.text, opt)));

const parseUnmarked = (text: string, opt: {tags: boolean; bigNumbers: boolean}): Piece[] => {
  const out: Piece[] = [];
  const push = (kind: Piece['kind'], t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += t;
    else out.push({kind, text: t});
  };
  const tagRe = /【([^【】]+)】/g;
  const pushPlain = (t: string) => {
    if (!opt.bigNumbers) return push('text', t);
    let last = 0;
    for (const m of t.matchAll(NUM_RE)) {
      push('text', t.slice(last, m.index));
      push('num', m[0]);
      last = m.index! + m[0].length;
    }
    push('text', t.slice(last));
  };
  if (!opt.tags) {
    pushPlain(text);
    return out;
  }
  let last = 0;
  for (const m of text.matchAll(tagRe)) {
    pushPlain(text.slice(last, m.index));
    push('tag', m[1]);
    last = m.index! + m[0].length;
  }
  pushPlain(text.slice(last));
  return out;
};

/** 表示上の文字数（タグの括弧は数えない） */
const visibleLength = (text: string, tags: boolean): number => {
  const plain = stripTelopMarks(text);
  return (tags ? plain.replace(/[【】]/g, '') : plain).length;
};

/**
 * 横書きを最大 2 行に分ける。改行（\n）があればそれに従う。
 * 無ければ 1 行に入らないときだけ、真ん中に近い読点（、）の後ろ → 空白 → 真ん中で割る。
 * タグ（【…】）と数字のかたまりの途中では割らない。
 */
export const wrapTelop = (text: string, lineChars: number, tags: boolean): string[] => {
  const explicit = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit;
  const t = text.trim();
  if (lineChars <= 0 || visibleLength(t, tags) <= lineChars) return [t];
  // 割ってよい位置（文字列の index。その位置の前で改行する）
  const forbidden = new Set<number>();
  for (const re of [/【[^【】]*】/g, NUM_RE, TELOP_MARK_RE]) {
    for (const m of t.matchAll(re)) for (let i = m.index! + 1; i < m.index! + m[0].length; i++) forbidden.add(i);
  }
  // 行頭禁則（句読点・長音・小書きの仮名・閉じ括弧で行を始めない）
  for (let i = 1; i < t.length; i++) if (/[、。，．,.！!？?ー・」』）)ぁぃぅぇぉっゃゅょァィゥェォッャュョ]/.test(t[i])) forbidden.add(i);
  const mid = t.length / 2;
  const score = (i: number) => Math.abs(i - mid);
  const candidates = (pred: (i: number) => boolean) =>
    Array.from({length: t.length - 1}, (_, k) => k + 1).filter((i) => !forbidden.has(i) && pred(i));
  const pick = (list: number[]) => list.sort((a, b) => score(a) - score(b))[0];
  // 読点の直後。極端に片寄る（短い側が 3 割未満）なら使わない
  const balanced = (i: number) => Math.min(i, t.length - i) >= t.length * 0.3;
  const at =
    pick(candidates((i) => /[、，,。！!？?]/.test(t[i - 1]) && balanced(i))) ??
    pick(candidates((i) => t[i - 1] === ' ' || t[i - 1] === '　')) ??
    pick(candidates(() => true)) ??
    Math.ceil(mid);
  return [t.slice(0, at).trim(), t.slice(at).trim()].filter(Boolean);
};

/**
 * 背景色を付けた範囲。濃さ（opacity）はバッジと同じく下地だけに効き、文字は透けない。
 * 濃いときは影が濁るので外して背景の明るさで文字色を決め、薄いときは映像が勝つので白文字＋いつもの影のまま。
 */
const MarkSpan: React.FC<{bg: string; opacity: number; vertical?: boolean; children: React.ReactNode}> = ({bg, opacity, vertical, children}) => {
  const alpha = Math.max(0, Math.min(1, opacity));
  const solid = alpha >= 0.75;
  return (
  <span
    style={{
      background: hexToRgba(bg, alpha),
      color: solid ? markTextColor(bg) : '#fff',
      ...(solid ? {textShadow: 'none'} : {}),
      WebkitTextStroke: '0px transparent',
      padding: vertical ? '0.08em 0.04em' : '0.02em 0.12em 0.06em',
      borderRadius: '0.1em',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
    }}
  >
    {children}
  </span>
  );
};

/** 縦書き：〖…〗の範囲に背景色を付け、半角数字の縦中横は VerticalText に任せる */
const VerticalMarked: React.FC<{text: string; opacity: number}> = ({text, opacity}) => (
  <>
    {splitMarks(text).map((part, i) =>
      part.bg ? (
        <MarkSpan key={i} bg={part.bg} opacity={opacity} vertical>
          <VerticalText text={part.text} />
        </MarkSpan>
      ) : (
        <VerticalText key={i} text={part.text} />
      ),
    )}
  </>
);

const TelopPieces: React.FC<{text: string; look: ResolvedTelopStyle; accent: string}> = ({text, look, accent}) => (
  <>
    {parseTelopPieces(text, look).map((p, i) =>
      p.kind === 'tag' ? (
        <span
          key={i}
          style={{
            display: 'inline-block',
            background: accent,
            color: '#fff',
            WebkitTextStroke: '0px transparent',
            textShadow: 'none',
            fontSize: '0.86em',
            lineHeight: 1.15,
            padding: '0.04em 0.22em 0.08em',
            margin: '0 0.12em',
            borderRadius: '0.14em',
            verticalAlign: '0.06em',
            boxShadow: look.shadow > 0 ? `0 0.06em 0.18em rgba(0,0,0,${(look.shadow * 0.8).toFixed(2)})` : undefined,
          }}
        >
          {p.text}
        </span>
      ) : p.kind === 'mark' ? (
        <MarkSpan key={i} bg={p.bg!} opacity={look.markOpacity}>
          {p.text}
        </MarkSpan>
      ) : p.kind === 'num' ? (
        <span key={i} style={{fontSize: '1.45em', lineHeight: 1}}>
          {p.text}
        </span>
      ) : (
        <React.Fragment key={i}>{p.text}</React.Fragment>
      ),
    )}
  </>
);

// ── レイアウト定数（テーマ非依存。IGセーフゾーン設計） ──────────────
const LAYOUT = {
  mainFontSize: 80,
  mainTopHorizontal: 300, // 横書き時の上端（IG UIの上部15%セーフゾーンの直下）
  mainStrokeWidth: 14,
  priceFontSize: 110,
  priceTop: 220,
  priceStrokeWidth: 16,
  tateFontSize: 64,
  tateTop: 120,
  tateRight: 40,
  badgeFontSize: 88,
  badgeTop: 300, // IG UI の上部15%セーフゾーン（〜288px）の直下。横書きメインと同じ高さ基準
  badgeRadius: 6, // 角はごく僅かに丸めるだけ（シャープな長方形）
  badgePadX: 34,
  badgePadY: 16,
  badgeGap: 60, // バッジ下端と横書きメインテロップのすき間（24 だと詰まって見えた）
  badgeBgAlpha: 0.6, // 下地の不透明度の既定値。cuts.json の badgeOpacity で上書きできる
} as const;

// 16進カラー → rgba（ぼかしフチの半透明化に使う）
const hexToRgba = (hex: string, alpha: number): string => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// ぼかしフチ（2026-08-12改訂：よりぼかしを強め、透明度を下げて柔らかく）。
// 細い半透明ストローク＋広めの黒ぼかし（多層グロー）で文字を背景から浮かせる。
// width はフチ幅指定を受け、細フチ幅とぼかし半径に換算する。
const outlined = (width: number, color: string): React.CSSProperties => {
  const stroke = Math.max(2, Math.round(width * 0.3)); // 例: 14px指定 → 4pxの細フチ
  return {
    color: '#fff',
    WebkitTextStroke: `${stroke}px ${hexToRgba(color, 0.4)}`,
    paintOrder: 'stroke fill',
    textShadow: [
      `0 0 ${Math.round(width * 0.9)}px ${hexToRgba(color, 0.7)}`, // 輪郭直近のぼかし（広め・やや薄め）
      `0 0 ${Math.round(width * 2.0)}px ${hexToRgba(color, 0.35)}`, // 外側に広がる淡いグロー
      `0 ${Math.round(width * 0.4)}px ${Math.round(width * 1.1)}px rgba(0,0,0,0.3)`, // 下方向の柔らかい影
    ].join(', '),
  };
};

// 文字の影は書体にかかわらず明朝と同じぼかし（outlined）だけ。くっきりした黒フチは使わない（2026-11-08 ユーザー指定）
const telopShadow = (outline: ResolvedTelopStyle['outline'], width: number, color: string): React.CSSProperties =>
  outline === 'none' || width <= 0 ? {color: '#fff'} : outlined(width, color);

const fontStackFor = (family: TelopFamily, contextStack: string): string =>
  family === 'gothic' ? GOTHIC_STACK : family === 'serif' ? fontStack : contextStack;

// バッジの外形高さ（フォント×行間＋上下パディング）。メインテロップの逃がし量に使う
/** バッジの行（改行で区切る。空行は詰める） */
export const badgeLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const badgeBoxHeight = (lines = 1) => Math.round(LAYOUT.badgeFontSize * 1.05 * Math.max(1, lines)) + LAYOUT.badgePadY * 2;

// ── 層2: メインテロップ（カット同期） ─────────────────────────────
// 基本は縦書き・画面中央（映像との被りは許容）。下部配置は禁止。
// 人物・会話シーンのみ orientation: "horizontal" で上部横書きにできる。
export const MainTelop: React.FC<MainTelopDef & {theme: ThemeName; look?: ResolvedTelopStyle; hasPrice?: boolean; hasBadge?: boolean; badgeLineCount?: number}> = ({
  text,
  orientation = 'vertical',
  size,
  theme,
  look: lookProp,
  hasPrice = false,
  hasBadge = false,
  badgeLineCount = 1,
}) => {
  const t = THEMES[theme] ?? THEMES.pop;
  const look = lookProp ?? resolveTelopStyle(theme);
  const fontFamily = fontStackFor(look.family, useTelopFont());
  // フェードインは付けない。カット頭で即表示し、バッジと立ち上がりを揃える
  // （2026-09-12にユーザー指定。以前は 0.13 秒の spring フェード＋12px スライドだった）

  const vertical = look.layout === 'auto' ? orientation !== 'horizontal' : look.layout === 'vertical';
  // 改行（\n）で区切る。縦書きは 1 行 = 1 列（右から左へ並ぶ）、横書きは wrapTelop が行に分ける
  const verticalCols = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lines = vertical ? (verticalCols.length ? verticalCols : [text]) : wrapTelop(text, look.lineChars, look.tags);
  const longest = Math.max(1, ...lines.map((l) => visibleLength(l, look.tags) + (look.bigNumbers ? (l.match(/[0-9０-９]/g)?.length ?? 0) * 0.45 : 0)));
  // 大きさはこのテロップの指定（main.size）が優先。無ければ動画全体の telopStyle.size
  const wanted = typeof size === 'number' && Number.isFinite(size) ? Math.max(20, Math.min(240, size)) : look.size;
  // 長文の安全弁：縦は高さ1300px・横は幅900pxに収まるよう自動縮小
  // （2026-08-12にセーフゾーン余白を広げるため1400/980から縮小。
  // 原則は台本側で13文字以内に収める）。行・列が増えたぶん、もう一方の向き（縦書きの横幅・横書きの高さ）にも収める
  const alongLimit = Math.floor((vertical ? 1300 : 900) / Math.max(1, vertical ? Math.max(...lines.map((l) => verticalTextCells(stripTelopMarks(l)))) : longest));
  const acrossLimit = Math.floor((vertical ? 980 : 1300) / (lines.length * (vertical ? 1.15 : 1.32)));
  const fontSize = Math.min(wanted, alongLimit, acrossLimit);

  // 2026-08-12：キーワード色分けを廃止（ユーザー指示「色を使わずに」）。
  // highlight/highlightColorはcuts.jsonの互換のため型としては残るが、描画では使わない。
  // 例外は telopStyle.tags（【…】を赤タグ）と bigNumbers（数字だけ大きく）。azu 型の既定で on
  const content =
    look.tags || look.bigNumbers || lines.length > 1 || stripTelopMarks(text) !== text
      ? lines.map((line, i) => (
          <div key={i}>
            <TelopPieces text={line} look={look} accent={t.accent} />
          </div>
        ))
      : text;

  const textStyle: React.CSSProperties = {
    fontFamily,
    fontWeight: t.fontWeight,
    fontSize,
    whiteSpace: 'nowrap',
    ...telopShadow(look.outline, look.outlineWidth, t.strokeColor),
  };

  // 中心の高さを指定した横書き（azu 型の 44%）。バッジ・価格とは位置が離れているので逃がさない
  if (!vertical && look.y !== null) {
    return (
      <AbsoluteFill>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${(look.y * 100).toFixed(2)}%`,
            transform: 'translateY(-50%)',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div style={{...textStyle, textAlign: 'center', lineHeight: 1.32, letterSpacing: '0.02em'}}>{content}</div>
        </div>
      </AbsoluteFill>
    );
  }

  if (vertical) {
    // price併記時はprice(top:220〜350px想定)と被らないよう最小限だけ下へ逃がす
    // （2026-08-13にユーザー指摘「下すぎる」で、コンテナごと下にずらす方式から
    // テキストへの小さいmarginTopに変更。中心のズレをtopInset/2からmarginTop/2に縮小）
    // バッジは上部中央に出るので、縦書きの上端がその下に来るまで下げる（marginTop の半分だけ中心がずれる）
    const badgeNudge = hasBadge ? 120 + Math.round(LAYOUT.badgeFontSize * 1.05 * (Math.max(1, badgeLineCount) - 1)) : 0;
    const priceNudge = Math.max(hasPrice ? 80 : 0, badgeNudge);
    return (
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div
          style={{
            ...textStyle,
            writingMode: 'vertical-rl',
            // 英字は正立。半角数字の連続部分は下の VerticalText で縦中横にする。
            textOrientation: 'upright',
            letterSpacing: '0.06em',
            // 列の間隔は 2 列以上のときだけ詰める（1 列は従来の見た目のまま）
            ...(lines.length > 1 ? {lineHeight: 1.15} : {}),
            marginTop: priceNudge,
          }}
        >
          {lines.map((line, i) => (
            <React.Fragment key={i}>
              {i > 0 && <br />}
              <VerticalMarked text={line} opacity={look.markOpacity} />
            </React.Fragment>
          ))}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{justifyContent: 'flex-start', alignItems: 'center'}}>
      <div
        style={{
          ...textStyle,
          // 2行以上でも各行を中央にそろえる（短い行が左に寄らないように）
          textAlign: 'center',
          // 横書きはバッジと同じ高さに来るので、バッジがあるときはその下へ送る
          marginTop: hasBadge ? LAYOUT.badgeTop + badgeBoxHeight(badgeLineCount) + LAYOUT.badgeGap : LAYOUT.mainTopHorizontal,
        }}
      >
        {content}
      </div>
    </AbsoluteFill>
  );
};

// ── 層3: 価格テロップ（springポップイン・中央上部が標準） ───────────
export const PriceTelop: React.FC<PriceTelopDef & {theme: ThemeName}> = ({text, side = 'center', theme}) => {
  const t = THEMES[theme];
  const fontFamily = useTelopFont();
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // オーバーシュート付きポップイン（約5フレーム）
  const pop = spring({frame, fps, config: {damping: 12, stiffness: 200}});
  const scale = interpolate(pop, [0, 1], [0.6, 1]);

  const align: React.CSSProperties =
    side === 'left'
      ? {alignItems: 'flex-start', paddingLeft: 60}
      : side === 'center'
        ? {alignItems: 'center'}
        : {alignItems: 'flex-end', paddingRight: 60};

  return (
    <AbsoluteFill style={{justifyContent: 'flex-start', ...align}}>
      <div
        style={{
          marginTop: LAYOUT.priceTop,
          fontFamily,
          fontWeight: t.fontWeight,
          fontSize: LAYOUT.priceFontSize,
          whiteSpace: 'nowrap',
          transform: `scale(${scale})`,
          ...outlined(LAYOUT.priceStrokeWidth, t.strokeColor),
          color: t.priceColor,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

// ── バッジテロップ（ランキング順位・まとめ型の店名・エリア名。上部中央に表示） ──
// 半透明のマスタード色プレートに、白の明朝体を中央置き。
// 枠線・アイコン・傾き・アニメーションは付けない（2026-09-12にユーザー指定）。
// 下地は透けるが**文字は透かさない**。背景が明るくても読めるよう、影は濃いめに重ねる。
export const BadgeTelop: React.FC<{text: string; theme: ThemeName; opacity?: number}> = ({text, theme, opacity}) => {
  const t = THEMES[theme];
  const fontFamily = useTelopFont();
  // 0〜1 の範囲に丸める（0 で完全に透明＝プレート無し、1 でベタ塗り）
  const bgAlpha = Math.max(0, Math.min(1, opacity ?? LAYOUT.badgeBgAlpha));

  return (
    // 上部中央に固定（左右いっぱいの箱を作って中で中央寄せ）
    <div style={{position: 'absolute', top: LAYOUT.badgeTop, left: 0, right: 0, display: 'flex', justifyContent: 'center'}}>
      <div
        style={{
          background: hexToRgba(t.badgeBg, bgAlpha),
          borderRadius: LAYOUT.badgeRadius,
          padding: `${LAYOUT.badgePadY}px ${LAYOUT.badgePadX}px`,
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontFamily,
          fontWeight: t.fontWeight,
          fontSize: LAYOUT.badgeFontSize,
          lineHeight: 1.05,
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap',
          color: '#fff',
          opacity: 1, // プレートの透過に文字を巻き込まない
          textShadow: [
            '0 2px 4px rgba(0, 0, 0, 0.9)', // 輪郭直下の締まった影
            '0 4px 12px rgba(0, 0, 0, 0.75)', // 全体を持ち上げる影
            '0 0 2px rgba(0, 0, 0, 0.6)', // 明るい背景でのフチ代わり
          ].join(', '),
        }}
      >
        {badgeLines(text).map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  );
};

// ── 層1: 縦書きテロップ（エリア・店名。右上に全編常駐） ─────────────
export const TateTelop: React.FC<{text: string; outlineColor: string; theme: ThemeName}> = ({
  text,
  outlineColor,
  theme,
}) => {
  const t = THEMES[theme];
  const fontFamily = useTelopFont();
  return (
    <div
      style={{
        position: 'absolute',
        top: LAYOUT.tateTop,
        right: LAYOUT.tateRight,
        writingMode: 'vertical-rl',
        fontFamily,
        fontWeight: t.fontWeight,
        fontSize: LAYOUT.tateFontSize,
        letterSpacing: '0.08em',
        ...outlined(12, outlineColor),
      }}
    >
      <VerticalText text={text} />
    </div>
  );
};

// ── 最終カード（azu 型の締め：黒背景に「店名ピン＋詳細はキャプションまで」） ─────
// bg: black = 映像を隠して黒一色 / dim = 映像を暗く残す（外観＋店名看板の上に重ねる使い方）
export type EndCardDef = {title: string; sub?: string; bg?: 'black' | 'dim'};

const PinIcon: React.FC<{size: number; color: string}> = ({size, color}) => (
  // 絵文字（📍）はレンダー環境にフォントが無いと豆腐になるので、図形で描く
  <svg width={size} height={size} viewBox="0 0 24 24" style={{flex: 'none', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))'}}>
    <path d="M12 1.5C7.6 1.5 4 5 4 9.4c0 5.8 8 13.1 8 13.1s8-7.3 8-13.1C20 5 16.4 1.5 12 1.5z" fill={color} />
    <circle cx="12" cy="9.4" r="3.1" fill="#fff" />
  </svg>
);

export const EndCard: React.FC<EndCardDef & {theme: ThemeName; look?: ResolvedTelopStyle}> = ({title, sub, bg = 'black', theme, look: lookProp}) => {
  const t = THEMES[theme] ?? THEMES.pop;
  const look = lookProp ?? resolveTelopStyle(theme);
  const fontFamily = fontStackFor(look.family, useTelopFont());
  const titleSize = Math.min(96, Math.floor(860 / Math.max(1, title.length + 1.2)));
  return (
    <AbsoluteFill style={{background: bg === 'dim' ? 'rgba(0,0,0,0.62)' : '#000', justifyContent: 'center', alignItems: 'center'}}>
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 36, fontFamily, color: '#fff', fontWeight: t.fontWeight}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 18, fontSize: titleSize, lineHeight: 1.2, whiteSpace: 'nowrap', ...(bg === 'dim' ? outlined(14, '#000') : {})}}>
          <PinIcon size={Math.round(titleSize * 1.05)} color={t.accent} />
          <span>{title}</span>
        </div>
        {sub ? <div style={{fontSize: 46, opacity: 0.92, whiteSpace: 'nowrap', ...(bg === 'dim' ? outlined(10, '#000') : {})}}>{sub}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
