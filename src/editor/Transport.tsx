// プレビューの操作（再生・コマ送り・頭出し）と時刻表示。キーはページ側（Space / ← → / Home / End）が同じ関数を呼ぶ。
import React from 'react';

type Props = {
  playing: boolean;
  frame: number;
  fps: number;
  totalFrames: number;
  currentCut: number;
  cutCount: number;
  loop: boolean;
  light: boolean;
  onToggle: () => void;
  onStep: (frames: number) => void;
  onHome: () => void;
  onEnd: () => void;
  onLoop: (v: boolean) => void;
  onLight: (v: boolean) => void;
};

export const fmtTime = (frame: number, fps: number): string => (frame / fps).toFixed(2);

export const Transport: React.FC<Props> = ({playing, frame, fps, totalFrames, currentCut, cutCount, loop, light, onToggle, onStep, onHome, onEnd, onLoop, onLight}) => (
  <div className="transport">
    <span className="btns">
      <button className="small" onClick={onHome} title="先頭へ（Home）">
        ⏮
      </button>
      <button className="small" onClick={() => onStep(-1)} title="1 フレーム戻る（←。Shift で 10）">
        ◀
      </button>
      <button className={`small transport-play${playing ? ' on' : ''}`} onClick={onToggle} title="再生 / 一時停止（Space）">
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="small" onClick={() => onStep(1)} title="1 フレーム進む（→。Shift で 10）">
        ▶
      </button>
      <button className="small" onClick={onEnd} title="末尾へ（End）">
        ⏭
      </button>
    </span>
    <span className="transport-time mono">
      {fmtTime(frame, fps)}s <span className="dim">/ {fmtTime(totalFrames, fps)}s</span> <span className="dim">f{frame}</span>
      {currentCut >= 0 ? (
        <span className="dim">
          {' '}
          カット {currentCut + 1}/{cutCount}
        </span>
      ) : null}
    </span>
    <span style={{flex: 1}} />
    <label className="sb-inline" title="末尾まで行ったら先頭から">
      <input type="checkbox" checked={loop} onChange={(e) => onLoop(e.target.checked)} />
      <span>ループ</span>
    </label>
    <label className="sb-inline" title="Materials の「軽量プレビュー生成」で作った 540x960 を使う（レンダーには影響しない）">
      <input type="checkbox" checked={light} onChange={(e) => onLight(e.target.checked)} />
      <span>軽量</span>
    </label>
  </div>
);
