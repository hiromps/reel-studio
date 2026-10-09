import {stableHash} from './hash';
import {ReelDataSchema, type ReelData} from './schema/cuts';
import {NarrationSchema, type Narration} from './schema/narration';
import {cutRanges, round3, telopGroupsOf, totalSec} from './timeline';
import {isPlaceholder} from './telop-text';

export type TelopVoice = {voice: string; voiceTitle?: string; speed?: number};
export type SpokenTelop = {text: string; at: number; endSec: number; kind: 'main' | 'sub'};

/** 表示される文言をそのまま読む。同じ文言が続く部分は一度だけ、字幕は素材内の秒から配置秒へ変換する。 */
export const spokenTelops = (cuts: ReelData): {entries: SpokenTelop[]; skipped: number} => {
  const rows: SpokenTelop[] = telopGroupsOf(cuts).map(g => ({
    text: g.def.text, at: g.from / cuts.fps, endSec: (g.from + g.dur) / cuts.fps, kind: 'main',
  }));
  const ranges = cutRanges(cuts);
  cuts.cuts.forEach((cut, i) => {
    const rate = cut.playbackRate ?? 1;
    for (const sub of cut.subs ?? []) {
      const start = Math.max(cut.inSec, sub.startSec);
      const end = Math.min(cut.outSec, sub.endSec);
      if (end <= start) continue;
      const from = ranges[i].from + Math.max(0, Math.round(((start - cut.inSec) / rate) * cuts.fps));
      const to = Math.min(ranges[i].from + ranges[i].dur, ranges[i].from + Math.round(((end - cut.inSec) / rate) * cuts.fps));
      if (to <= from) continue;
      rows.push({text: sub.text, kind: 'sub',
        at: from / cuts.fps, endSec: to / cuts.fps,
      });
    }
  });
  const entries: SpokenTelop[] = [];
  let skipped = 0;
  for (const row of rows.sort((a, b) => a.at - b.at)) {
    if (!row.text.trim() || isPlaceholder(row.text)) {skipped++; continue;}
    const last = entries[entries.length - 1];
    if (last && last.kind === row.kind && last.text === row.text && Math.abs(last.endSec - row.at) < 0.5 / cuts.fps) {
      last.endSec = round3(row.endSec);
    } else entries.push({...row, at: round3(row.at), endSec: round3(row.endSec)});
  }
  return {entries, skipped};
};

export const telopVoice = (narration: Narration | null, defaults: TelopVoice): TelopVoice => ({
  voice: narration?.voice || defaults.voice,
  voiceTitle: narration?.voice ? narration.voiceTitle : defaults.voiceTitle,
  speed: narration?.speed ?? defaults.speed ?? 1.2,
});

/** 確認後・待機中にテロップや既存原稿が変わったら、古い内容で上書きしない。 */
export const telopNarrationConfirmation = (cuts: ReelData, narration: Narration | null, defaults: TelopVoice) => ({
  ...spokenTelops(cuts),
  voice: telopVoice(narration, defaults),
  fingerprint: stableHash({cuts: ReelDataSchema.parse(cuts), narration: narration ? NarrationSchema.parse(narration) : null, defaults}),
});

export const narrationFromTelops = (cuts: ReelData, narration: Narration | null, defaults: TelopVoice, batchId: string): Narration => {
  const {entries} = spokenTelops(cuts);
  if (!entries.length) throw new Error('音声化できるテロップがありません。空欄・未記入のテロップは読み上げません');
  const voice = telopVoice(narration, defaults);
  if (!voice.voice) throw new Error('ボイスが未設定です。Brief の人格、または Render のボイスを選んでください');
  return NarrationSchema.parse({
    ...(narration ?? {latency: 'normal'}), ...voice, videoSec: round3(totalSec(cuts)),
    // 新しいファイル名を使い、以前の音声を上書きしない。取り消しで元の原稿と音声へ戻れる。
    segments: entries.map((entry, i) => ({id: `telop_${batchId}_${String(i + 1).padStart(3, '0')}`,
      label: `テロップ ${i + 1}`, at: entry.at, text: entry.text, fromTelop: true, needsTts: true,
    })),
  });
};
