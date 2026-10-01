// プレビューの操作（再生・コマ送り・頭出し）と時刻表示。キーはページ側（Space / ← → / Home / End）が同じ関数を呼ぶ。
// 再生ボタン群（Transport）はタイムラインの上段の中央に、合成音・ループ・軽量の切り替え（PreviewOptions）は
// プレビューのキャンバス左下に浮かせて置く。
import React from 'react';
import type {MixPreviewStatus} from './useMixPreview';

type MixProps = {enabled: boolean; status: MixPreviewStatus; pending: number; hasNarration: boolean; onToggle: (v: boolean) => void};

type TransportProps = {
  playing: boolean;
  frame: number;
  fps: number;
  totalFrames: number;
  currentCut: number;
  cutCount: number;
  onToggle: () => void;
  onStep: (frames: number) => void;
  onHome: () => void;
  onEnd: () => void;
};

type OptionsProps = {
  loop: boolean;
  light: boolean;
  /** 声と効果音を重ねて再生する */
  mix: MixProps;
  onLoop: (v: boolean) => void;
  onLight: (v: boolean) => void;
};

export const fmtTime = (frame: number, fps: number): string => (frame / fps).toFixed(2);

/** 0:01.2 の形（分:秒.1/10 秒）。タイムラインの上に大きく出す時刻 */
export const fmtClock = (frame: number, fps: number): string => {
  const t = Math.max(0, frame / fps);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const mixLabel = (m: MixProps): {text: string; title: string; warn: boolean} => {
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

/** 線のアイコン（currentColor で描くので、ボタンの文字色に従う） */
const Icon: React.FC<{d: string; fill?: boolean}> = ({d, fill}) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICON = {
  home: 'M6 5v14M19 5l-9 7 9 7z',
  end: 'M18 5v14M5 5l9 7-9 7z',
  back: 'M15 6l-6 6 6 6',
  fwd: 'M9 6l6 6-6 6',
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
};

export const Transport: React.FC<TransportProps> = ({playing, frame, fps, totalFrames, currentCut, cutCount, onToggle, onStep, onHome, onEnd}) => (
  <div className="transport">
    <span className="tp-time mono" title={`${fmtTime(frame, fps)}s / フレーム ${frame}`}>
      {fmtClock(frame, fps)}
    </span>
    <button className="tp-btn" onClick={onHome} title="先頭へ（Home）" aria-label="先頭へ">
      <Icon d={ICON.home} />
    </button>
    <button className="tp-btn" onClick={() => onStep(-1)} title="1 フレーム戻る（←。Shift で 10）" aria-label="1 フレーム戻る">
      <Icon d={ICON.back} />
    </button>
    <button className={`tp-play${playing ? ' on' : ''}`} onClick={onToggle} title="再生 / 一時停止（Space）" aria-label={playing ? '一時停止' : '再生'}>
      <Icon d={playing ? ICON.pause : ICON.play} fill />
    </button>
    <button className="tp-btn" onClick={() => onStep(1)} title="1 フレーム進む（→。Shift で 10）" aria-label="1 フレーム進む">
      <Icon d={ICON.fwd} />
    </button>
    <button className="tp-btn" onClick={onEnd} title="末尾へ（End）" aria-label="末尾へ">
      <Icon d={ICON.end} />
    </button>
    <span className="tp-total mono">{fmtClock(totalFrames, fps)}</span>
    {currentCut >= 0 && (
      <span className="tp-cut">
        カット {currentCut + 1}/{cutCount}
      </span>
    )}
  </div>
);

export const PreviewOptions: React.FC<OptionsProps> = ({loop, light, mix, onLoop, onLight}) => {
  const ml = mixLabel(mix);
  return (
    <div className="canvas-pill">
      <label className="sb-inline" title={ml.title}>
        <input type="checkbox" checked={mix.enabled} onChange={(e) => mix.onToggle(e.target.checked)} disabled={!mix.hasNarration} />
        <span>
          合成音 <span className={`hint${ml.warn ? ' warn-text' : ''}`}>{ml.text}</span>
        </span>
      </label>
      <span className="canvas-pill-sep" />
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
