import React from 'react';
import {Composition} from 'remotion';
import {GourmetReel, calcTotalFrames} from './GourmetReel';
import type {ReelData} from './GourmetReel';
import sample from '../cuts.json';

// 動画1本 = props用JSON 1ファイル。レンダー時に --props=cuts/<slug>.json で
// 差し替える（量産時のバッチレンダー方式。batch-production.md参照）。
// 尺とfpsはprops（cuts定義）から自動計算する。
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="GourmetReel"
      component={GourmetReel}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={300}
      defaultProps={sample as ReelData}
      calculateMetadata={({props}) => ({
        fps: props.fps,
        durationInFrames: calcTotalFrames(props),
      })}
    />
  );
};
