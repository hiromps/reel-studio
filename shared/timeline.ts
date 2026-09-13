// タイムライン計算。GourmetReel.tsx の cutFrames / calcTotalFrames / telopGroups と同一式（テストでエンジン実装と突合する）。
import type {Cut, MainTelopDef, ReelData} from './schema/cuts';

type CutTiming = Pick<Cut, 'inSec' | 'outSec' | 'playbackRate'>;
type Timeline = {fps: number; cuts: CutTiming[]};

/** カット尺（フレーム数）。倍速時は実時間が縮む。エンジンと同一式 */
export const cutFrames = (c: CutTiming, fps: number): number =>
  Math.max(1, Math.round(((c.outSec - c.inSec) / (c.playbackRate ?? 1)) * fps));

/** カットの実時間（秒）。フレーム丸め前 */
export const cutDurationSec = (c: CutTiming): number => (c.outSec - c.inSec) / (c.playbackRate ?? 1);

export const calcTotalFrames = (data: Timeline): number => data.cuts.reduce((sum, c) => sum + cutFrames(c, data.fps), 0);

export const totalSec = (data: Timeline): number => calcTotalFrames(data) / data.fps;

export type CutRange = {index: number; from: number; dur: number; startSec: number; durSec: number; endSec: number};

/** 各カットの開始フレーム・尺 */
export const cutRanges = (data: Timeline): CutRange[] => {
  let from = 0;
  return data.cuts.map((c, index) => {
    const dur = cutFrames(c, data.fps);
    const r: CutRange = {
      index,
      from,
      dur,
      startSec: from / data.fps,
      durSec: dur / data.fps,
      endSec: (from + dur) / data.fps,
    };
    from += dur;
    return r;
  });
};

/** N 番目（0 始まり）のカットの開始フレーム */
export const cutStartFrame = (data: Timeline, index: number): number => {
  let from = 0;
  for (let i = 0; i < index && i < data.cuts.length; i++) from += cutFrames(data.cuts[i], data.fps);
  return from;
};

export type TelopGroup = {from: number; dur: number; def: MainTelopDef; cutIndices: number[]};

/**
 * 同一 main.text かつ同一 orientation で連続するカットを 1 グループにまとめる（エンジンの telopGroups と同一判定）。
 * subs を持つカットはグループ対象外。
 */
export const telopGroupsOf = (data: Pick<ReelData, 'fps' | 'cuts'>): TelopGroup[] => {
  const groups: TelopGroup[] = [];
  let cursor = 0;
  data.cuts.forEach((cut, i) => {
    const dur = cutFrames(cut, data.fps);
    if (cut.main && !cut.subs) {
      const last = groups[groups.length - 1];
      const continuous =
        last &&
        last.from + last.dur === cursor &&
        last.def.text === cut.main.text &&
        (last.def.orientation ?? 'vertical') === (cut.main.orientation ?? 'vertical');
      if (continuous) {
        last.dur += dur;
        last.cutIndices.push(i);
      } else {
        groups.push({from: cursor, dur, def: cut.main, cutIndices: [i]});
      }
    }
    cursor += dur;
  });
  return groups;
};

/** 秒をフレームグリッドに丸める（小数 3 桁） */
export const snapSec = (sec: number, fps: number): number => Math.round((Math.round(sec * fps) / fps) * 1000) / 1000;

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
