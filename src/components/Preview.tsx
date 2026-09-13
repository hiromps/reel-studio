// Remotion Player でテロップ付きプレビュー。エンジン（hiro マスター）を alias 経由で import し、フォント読込後にマウントする。
import React, {forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import type {ReelData} from '@shared/schema';
import {calcTotalFrames} from '@shared/timeline';

export type PreviewHandle = {
  seekTo: (frame: number) => void;
  pause: () => void;
  play: () => void;
  getCurrentFrame: () => number;
};

type Props = {
  cuts: ReelData;
  /**
   * 素材 URL の先頭（`/p/<slug>/<mode>`）。エンジンの staticFile() がここを頭に付ける。
   * タブごとに違う案件を開けるようにするため、素材の場所は必ず案件つきの URL で指す。
   */
  mediaBase: string | null;
  width?: number;
  loop?: boolean;
  onFrame?: (frame: number) => void;
};

type Engine = {GourmetReel: React.ComponentType<ReelData>};
let enginePromise: Promise<Engine> | null = null;
const loadEngine = () => (enginePromise ??= import('@engine/GourmetReel') as unknown as Promise<Engine>);

/**
 * Remotion の staticFile() が読む先頭パス。window 直下のグローバルなので 1 タブ 1 案件が前提
 * （タブごとに案件を分けているのでこれで足りる）。Player をマウントする前に入れておく。
 */
const setStaticBase = (base: string | null) => {
  (window as Window & {remotion_staticBase?: string}).remotion_staticBase = base ?? '';
};

export const Preview = forwardRef<PreviewHandle, Props>(({cuts, mediaBase, width = 360, loop = false, onFrame}, ref) => {
  setStaticBase(mediaBase);
  const [Comp, setComp] = useState<React.ComponentType<ReelData> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const player = useRef<PlayerRef>(null);

  useEffect(() => {
    let alive = true;
    loadEngine()
      .then(async (m) => {
        try {
          await (document as Document & {fonts?: {ready: Promise<unknown>}}).fonts?.ready;
        } catch {
          /* フォント読込失敗は明朝フォールバックで続行 */
        }
        if (alive) setComp(() => m.GourmetReel);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    seekTo: (f) => player.current?.seekTo(f),
    pause: () => player.current?.pause(),
    play: () => player.current?.play(),
    getCurrentFrame: () => player.current?.getCurrentFrame() ?? 0,
  }));

  useEffect(() => {
    const p = player.current;
    if (!p || !onFrame) return;
    const h = (e: {detail: {frame: number}}) => onFrame(e.detail.frame);
    p.addEventListener('frameupdate', h);
    return () => p.removeEventListener('frameupdate', h);
  }, [onFrame, Comp]);

  const duration = useMemo(() => Math.max(1, calcTotalFrames(cuts)), [cuts]);
  useEffect(() => {
    const p = player.current;
    if (p && p.getCurrentFrame() >= duration) p.seekTo(Math.max(0, duration - 1));
  }, [duration]);

  if (err) return <div className="preview-err">エンジンの読込に失敗: {err}</div>;
  if (!mediaBase) return <div className="preview-loading" style={{width, height: (width * 16) / 9}}>案件が開かれていません</div>;
  if (!Comp) return <div className="preview-loading" style={{width, height: (width * 16) / 9}}>エンジンとフォントを読込中…</div>;
  return (
    <Player
      ref={player}
      component={Comp}
      inputProps={cuts}
      durationInFrames={duration}
      fps={cuts.fps}
      compositionWidth={1080}
      compositionHeight={1920}
      style={{width, height: (width * 16) / 9, background: '#000'}}
      controls
      loop={loop}
      clickToPlay={false}
      showVolumeControls
      acknowledgeRemotionLicense
      errorFallback={({error}) => <div className="preview-err">再生エラー: {error.message}（HEVC 素材ならプロキシ生成を）</div>}
    />
  );
});
Preview.displayName = 'Preview';
