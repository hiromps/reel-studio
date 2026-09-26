import React from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig} from 'remotion';
import {cropStyle} from './GourmetReel';
import type {Crop, ReelData} from './GourmetReel';
import {TelopFont, useTelopFont} from './telops';

// ── サムネイル（投稿のカバー画像・1080x1920 の静止画） ─────────────
// 型は決まっている（2026-09-26 にユーザーが参考画像で指定）:
//   上  … 英字の地名（OSAKA）。大きなセリフ体、中央
//   左  … 縦書きの「地域×エリア」（大阪×天満）
//   下  … 大きな横書きのキャッチ（神コスパ寿司酒場）。横幅いっぱい
//   背景 … 動画の 1 コマをそのまま（暗くする帯・下地は付けない。2026-09-26 ユーザー指定）
// 文字はすべて白＋右下に落ちる濃い影。フォントはテロップと同じもの（thumbnail.font で個別に変えられる）。
// 文言と背景の決め方は Reel Studio 側（shared/thumbnail.ts）で、ここには埋め終わったものが来る。

export type ThumbnailDef = {
  en?: string;
  side?: string;
  title?: string;
  font?: string;
  bg?: {src: string; atSec: number; crop?: Crop} | null;
};

export type ThumbnailProps = ReelData & {thumbnail?: ThumbnailDef};

const W = 1080;

/** thumbnail.font がこれなら同梱の明朝（Noto Serif JP）で描く */
const BUILTIN_FONT = 'builtin';

const LAYOUT = {
  enTop: 285,
  enFontSize: 200,
  enMaxWidth: 1000,
  sideLeft: 12,
  sideTop: 440,
  sideFontSize: 130,
  sideMaxHeight: 850, // 下のキャッチに届かない長さ
  titleTop: 1310,
  titleFontSize: 132,
  titleMaxWidth: 1050,
} as const;

// 右下に落ちる濃い影（参考画像の立体感）＋ 背景が明るくても読めるよう淡いにじみ
const dropShadow = (size: number): string => {
  const o = Math.max(3, Math.round(size * 0.045));
  return [
    `${o}px ${o}px ${Math.round(o * 0.8)}px rgba(0, 0, 0, 0.78)`,
    `${Math.round(o * 1.4)}px ${Math.round(o * 1.6)}px ${Math.round(o * 3)}px rgba(0, 0, 0, 0.45)`,
    `0 0 ${Math.round(size * 0.12)}px rgba(0, 0, 0, 0.35)`,
  ].join(', ');
};

const base = (fontFamily: string, fontSize: number): React.CSSProperties => ({
  fontFamily,
  fontWeight: 700,
  fontSize,
  lineHeight: 1.08,
  color: '#fff',
  whiteSpace: 'nowrap',
  textShadow: dropShadow(fontSize),
});

const len = (s: string): number => Array.from(s).length;

const Texts: React.FC<{en: string; side: string; title: string}> = ({en, side, title}) => {
  const fontFamily = useTelopFont();
  // 長いときだけ縮める（短いときは型の大きさのまま）。英大文字は 1 文字 ≒ 0.72em
  const enSize = Math.min(LAYOUT.enFontSize, Math.floor(LAYOUT.enMaxWidth / Math.max(1, len(en) * 0.76)));
  const sideSize = Math.min(LAYOUT.sideFontSize, Math.floor(LAYOUT.sideMaxHeight / Math.max(1, len(side))));
  const titleLines = title.split(/\r?\n/).filter((l) => l.trim());
  const longest = Math.max(1, ...titleLines.map(len));
  const titleSize = Math.min(LAYOUT.titleFontSize, Math.floor(LAYOUT.titleMaxWidth / longest));
  // 2 行のときは 1 行ぶん上へ伸ばす（下端の位置を揃える）
  const titleTop = LAYOUT.titleTop - (titleLines.length - 1) * Math.round(titleSize * 1.08);
  return (
    <>
      {en ? (
        <div style={{position: 'absolute', top: LAYOUT.enTop, left: 0, width: W, textAlign: 'center', ...base(fontFamily, enSize), letterSpacing: '0.03em'}}>{en}</div>
      ) : null}
      {side ? (
        <div
          style={{
            position: 'absolute',
            top: LAYOUT.sideTop,
            left: LAYOUT.sideLeft,
            ...base(fontFamily, sideSize),
            writingMode: 'vertical-rl',
            // 数字・英字・× も 1 文字ずつ正立で縦に積む
            textOrientation: 'upright',
            letterSpacing: '0.02em',
          }}
        >
          {side}
        </div>
      ) : null}
      {titleLines.length ? (
        <div style={{position: 'absolute', top: titleTop, left: 0, width: W, textAlign: 'center', ...base(fontFamily, titleSize)}}>
          {titleLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
    </>
  );
};

export const ReelThumbnail: React.FC<ThumbnailProps> = (data) => {
  const {fps} = useVideoConfig();
  const t = data.thumbnail ?? {};
  // 背景の指定が無い（エンジン単体で開いたとき）は 1 カット目の真ん中
  const first = data.cuts[0];
  // フォント。"builtin"＝同梱の明朝（shared/thumbnail.ts の THUMBNAIL_BUILTIN_FONT と同じ値）。
  // Reel Studio からは必ずどちらかが明示で来る。thumbnail が無い（エンジン単体で開いた）ときだけテロップのフォントを使う
  const fontFile = data.thumbnail ? (t.font && t.font !== BUILTIN_FONT ? t.font : undefined) : data.font;
  const bg = t.bg ??(first ? {src: first.src, atSec: (first.inSec + first.outSec) / 2, crop: first.crop} : null);
  return (
    <TelopFont file={fontFile}>
      <AbsoluteFill style={{backgroundColor: 'black'}}>
        {bg ? (
          <AbsoluteFill style={{overflow: 'hidden'}}>
            <OffthreadVideo src={staticFile(bg.src)} startFrom={Math.round(bg.atSec * fps)} muted style={cropStyle(bg.crop)} />
          </AbsoluteFill>
        ) : null}
        <Texts en={t.en ?? ''} side={t.side ?? ''} title={t.title ?? ''} />
      </AbsoluteFill>
    </TelopFont>
  );
};
