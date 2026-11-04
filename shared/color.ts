import {z} from 'zod';
export {colorFilter} from '../engine/src/color';

export const ColorAdjustmentsSchema = z.object({
  exposure: z.number().finite().min(-2).max(2).default(0),
  brightness: z.number().finite().min(0).max(2).default(1),
  contrast: z.number().finite().min(0).max(2).default(1),
  saturation: z.number().finite().min(0).max(2).default(1),
});
export type ColorAdjustments = z.infer<typeof ColorAdjustmentsSchema>;
export const DEFAULT_COLOR: ColorAdjustments = {exposure: 0, brightness: 1, contrast: 1, saturation: 1};
export const isDefaultColor = (color?: ColorAdjustments): boolean => !color ||
  (color.exposure === 0 && color.brightness === 1 && color.contrast === 1 && color.saturation === 1);
