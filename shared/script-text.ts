import {stableHash} from './hash';
import {ReelDataSchema, type ReelData} from './schema/cuts';
import {NarrationSchema, type Narration} from './schema/narration';
import {totalSec} from './timeline';

export type ScriptTextConfirmation = {fingerprint: string; cuts: number; totalSec: number; narration: number};
/** PC・クラウド・画面で同じ正規化を使い、確認後の編集を上書きしない。 */
export const scriptTextConfirmation = (script: string, cuts: ReelData, narration: Narration | null): ScriptTextConfirmation => ({
  fingerprint: stableHash({script, cuts: ReelDataSchema.parse(cuts), narration: narration ? NarrationSchema.parse(narration) : null}),
  cuts: cuts.cuts.length,
  totalSec: totalSec(cuts),
  narration: narration?.segments.length ?? 0,
});
