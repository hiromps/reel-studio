// 波形を親いっぱいに描くキャンバス。色は CSS の color を使う（明暗のテーマに合わせるため）。
import React, {useEffect, useRef, useState} from 'react';
import {barsFor, loadWaveform, type Waveform} from './waveform';

type Props = {
  /** 読み込む wav。null なら何も描かない */
  url: string | null;
  /** キャッシュのキー。音声を作り直したら変わるもの（id と実測尺など） */
  cacheKey: string;
  /** 描く範囲（wav の頭からの秒） */
  fromSec: number;
  toSec: number;
  /** この範囲の外は薄く描く（インスペクタで「使う範囲」を見せる） */
  highlight?: {start: number; end: number};
  className?: string;
};

export const useWaveform = (url: string | null, cacheKey: string): Waveform | null => {
  const [wave, setWave] = useState<Waveform | null>(null);
  useEffect(() => {
    if (!url) return setWave(null);
    let alive = true;
    loadWaveform(url, cacheKey).then((w) => alive && setWave(w)).catch(() => alive && setWave(null));
    return () => { alive = false; };
  }, [url, cacheKey]);
  return wave;
};

export const WaveformCanvas: React.FC<Props> = ({url, cacheKey, fromSec, toSec, highlight, className}) => {
  const wave = useWaveform(url, cacheKey);
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({w: 0, h: 0});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({w: e.contentRect.width, h: e.contentRect.height}));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !wave || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    const g = el.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    g.fillStyle = getComputedStyle(el).color;
    // 1 本 2px（間 1px）。細かすぎると点の集まりに見えるので
    const step = 3;
    const bars = barsFor(wave, fromSec, toSec, size.w / step);
    const mid = size.h / 2;
    const span = toSec - fromSec;
    bars.forEach((v, i) => {
      const t = fromSec + ((i + 0.5) / bars.length) * span;
      g.globalAlpha = highlight && (t < highlight.start || t > highlight.end) ? 0.25 : 1;
      const h = Math.max(1, v * (size.h - 2));
      g.fillRect(i * step, mid - h / 2, 2, h);
    });
    g.globalAlpha = 1;
  }, [wave, size, fromSec, toSec, highlight?.start, highlight?.end]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
};
