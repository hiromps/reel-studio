import React from 'react';
import {AbsoluteFill, OffthreadVideo, Sequence, staticFile} from 'remotion';
import {BadgeTelop, MainTelop, PriceTelop, TateTelop} from './telops';
import type {ThemeName} from './telops';

export type MainTelopDef = {
  text: string;
  highlight?: string;
  highlightColor?: 'yellow' | 'red';
  // vertical(既定)=縦書き・画面中央 / horizontal=横書き・上部（人物・会話シーン用）
  // 下部配置は存在しない（禁止仕様）
  orientation?: 'vertical' | 'horizontal';
};

export type PriceTelopDef = {
  text: string;
  side?: 'left' | 'right' | 'center';
};

// 会話クリップ用の発話同期字幕。startSec/endSecは素材内の絶対秒（inSecと同じ時間軸）
export type SubDef = MainTelopDef & {
  startSec: number;
  endSec: number;
};

export type Cut = {
  src: string; // public/ からの相対パス（例: "uploads/kouraku/IMG_0001.mp4"）
  inSec: number;
  outSec: number;
  playbackRate?: number; // 会話クリップでは使わない（声のピッチが変わる）
  main?: MainTelopDef;
  price?: PriceTelopDef;
  badge?: string; // ランキング・まとめ型用（例: "第3位", "①幸楽"）。カット頭にポップイン
  subs?: SubDef[]; // 会話クリップ専用。mainと併用しない
};

export type ReelData = {
  fps: number;
  theme?: ThemeName; // pop(既定) | bold | human | stylish
  // 店名・エリアの常駐縦書きテロップ。基本は入れない（省略時は非表示）。
  // エリア訴求は冒頭フックのテロップとキャプション1行目で行う
  tate?: {text: string; outlineColor: string};
  // バッジ下地の不透明度（0〜1）。省略時はエンジン既定。Reel Studio の Timeline から調整できる
  badgeOpacity?: number;
  cuts: Cut[];
};

// カット尺（フレーム数）。倍速時は実時間が縮む
export const cutFrames = (c: Cut, fps: number): number =>
  Math.max(1, Math.round(((c.outSec - c.inSec) / (c.playbackRate ?? 1)) * fps));

export const calcTotalFrames = (data: ReelData): number =>
  data.cuts.reduce((sum, c) => sum + cutFrames(c, data.fps), 0);

export const GourmetReel: React.FC<ReelData> = (data) => {
  const theme = data.theme ?? 'pop';

  // 映像本体（OffthreadVideo・price/badge・subs）はカット単位のSequenceのまま
  let from = 0;
  const videoElements = data.cuts.map((cut, i) => {
    const dur = cutFrames(cut, data.fps);
    const cutFrom = from;
    from += dur;
    return (
      <Sequence key={i} from={cutFrom} durationInFrames={dur} name={`cut${String(i + 1).padStart(2, '0')}`}>
        <OffthreadVideo
          src={staticFile(cut.src)}
          startFrom={Math.round(cut.inSec * data.fps)}
          playbackRate={cut.playbackRate ?? 1}
          style={{width: '100%', height: '100%', objectFit: 'cover'}}
        />
        {/* 会話クリップ：発話に同期して字幕を切り替える（絶対秒→カット内フレームに変換） */}
        {cut.subs?.map((s, j) => {
          const rate = cut.playbackRate ?? 1;
          const subFrom = Math.max(0, Math.round(((s.startSec - cut.inSec) / rate) * data.fps));
          const subDur = Math.max(1, Math.round(((s.endSec - s.startSec) / rate) * data.fps));
          const {startSec, endSec, ...telop} = s;
          return (
            <Sequence key={`sub${j}`} from={subFrom} durationInFrames={subDur} name={`sub${j + 1}`}>
              <MainTelop theme={theme} {...telop} />
            </Sequence>
          );
        })}
        {cut.price ? <PriceTelop theme={theme} {...cut.price} /> : null}
        {cut.badge ? <BadgeTelop theme={theme} text={cut.badge} opacity={data.badgeOpacity} /> : null}
      </Sequence>
    );
  });

  // メインテロップ：同一文言（text・orientation一致）で連続するカットは1つの
  // Sequenceにまとめる。カットの境目で再フェードインせず、映像だけが切り替わる。
  const telopGroups: {from: number; dur: number; def: MainTelopDef; hasBadge: boolean}[] = [];
  {
    let cursor = 0;
    for (const cut of data.cuts) {
      const dur = cutFrames(cut, data.fps);
      if (cut.main && !cut.subs) {
        const last = telopGroups[telopGroups.length - 1];
        const continuous =
          last &&
          last.from + last.dur === cursor &&
          last.def.text === cut.main.text &&
          (last.def.orientation ?? 'vertical') === (cut.main.orientation ?? 'vertical');
        if (continuous) {
          last.dur += dur;
          if (cut.badge) last.hasBadge = true;
        } else {
          telopGroups.push({from: cursor, dur, def: cut.main, hasBadge: !!cut.badge});
        }
      }
      cursor += dur;
    }
  }

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {videoElements}
      {telopGroups.map((g, i) => (
        <Sequence key={`telop${i}`} from={g.from} durationInFrames={g.dur} name={`telop${i + 1}`}>
          <MainTelop theme={theme} {...g.def} hasBadge={g.hasBadge} />
        </Sequence>
      ))}
      {/* 常駐縦書きテロップは tate 指定時のみ（基本は入れない） */}
      {data.tate ? <TateTelop theme={theme} text={data.tate.text} outlineColor={data.tate.outlineColor} /> : null}
    </AbsoluteFill>
  );
};
