// フレーム単位の均一ズーム。案件へ src/*.ts として同期される（外部依存なし）。
export type Zoom = {
  mode: 'none' | 'push' | 'pull';
  scale_start: number;
  scale_end: number;
  ease: 'in_out' | 'out' | 'linear';
  anchor_x: number;
  anchor_y: number;
};

export const zoomEase = (p: number, ease: Zoom['ease'] = 'in_out'): number => {
  const t = Math.max(0, Math.min(1, p));
  if (t === 0 || t === 1) return t;
  if (ease === 'linear') return t;
  if (ease === 'out') return Math.sin(Math.PI / 2 * t);
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
};

export const zoomScale = (zoom: Zoom | undefined, frame: number, frames: number): number => {
  if (!zoom || zoom.mode === 'none') return 1;
  // 1フレームのカットは開始倍率。premount中・範囲外シークも端点へ制限する。
  const p = frames <= 1 ? 0 : frame / (frames - 1);
  const start = zoom.scale_start ?? (zoom.mode === 'pull' ? 1.2 : 1);
  const end = zoom.scale_end ?? (zoom.mode === 'push' ? 1.18 : 1);
  return start + (end - start) * zoomEase(p, zoom.ease);
};

/** CSSのtransform-originで x0=ax*(W-W/z), y0=ay*(H-H/z) を小数座標のまま表す。 */
export const zoomStyle = (zoom: Zoom | undefined, frame: number, frames: number) => {
  const scale = zoomScale(zoom, frame, frames);
  return {
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: `${(zoom?.anchor_x ?? 0.5) * 100}% ${(zoom?.anchor_y ?? 0.5) * 100}%`,
  };
};
