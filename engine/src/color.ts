/** 映像だけに適用する補正。編集プレビューと書き出しで同じ式を使う。 */
export type ColorAdjustments = {exposure?: number; brightness?: number; contrast?: number; saturation?: number};

const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value as number)) : fallback;

export const colorFilter = (color?: ColorAdjustments): string | undefined => {
  const exposure = bounded(color?.exposure, 0, -2, 2);
  const brightness = bounded(color?.brightness, 1, 0, 2);
  const contrast = bounded(color?.contrast, 1, 0, 2);
  const saturation = bounded(color?.saturation, 1, 0, 2);
  if (exposure === 0 && brightness === 1 && contrast === 1 && saturation === 1) return undefined;
  return `brightness(${(2 ** exposure * brightness).toFixed(6)}) contrast(${contrast.toFixed(6)}) saturate(${saturation.toFixed(6)})`;
};
