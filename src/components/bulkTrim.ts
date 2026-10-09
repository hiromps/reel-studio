import type {Catalog} from '@shared/schema';
import {fixedTrimRange} from './trim';
import {primaryRange, rangeForBar, withRange, withRangeLabel} from './triage';

/** 表示中の素材の主区間を、個別の「0.8秒を選ぶ」と同じ方法で更新する。 */
export const bulkQuickTrim = (catalog: Catalog, ids: ReadonlySet<string>) => {
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;
  const clips = catalog.clips.map((clip) => {
    if (!ids.has(clip.id) || clip.user.ng) return clip;
    const range = fixedTrimRange(rangeForBar(clip).inSec, clip.probe.durationSec, clip.probe.fps);
    if (!range) {
      skipped++;
      return clip;
    }
    const current = primaryRange(clip);
    if (current?.inSec === range.inSec && current.outSec === range.outSec && current.label === 'best') {
      unchanged++;
      return clip;
    }
    changed++;
    return withRangeLabel(withRange(clip, range), 'best', range);
  });
  return {catalog: changed ? {...catalog, clips} : catalog, changed, unchanged, skipped};
};
