// プレビュー再生に合わせて、生成済みのナレーション wav と効果音を Web Audio で鳴らす。
// Remotion Player の frameupdate を見てずれたら鳴らし直す（素材の音は Player が出す。こちらは声と効果音だけ）。
// 有効な間は Player の音量を環境音の値（既定 0.22）に落として、mix 後の聞こえ方に近づける。
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {Narration} from '@shared/schema';
import type {SfxLibrary} from '@shared/sfx';
import {AMBIENT_DEFAULT, driftExceeded, mixClipsOf, planPlayback, type MixClip} from './mixPreview';

export type MixPreviewStatus = {
  /** 読み込めたナレーション wav の数 / 鳴らす対象の数 */
  narrReady: number;
  narrTotal: number;
  sfxReady: number;
  sfxTotal: number;
  loading: boolean;
  /** 読めなかったもの（404 など） */
  missing: string[];
};

type Opt = {
  enabled: boolean;
  narration: Narration | null;
  mediaBase: string | null;
  lib: SfxLibrary | null;
  fps: number;
  playing: boolean;
  /** 現在のフレーム（frameupdate で更新される値）。ずれの検出に使う */
  frame: number;
  /** 正確な現在フレーム（スケジュール時に使う） */
  getFrame: () => number;
  setPlayerVolume: (v: number) => void;
};

type Buf = AudioBuffer | 'loading' | 'missing';

export const useMixPreview = ({enabled, narration, mediaBase, lib, fps, playing, frame, getFrame, setPlayerVolume}: Opt): MixPreviewStatus => {
  const ctxRef = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, Buf>());
  const active = useRef<{nodes: AudioScheduledSourceNode[]; anchor: {ctxSec: number; mediaSec: number} | null}>({nodes: [], anchor: null});
  const [, bump] = useState(0);
  const clips = useMemo(() => (enabled ? mixClipsOf(narration, mediaBase, lib) : []), [enabled, narration, mediaBase, lib]);

  const ctx = useCallback((): AudioContext | null => {
    if (typeof AudioContext === 'undefined') return null;
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  // ---- 読み込み（キーが変わったものだけ。作り直した wav は durSec が変わるのでキーも変わる） ----
  // キャッシュはキーで引くので、読み込みの途中で clips が入れ替わっても（効果音ライブラリが後から届く等）
  // 結果はそのまま入れてよい。捨てると 'loading' のまま残って永遠に鳴らなくなる（実際に踏んだ）
  useEffect(() => {
    if (!enabled) return;
    const c = ctx();
    if (!c) return;
    for (const clip of clips) {
      if (buffers.current.has(clip.key)) continue;
      buffers.current.set(clip.key, 'loading');
      void (async () => {
        try {
          const res = await fetch(clip.url, {cache: 'no-store'});
          if (!res.ok) throw new Error(String(res.status));
          const buf = await c.decodeAudioData(await res.arrayBuffer());
          if (buffers.current.get(clip.key) === 'loading') buffers.current.set(clip.key, buf);
        } catch {
          if (buffers.current.get(clip.key) === 'loading') buffers.current.set(clip.key, 'missing');
        }
        bump((n) => n + 1);
      })();
    }
    // 使わなくなったものは捨てる（wav を作り直すと古いキーが残るため）
    const keep = new Set(clips.map((x) => x.key));
    for (const k of [...buffers.current.keys()]) if (!keep.has(k)) buffers.current.delete(k);
  }, [enabled, clips, ctx]);

  const stopAll = useCallback(() => {
    for (const n of active.current.nodes) {
      try {
        n.stop();
      } catch {
        /* まだ start していない・もう止まっている */
      }
      n.disconnect();
    }
    active.current = {nodes: [], anchor: null};
  }, []);

  const bufferSec = useCallback((key: string): number | undefined => {
    const b = buffers.current.get(key);
    return b && typeof b !== 'string' ? b.duration : undefined;
  }, []);

  /** 再生ヘッド mediaSec から鳴らし直す */
  const startFrom = useCallback(
    (mediaSec: number) => {
      stopAll();
      const c = ctx();
      if (!c) return;
      if (c.state === 'suspended') void c.resume();
      const plan = planPlayback(clips, bufferSec, mediaSec);
      const now = c.currentTime;
      const byKey = new Map(clips.map((x) => [x.key, x]));
      for (const p of plan) {
        const buf = buffers.current.get(p.key);
        if (!buf || typeof buf === 'string' || !byKey.get(p.key)) continue;
        const src = c.createBufferSource();
        src.buffer = buf;
        const g = c.createGain();
        g.gain.setValueAtTime(p.gain, now);
        const startAt = now + p.delaySec;
        if (p.fadeOutSec > 0 && p.durationSec > p.fadeOutSec) {
          g.gain.setValueAtTime(p.gain, startAt + p.durationSec - p.fadeOutSec);
          g.gain.linearRampToValueAtTime(0, startAt + p.durationSec);
        }
        src.connect(g).connect(c.destination);
        src.start(startAt, p.offsetSec, p.durationSec);
        active.current.nodes.push(src);
      }
      active.current.anchor = {ctxSec: now, mediaSec};
    },
    [clips, bufferSec, ctx, stopAll],
  );

  // ---- 再生・停止に追従 ----
  useEffect(() => {
    if (playing && enabled) startFrom(getFrame() / fps);
    else stopAll();
    // clips が変わったら（ナレーションをドラッグした・wav が読めた）鳴らし直す
  }, [playing, enabled, clips, startFrom, stopAll, getFrame, fps]);

  // ---- ずれたら鳴らし直す（ループで頭に戻ったときもここで拾う） ----
  useEffect(() => {
    if (!playing || !enabled) return;
    const c = ctxRef.current;
    if (!c) return;
    const mediaSec = frame / fps;
    if (driftExceeded(active.current.anchor, c.currentTime, mediaSec)) startFrom(mediaSec);
  }, [frame, playing, enabled, fps, startFrom]);

  // ---- Player の音量：有効なら環境音の値に落とす ----
  const ambient = narration?.ambientGain ?? AMBIENT_DEFAULT;
  useEffect(() => {
    setPlayerVolume(enabled && narration ? Math.max(0, Math.min(1, ambient)) : 1);
  }, [enabled, narration, ambient, setPlayerVolume]);

  // ---- 後始末 ----
  useEffect(
    () => () => {
      stopAll();
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    },
    [stopAll],
  );

  const count = (kind: MixClip['kind']) => {
    const list = clips.filter((x) => x.kind === kind);
    return {total: list.length, ready: list.filter((x) => typeof buffers.current.get(x.key) === 'object').length};
  };
  const n = count('narr');
  const sx = count('sfx');
  return {
    narrReady: n.ready,
    narrTotal: n.total,
    sfxReady: sx.ready,
    sfxTotal: sx.total,
    loading: clips.some((x) => buffers.current.get(x.key) === 'loading'),
    missing: clips.filter((x) => buffers.current.get(x.key) === 'missing').map((x) => x.id),
  };
};
