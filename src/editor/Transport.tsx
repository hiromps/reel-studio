// プレビューの操作（再生・コマ送り・頭出し）と時刻表示。キーはページ側（Space / ← → / Home / End）が同じ関数を呼ぶ。
import React from 'react';
import type {MixPreviewStatus} from './useMixPreview';

type Props = {
  playing: boolean;
  frame: number;
  fps: number;
  totalFrames: number;
  currentCut: number;
  cutCount: number;
  loop: boolean;
  light: boolean;
  /** 声と効果音を重ねて再生する */
  mix: {enabled: boolean; status: MixPreviewStatus; pending: number; hasNarration: boolean; onToggle: (v: boolean) => void};
  onToggle: () => void;
  onStep: (frames: number) => void;
  onHome: () => void;
  onEnd: () => void;
  onLoop: (v: boolean) => void;
  onLight: (v: boolean) => void;
};

export const fmtTime = (frame: number, fps: number): string => (frame / fps).toFixed(2);

const mixLabel = (m: Props['mix']): {text: string; title: string; warn: boolean} => {
  if (!m.hasNarration) return {text: '声なし', title: 'ナレーション原稿がまだありません', warn: false};
  const s = m.status;
  const parts = [`声 ${s.narrReady}/${s.narrTotal}`];
  if (s.sfxTotal) parts.push(`効果音 ${s.sfxReady}/${s.sfxTotal}`);
  const notes: string[] = [];
  if (m.pending) notes.push(`未生成 ${m.pending}`);
  if (s.missing.length) notes.push(`読めない ${s.missing.length}`);
  if (s.loading) notes.push('読込中');
  return {
    text: `${parts.join('・')}${notes.length ? `（${notes.join('・')}）` : ''}`,
    title: `生成済みの narration/<id>.wav と効果音を、再生ヘッドに合わせて重ねて鳴らします（素材の音は環境音の音量に下げます）。${m.pending ? `音声が未生成のブロック ${m.pending} 件は鳴りません。` : ''}${s.missing.length ? `読めなかった: ${s.missing.join(', ')}` : ''}`,
    warn: m.pending > 0 || s.missing.length > 0,
  };
};

export const Transport: React.FC<Props> = ({playing, frame, fps, totalFrames, currentCut, cutCount, loop, light, mix, onToggle, onStep, onHome, onEnd, onLoop, onLight}) => {
  const ml = mixLabel(mix);
  return (
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
      <label className="sb-inline" title={ml.title}>
        <input type="checkbox" checked={mix.enabled} onChange={(e) => mix.onToggle(e.target.checked)} disabled={!mix.hasNarration} />
        <span>
          合成音 <span className={`hint${ml.warn ? ' warn-text' : ''}`}>{ml.text}</span>
        </span>
      </label>
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
};
