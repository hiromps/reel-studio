// プレビューに重ねるガイド（セーフゾーンの枠と 3 分割のグリッド）。画面で見るためだけのもので、書き出しには入らない。
// 数値は 1080×1920 基準。上 288px（15%）と下 672px（35%）は Instagram の UI に隠れる帯、
// 左右 90px はテロップの自動縮小が守っている幅（900px）と同じ。
import React from 'react';

export const SAFE_ZONE = {top: 288, bottom: 672, side: 90, width: 1080, height: 1920} as const;

const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;

export const PreviewGuides: React.FC = () => {
  const top = pct(SAFE_ZONE.top, SAFE_ZONE.height);
  const bottom = pct(SAFE_ZONE.bottom, SAFE_ZONE.height);
  const side = pct(SAFE_ZONE.side, SAFE_ZONE.width);
  return (
    <div className="preview-guides" aria-hidden="true">
      {/* 枠の外（UI に隠れる側）を薄く暗くする */}
      <div className="pg-shade" style={{left: 0, right: 0, top: 0, height: top}} />
      <div className="pg-shade" style={{left: 0, right: 0, bottom: 0, height: bottom}} />
      <div className="pg-shade" style={{left: 0, width: side, top, bottom}} />
      <div className="pg-shade" style={{right: 0, width: side, top, bottom}} />
      {/* 3 分割と中心線 */}
      <div className="pg-line pg-v" style={{left: '33.333%'}} />
      <div className="pg-line pg-v" style={{left: '66.667%'}} />
      <div className="pg-line pg-h" style={{top: '33.333%'}} />
      <div className="pg-line pg-h" style={{top: '66.667%'}} />
      <div className="pg-line pg-v pg-center" style={{left: '50%'}} />
      <div className="pg-line pg-h pg-center" style={{top: '50%'}} />
      {/* セーフゾーンの枠 */}
      <div className="pg-safe" style={{left: side, right: side, top, bottom}}>
        <span className="pg-label">セーフゾーン</span>
      </div>
    </div>
  );
};
