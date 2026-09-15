import React from 'react';
import {AbsoluteFill, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {MainTelopDef, PriceTelopDef} from './GourmetReel';

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

// ── ビジュアルテーマ（telop-style.md のテーマ表と対応） ─────────────
export type ThemeName = 'pop' | 'bold' | 'human' | 'stylish';

type Theme = {
  fontFamily: string;
  fontWeight: number;
  highlight: string; // "yellow"指定時の実色（味・価格・驚き）
  accent: string; // "red"指定時の実色（警告系）
  badgeBg: string; // バッジの下地（マスタード系の金）
  priceColor: string;
  strokeColor: string; // メイン・価格の袋文字フチ色
};

// フォントは全テーマ共通（Noto Serif JP Bold）。テーマの違いは配色のみ
const THEMES: Record<ThemeName, Theme> = {
  // まひろ基本形
  pop: {
    fontFamily: fontStack,
    fontWeight: 700,
    highlight: '#FFEA00',
    accent: '#FF2D2D',
    badgeBg: '#C9971F',
    priceColor: '#FFEA00',
    strokeColor: '#000',
  },
  // ランキング・デカ盛り・検証
  bold: {
    fontFamily: fontStack,
    fontWeight: 700,
    highlight: '#FFE600',
    accent: '#FF2D2D',
    badgeBg: '#C9971F',
    priceColor: '#FFE600',
    strokeColor: '#000',
  },
  // 人情ストーリー・老舗。あたたかい配色
  human: {
    fontFamily: fontStack,
    fontWeight: 700,
    highlight: '#FFD966',
    accent: '#E8613C',
    badgeBg: '#C08A22',
    priceColor: '#FFD966',
    strokeColor: '#4A2E1E',
  },
  // デート・カフェ・高級系。金の上品な配色
  stylish: {
    fontFamily: fontStack,
    fontWeight: 700,
    highlight: '#E6C86E',
    accent: '#C0392B',
    badgeBg: '#C9A33A',
    priceColor: '#E6C86E',
    strokeColor: '#1A1A1A',
  },
};

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
  badgeGap: 24, // バッジ下端とメインテロップの最小すき間
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

// バッジの外形高さ（フォント×行間＋上下パディング）。メインテロップの逃がし量に使う
const badgeBoxHeight = () => Math.round(LAYOUT.badgeFontSize * 1.05) + LAYOUT.badgePadY * 2;

// ── 層2: メインテロップ（カット同期） ─────────────────────────────
// 基本は縦書き・画面中央（映像との被りは許容）。下部配置は禁止。
// 人物・会話シーンのみ orientation: "horizontal" で上部横書きにできる。
export const MainTelop: React.FC<MainTelopDef & {theme: ThemeName; hasPrice?: boolean; hasBadge?: boolean}> = ({
  text,
  orientation = 'vertical',
  theme,
  hasPrice = false,
  hasBadge = false,
}) => {
  const t = THEMES[theme];
  // フェードインは付けない。カット頭で即表示し、バッジと立ち上がりを揃える
  // （2026-09-12にユーザー指定。以前は 0.13 秒の spring フェード＋12px スライドだった）

  const vertical = orientation !== 'horizontal';
  // 長文の安全弁：縦は高さ1300px・横は幅900pxに収まるよう自動縮小
  // （2026-08-12にセーフゾーン余白を広げるため1400/980から縮小。
  // 原則は台本側で13文字以内に収める）
  const fontSize = Math.min(LAYOUT.mainFontSize, Math.floor((vertical ? 1300 : 900) / Math.max(1, text.length)));

  // 2026-08-12：キーワード色分けを廃止（ユーザー指示「色を使わずに」）。
  // highlight/highlightColorはcuts.jsonの互換のため型としては残るが、描画では使わない。
  const content = text;

  const textStyle: React.CSSProperties = {
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    fontSize,
    whiteSpace: 'nowrap',
    ...outlined(LAYOUT.mainStrokeWidth, t.strokeColor),
  };

  if (vertical) {
    // price併記時はprice(top:220〜350px想定)と被らないよう最小限だけ下へ逃がす
    // （2026-08-13にユーザー指摘「下すぎる」で、コンテナごと下にずらす方式から
    // テキストへの小さいmarginTopに変更。中心のズレをtopInset/2からmarginTop/2に縮小）
    // バッジは上部中央に出るので、縦書きの上端がその下に来るまで下げる（marginTop の半分だけ中心がずれる）
    const badgeNudge = hasBadge ? 120 : 0;
    const priceNudge = Math.max(hasPrice ? 80 : 0, badgeNudge);
    return (
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div
          style={{
            ...textStyle,
            writingMode: 'vertical-rl',
            // 数字・英字も1文字ずつ正立で縦に積む（「120分」が横倒しにならない）
            textOrientation: 'upright',
            letterSpacing: '0.06em',
            marginTop: priceNudge,
          }}
        >
          {content}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{justifyContent: 'flex-start', alignItems: 'center'}}>
      <div
        style={{
          ...textStyle,
          // 横書きはバッジと同じ高さに来るので、バッジがあるときはその下へ送る
          marginTop: hasBadge ? LAYOUT.badgeTop + badgeBoxHeight() + LAYOUT.badgeGap : LAYOUT.mainTopHorizontal,
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
          fontFamily: t.fontFamily,
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
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: t.fontFamily,
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
        {text}
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
  return (
    <div
      style={{
        position: 'absolute',
        top: LAYOUT.tateTop,
        right: LAYOUT.tateRight,
        writingMode: 'vertical-rl',
        fontFamily: t.fontFamily,
        fontWeight: t.fontWeight,
        fontSize: LAYOUT.tateFontSize,
        letterSpacing: '0.08em',
        ...outlined(12, outlineColor),
      }}
    >
      {text}
    </div>
  );
};
