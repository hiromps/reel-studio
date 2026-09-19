// planCuts: catalog.json + brief.json + format-spec → cuts.json の骨組み（src/in/out/役割/テロップグループ）を決定論的に生成する。
// テロップ文は "{{gNN:intent}}" のプレースホルダで出し、Claude（またはユーザー）が埋める。乱数は使わない。
import type {Catalog, Clip, ClipKind, UsableRange} from './schema/catalog';
import type {Brief, SavePriority} from './schema/brief';
import type {FormatSpec, SegmentRules} from './schema/format-spec';
import {isDefaultCrop, type AliasOp, type Cut, type Orientation, type ReelData, type Slot, type SlotRole, type TelopGroupMeta, type TextStatus} from './schema/cuts';
import {FORMAT_SPECS} from './format-specs';
import {getPersona, type Persona} from './personas';
import {cutDurationSec, snapSec, round3} from './timeline';
import {minDisplaySec} from './telop-text';
import {stableHash} from './hash';

export class PlanError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type PlanWarning = {code: string; message: string; clipId?: string; segment?: string};

export type CutTableRow = {
  no: number;
  segment: string;
  role: string;
  kind: string;
  clipId: string;
  clip: string;
  inSec: number;
  outSec: number;
  durSec: number;
  rate?: number;
  telop: string;
  qc: string[];
};

export type PlanOptions = {
  /** 素材が足りないとき、別区間が残っているクリップを再利用する（既定 true。alias コピーになる） */
  allowReuse?: boolean;
  /** meta.generated.at に入れる時刻（テストの決定論用） */
  now?: string;
};

export type PlanInput = {
  catalog: Catalog;
  brief: Brief;
  spec?: FormatSpec;
  persona?: Persona;
  existing?: ReelData;
  options?: PlanOptions;
};

export type PlanResult = {
  cuts: ReelData;
  aliases: AliasOp[];
  table: CutTableRow[];
  warnings: PlanWarning[];
  markdown: string;
};

// ───────────────────────── 内部型 ─────────────────────────

type Range = {inSec: number; outSec: number; label: UsableRange['label']};

type PoolClip = {
  clip: Clip;
  ranges: Range[];
  usedCount: number;
  isSignage: boolean;
  isSpeech: boolean;
  /** 予約専用（F7 の signage 温存）。貪欲割当の候補にしない */
  reservedOnly: boolean;
};

type SlotDef = {
  key: string;
  segment: string;
  segmentLabel: string;
  role: SlotRole;
  desiredSec: number;
  cutSecMin: number;
  cutSecMax: number;
  rules: SegmentRules;
  telopSpan: [number, number];
  unitIndex?: number;
  unitClipIds?: string[];
  unitBadge?: string;
  unitLabel?: string;
  /** 区間内の序数（locked 突合に使う） */
  ordinal: number;
  /** リビール直前の焦らし（「その名も・・・」の draft を入れる） */
  teaseBeforeReveal?: boolean;
};

type Assignment = {
  slot: SlotDef;
  clip: Clip;
  inSec: number;
  outSec: number;
  rate?: number;
  subs?: {startSec: number; endSec: number}[];
  locked?: Cut;
};

const mid = (r: [number, number]) => (r[0] + r[1]) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const byId = (a: {id: string}, b: {id: string}) => a.id.localeCompare(b.id, 'en', {numeric: true});

// ───────────────────────── kindFit ─────────────────────────

const KIND_FIT: Record<SlotRole, Partial<Record<ClipKind, number>> & {_: number}> = {
  hook: {sizzle: 1, eating: 1, cooking: 0.9, serving: 0.9, interior: 0.5, exterior: 0.4, detail: 0.5, person: 0.5, menu: 0.3, conversation: 0.2, signage: 0, _: 0.3},
  proof: {sizzle: 1, serving: 1, cooking: 1, eating: 0.9, detail: 0.7, interior: 0.6, menu: 0.5, person: 0.5, exterior: 0.4, signage: 0.2, conversation: 0.3, _: 0.3},
  tease: {interior: 1, person: 1, exterior: 1, detail: 0.8, menu: 0.5, serving: 0.5, conversation: 0.5, sizzle: 0.3, eating: 0.3, cooking: 0.3, signage: 0, _: 0.5},
  reveal: {signage: 1, exterior: 0.7, interior: 0.4, _: 0.2},
  sizzle: {sizzle: 1, eating: 1, cooking: 1, serving: 0.8, detail: 0.4, interior: 0.2, menu: 0.2, person: 0.2, exterior: 0.1, signage: 0.1, conversation: 0.1, _: 0.2},
  info: {interior: 1, exterior: 1, menu: 1, detail: 1, serving: 1, person: 0.7, eating: 0.6, sizzle: 0.5, cooking: 0.5, signage: 0.5, conversation: 0.5, _: 0.5},
  conversation: {conversation: 1, person: 0.8, _: 0.1},
  badgeHead: {signage: 1, exterior: 1, serving: 0.8, interior: 0.6, _: 0.4},
  cta: {signage: 1, exterior: 1, serving: 0.9, interior: 0.7, eating: 0.6, person: 0.6, sizzle: 0.5, detail: 0.5, _: 0.4},
  filler: {_: 0.5},
};

const kindFit = (role: SlotRole, kind: ClipKind | undefined): number => {
  const m = KIND_FIT[role];
  if (!kind) return m._;
  return m[kind] ?? m._;
};

const PRIORITY_KEYWORDS: Record<SavePriority, string[]> = {
  access: ['駅', '徒歩', '出口', '入口', '外観', '看板', '道', '階段', 'エレベーター'],
  budget: ['円', '価格', '値段', 'メニュー', '会計', 'レジ'],
  menu: ['メニュー', '看板', '一皿', '名物', '人気', 'おすすめ'],
  crowd: ['行列', '満席', '客', '店内', '並', '待ち'],
  hours: ['営業', '時計', '看板', '夜', '朝', '深夜', 'ネオン'],
  scene: ['席', 'ソファ', '個室', '雰囲気', '内装', 'カウンター', 'テーブル', 'ラウンジ'],
  howto: ['注文', 'タッチ', '券売機', '券', 'セルフ', '買', 'タップ', '画面', 'QR'],
  caution: ['注意', '現金', '定休', '予約', 'ラストオーダー', '禁煙'],
};

const priorityScore = (brief: Brief, clip: Clip): number => {
  const text = `${clip.tags?.description ?? ''} ${clip.tags?.subject ?? ''} ${clip.slug}`;
  const pri = brief.savePriorities;
  for (let k = 0; k < pri.length; k++) {
    if (PRIORITY_KEYWORDS[pri[k]].some((w) => text.includes(w))) return 1 - k / Math.max(pri.length, 1);
  }
  return 0;
};

// ───────────────────────── pool ─────────────────────────

/** usableRanges が無いときの既定区間。長回し（2.5 秒以上）は頭尾 0.2 秒を避け、短い（事前トリム済みらしい）クリップは全尺 */
const defaultRanges = (clip: Clip): Range[] => {
  const dur = clip.probe.durationSec;
  const margin = dur >= 2.5 ? 0.2 : 0;
  return [{inSec: margin, outSec: round3(dur - margin), label: 'ok'}];
};

const LABEL_ORDER: Record<Range['label'], number> = {best: 0, ok: 1, 'motion-full': 2, avoid: 9};

const buildPool = (catalog: Catalog, brief: Brief): PoolClip[] => {
  const ng = new Set(brief.ngClipIds);
  return catalog.clips
    .filter((c) => !c.user.ng && !ng.has(c.id))
    .map((clip) => {
      const usable = clip.usableRanges.filter((r) => r.label !== 'avoid' && r.outSec > r.inSec);
      const ranges: Range[] = (usable.length ? usable.map((r) => ({inSec: r.inSec, outSec: Math.min(r.outSec, clip.probe.durationSec), label: r.label})) : defaultRanges(clip)).sort(
        (a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label] || a.inSec - b.inSec,
      );
      return {
        clip,
        ranges,
        usedCount: 0,
        isSignage: clip.tags?.signage === true || clip.tags?.kind === 'signage',
        isSpeech: clip.tags?.hasSpeech === true || clip.tags?.kind === 'conversation' || (clip.speech?.length ?? 0) > 0,
        reservedOnly: false,
      };
    })
    .sort((a, b) => byId(a.clip, b.clip));
};

const remainingSec = (pc: PoolClip): number => pc.ranges.reduce((s, r) => s + (r.outSec - r.inSec), 0);
const longestRange = (pc: PoolClip): number => pc.ranges.reduce((m, r) => Math.max(m, r.outSec - r.inSec), 0);

/** 使った区間を pool から消費する。残りが 0.8 秒以上なら再利用候補として残す */
const consume = (pc: PoolClip, inSec: number, outSec: number) => {
  const next: Range[] = [];
  for (const r of pc.ranges) {
    if (outSec <= r.inSec || inSec >= r.outSec) {
      next.push(r);
      continue;
    }
    if (inSec - r.inSec >= 0.8) next.push({inSec: r.inSec, outSec: round3(inSec), label: r.label});
    if (r.outSec - outSec >= 0.8) next.push({inSec: round3(outSec), outSec: r.outSec, label: r.label});
  }
  pc.ranges = next.sort((a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label] || a.inSec - b.inSec);
  pc.usedCount++;
};

type Pick = {inSec: number; outSec: number; rate?: number};

/** 区間から in/out を決める。best → ok → motion-full の順。desired に満たない場合は最長の区間（≥0.8 秒） */
const chooseRange = (pc: PoolClip, desired: number, fps: number, maxCutSec: number, rateRange: [number, number]): Pick | null => {
  const adjustScene = (inSec: number, outSec: number): number => {
    const s = pc.clip.scenes?.find((x) => x > inSec && x <= inSec + 0.15);
    if (s !== undefined && outSec - (s + 0.15) >= 0.8) return s + 0.15;
    return inSec;
  };
  for (const r of pc.ranges) {
    const len = r.outSec - r.inSec;
    if (r.label === 'motion-full' && len > maxCutSec && len <= maxCutSec * 1.5) {
      const rate = clamp(Math.ceil(len / maxCutSec / 0.25) * 0.25, rateRange[0], rateRange[1]);
      return {inSec: snapSec(r.inSec, fps), outSec: snapSec(r.outSec, fps), rate};
    }
    if (len >= desired) {
      const inSec = adjustScene(r.inSec, r.outSec);
      const out = Math.min(r.outSec, inSec + desired);
      return {inSec: snapSec(inSec, fps), outSec: snapSec(out, fps)};
    }
  }
  const longest = [...pc.ranges].sort((a, b) => b.outSec - b.inSec - (a.outSec - a.inSec) || a.inSec - b.inSec)[0];
  if (!longest) return null;
  const len = longest.outSec - longest.inSec;
  if (len < 0.8) return null;
  const inSec = adjustScene(longest.inSec, longest.outSec);
  return {inSec: snapSec(inSec, fps), outSec: snapSec(Math.min(longest.outSec, inSec + maxCutSec), fps)};
};

// ───────────────────────── slots ─────────────────────────

const buildSlots = (spec: FormatSpec, scale: number, targetSec: number, brief: Brief, warnings: PlanWarning[]): SlotDef[] => {
  type SegPlan = {
    id: string;
    label: string;
    budget: number;
    cutSec: [number, number];
    cutsMin: number;
    cutsMax: number;
    rolePattern: string[];
    rules: SegmentRules;
    telopSpan: [number, number];
    unitIndex?: number;
    unitClipIds?: string[];
    unitBadge?: string;
    unitLabel?: string;
    count: number;
  };
  const segs: SegPlan[] = [];
  for (const s of spec.segments) {
    if (spec.repeat && s.id === spec.repeat.segmentId) {
      const rep = spec.repeat;
      let units = brief.units ?? [];
      if (units.length < rep.count[0]) {
        warnings.push({code: 'UNITS_MISSING', message: `${spec.id} は brief.units を ${rep.count[0]}〜${rep.count[1]} 個要求（現在 ${units.length}）。不足分は自動割当`, segment: s.id});
        units = [...units];
        while (units.length < rep.count[0]) units.push({label: `${rep.unitLabel}${units.length + 1}`, badge: rep.order === 'desc' ? `第${rep.count[0] - units.length}位` : `${units.length + 1}`, clipIds: []});
      }
      if (units.length > rep.count[1]) units = units.slice(0, rep.count[1]);
      const ordered = rep.order === 'desc' ? [...units].reverse() : units;
      const budgetAll = (s.timeSec[1] - s.timeSec[0]) * scale;
      const weights = ordered.map((_, i) => (i === ordered.length - 1 ? 1.4 : 1));
      const wsum = weights.reduce((a, b) => a + b, 0);
      ordered.forEach((u, i) => {
        const budget = (budgetAll * weights[i]) / wsum;
        const headSec = mid(rep.head.cutSec);
        segs.push({id: `unit:${i + 1}:head`, label: `${u.label} 見出し`, budget: headSec, cutSec: rep.head.cutSec, cutsMin: 1, cutsMax: 1, rolePattern: ['badgeHead'], rules: {...s.rules, preferSignage: true, alternateAngle: false}, telopSpan: [1, 1], unitIndex: i, unitClipIds: u.clipIds, unitBadge: u.badge, unitLabel: u.label, count: 1});
        const cutsR = i === ordered.length - 1 && rep.items.lastUnitCuts ? rep.items.lastUnitCuts : rep.items.cuts;
        segs.push({id: `unit:${i + 1}:item`, label: `${u.label} 本編`, budget: budget - headSec, cutSec: rep.items.cutSec, cutsMin: cutsR[0], cutsMax: cutsR[1], rolePattern: rep.items.rolePattern, rules: s.rules, telopSpan: s.telopSpanCuts, unitIndex: i, unitClipIds: u.clipIds, unitLabel: u.label, count: cutsR[0]});
      });
      continue;
    }
    segs.push({id: s.id, label: s.label, budget: (s.timeSec[1] - s.timeSec[0]) * scale, cutSec: s.cutSec, cutsMin: s.cuts[0], cutsMax: s.cuts[1], rolePattern: s.rolePattern, rules: s.rules, telopSpan: s.telopSpanCuts, count: s.cuts[0]});
  }

  const desiredOf = (seg: SegPlan, idx: number, count: number): number => {
    if (seg.rules.closerLastCut) return idx === count - 1 ? seg.cutSec[1] : seg.cutSec[0];
    return mid(seg.cutSec);
  };
  const alloc = (seg: SegPlan) => {
    let sum = 0;
    for (let i = 0; i < seg.count; i++) sum += desiredOf(seg, i, seg.count);
    return sum;
  };
  // 予算残が最大の区間に 1 カットずつ足す（同値は区間順）
  for (let guard = 0; guard < 200; guard++) {
    const total = segs.reduce((s, seg) => s + alloc(seg), 0);
    if (total >= targetSec * 0.97) break;
    let best: SegPlan | null = null;
    let bestGap = -Infinity;
    for (const seg of segs) {
      if (seg.count >= seg.cutsMax) continue;
      const gap = seg.budget - alloc(seg);
      if (gap > bestGap) {
        bestGap = gap;
        best = seg;
      }
    }
    if (!best) break;
    best.count++;
  }

  // カット数が上限に達しても予算が余る区間は、1 カット尺を cutSec の上限まで伸ばして埋める
  const stretchOf = (seg: SegPlan): number => {
    const a = alloc(seg);
    if (seg.count < seg.cutsMax || a >= seg.budget || a <= 0) return 1;
    return Math.min(seg.budget / a, seg.cutSec[1] / mid(seg.cutSec));
  };

  const slots: SlotDef[] = [];
  segs.forEach((seg) => {
    const stretch = stretchOf(seg);
    for (let i = 0; i < seg.count; i++) {
      const role = seg.rolePattern[i % seg.rolePattern.length] as SlotRole;
      slots.push({
        key: `${seg.id}#${i}`,
        segment: seg.id,
        segmentLabel: seg.label,
        role,
        desiredSec: round3(Math.min(seg.cutSec[1], desiredOf(seg, i, seg.count) * stretch)),
        cutSecMin: seg.cutSec[0],
        cutSecMax: seg.cutSec[1],
        rules: seg.rules,
        telopSpan: seg.telopSpan,
        unitIndex: seg.unitIndex,
        unitClipIds: seg.unitClipIds,
        unitBadge: seg.unitBadge,
        unitLabel: seg.unitLabel,
        ordinal: i,
      });
    }
  });
  // リビール直前の焦らしスロットに印
  const revealIdx = slots.findIndex((s) => s.role === 'reveal');
  if (revealIdx > 0 && slots[revealIdx - 1].role === 'tease') slots[revealIdx - 1].teaseBeforeReveal = true;
  return slots;
};

// ───────────────────────── 割当 ─────────────────────────

const signageSizeRank = (c: Clip) => ({large: 2, small: 1, none: 0})[c.tags?.signageSize ?? 'none'];

const sortSignage = (a: PoolClip, b: PoolClip) =>
  signageSizeRank(b.clip) - signageSizeRank(a.clip) ||
  (b.clip.tags?.quality ?? 0) - (a.clip.tags?.quality ?? 0) ||
  (b.clip.tags?.sizzleScore ?? 0) - (a.clip.tags?.sizzleScore ?? 0) ||
  b.clip.probe.durationSec - a.clip.probe.durationSec ||
  byId(a.clip, b.clip);

type Ctx = {
  spec: FormatSpec;
  brief: Brief;
  persona: Persona;
  fps: number;
  pool: PoolClip[];
  poolById: Map<string, PoolClip>;
  warnings: PlanWarning[];
  allowReuse: boolean;
};

const assignPick = (ctx: Ctx, slot: SlotDef, pc: PoolClip, pick: Pick, extra: Partial<Assignment> = {}): Assignment => {
  consume(pc, pick.inSec, pick.outSec);
  return {slot, clip: pc.clip, inSec: pick.inSec, outSec: pick.outSec, rate: pick.rate, ...extra};
};

const reserveHook = (ctx: Ctx, slots: SlotDef[], assigned: Map<string, Assignment>) => {
  const {brief, pool, poolById, spec, fps, warnings} = ctx;
  const hookSlot = slots.find((s) => s.role === 'hook');
  if (!hookSlot) return;
  if (!brief.hook) throw new PlanError('HOOK_REQUIRED', '冒頭フックに使うクリップ（brief.hook.clipId）が未指定。Claude が決めない規則のためユーザーに確認する');
  const pc = poolById.get(brief.hook.clipId);
  if (!pc) throw new PlanError('HOOK_CLIP_NOT_FOUND', `brief.hook.clipId=${brief.hook.clipId} が catalog に無いか NG 指定`);
  if (pc.isSignage) warnings.push({code: 'HOOK_SIGNAGE', message: `フック素材 ${pc.clip.id} に店名・看板が映る（validate で E になる）`, clipId: pc.clip.id});
  let pick: Pick | null = null;
  if (brief.hook.inSec !== undefined && brief.hook.outSec !== undefined && brief.hook.outSec > brief.hook.inSec) {
    let out = Math.min(brief.hook.outSec, pc.clip.probe.durationSec);
    if (out - brief.hook.inSec > spec.tempo.maxCutSec) {
      out = brief.hook.inSec + spec.tempo.maxCutSec;
      warnings.push({code: 'HOOK_TRIMMED', message: `フック指定 ${brief.hook.inSec}〜${brief.hook.outSec} が ${spec.tempo.maxCutSec} 秒を超えるため ${out} 秒で切る`, clipId: pc.clip.id});
    }
    pick = {inSec: snapSec(brief.hook.inSec, fps), outSec: snapSec(out, fps)};
  } else {
    pick = chooseRange(pc, hookSlot.desiredSec, fps, spec.tempo.maxCutSec, spec.tempo.playbackRateRange);
    if (pick?.rate) pick = {inSec: pick.inSec, outSec: snapSec(Math.min(pick.outSec, pick.inSec + hookSlot.desiredSec), fps)};
  }
  if (!pick) throw new PlanError('HOOK_CLIP_UNUSABLE', `フック素材 ${pc.clip.id} に 0.8 秒以上使える区間が無い`);
  assigned.set(hookSlot.key, assignPick(ctx, hookSlot, pc, pick));
  void pool;
};

const reserveSignage = (ctx: Ctx, slots: SlotDef[], assigned: Map<string, Assignment>) => {
  const {spec, brief, pool, fps, warnings} = ctx;
  if (brief.reveal && brief.reveal !== spec.reveal && spec.reveal !== 'none')
    warnings.push({code: 'REVEAL_MODE_IGNORED', message: `brief.reveal=${brief.reveal} だが ${spec.id} の既定は ${spec.reveal}。フォーマットを変えるには brief.format を変更する`});
  const signage = pool.filter((p) => p.isSignage).sort(sortSignage);
  const revealSlot = slots.find((s) => s.role === 'reveal' && !assigned.has(s.key));
  const pickFor = (slot: SlotDef, pc: PoolClip): Pick | null => {
    const p = chooseRange(pc, slot.desiredSec, fps, spec.tempo.maxCutSec, spec.tempo.playbackRateRange);
    if (p?.rate) return {inSec: p.inSec, outSec: snapSec(Math.min(p.outSec, p.inSec + slot.desiredSec), fps)};
    return p;
  };
  if (spec.reveal === 'late') {
    const ctaSlot = slots.find((s) => s.role === 'cta' && s.rules.preferSignage && !assigned.has(s.key));
    if (!signage.length) {
      warnings.push({code: 'NO_SIGNAGE_CLIP', message: '店名・看板が映るクリップが無い。リビールは外観/店内で代替（キャプションで店名を補う）'});
    } else {
      if (revealSlot) {
        const p = pickFor(revealSlot, signage[0]);
        if (p) assigned.set(revealSlot.key, assignPick(ctx, revealSlot, signage[0], p));
      }
      if (ctaSlot) {
        const second = signage[1] ?? signage[0];
        const p = pickFor(ctaSlot, second);
        if (p) assigned.set(ctaSlot.key, assignPick(ctx, ctaSlot, second, p));
      }
      for (const s of signage) s.reservedOnly = true; // 他の区間には出さない（正体の手掛かりを残さない）
    }
  } else if (spec.reveal === 'afterProof') {
    if (!signage.length) {
      warnings.push({code: 'NO_SIGNAGE_CLIP', message: '店名・看板が映るクリップが無い。店名リビールは外観/店内で代替'});
    } else if (revealSlot) {
      const p = pickFor(revealSlot, signage[0]);
      if (p) assigned.set(revealSlot.key, assignPick(ctx, revealSlot, signage[0], p));
    }
  }
};

const reserveSpeech = (ctx: Ctx, slots: SlotDef[], assigned: Map<string, Assignment>) => {
  const {brief, pool, fps, warnings} = ctx;
  if (!brief.speech.use) return;
  const speech = pool
    .filter((p) => p.isSpeech && !p.isSignage && !p.reservedOnly && p.usedCount === 0)
    .sort((a, b) => (b.clip.tags?.quality ?? 0) - (a.clip.tags?.quality ?? 0) || b.clip.probe.durationSec - a.clip.probe.durationSec || byId(a.clip, b.clip));
  const candidates = slots.filter((s) => s.rules.allowSpeech && !assigned.has(s.key) && s.role !== 'hook');
  const take = Math.min(2, speech.length, candidates.length);
  if (brief.speech.use && !speech.length) warnings.push({code: 'NO_SPEECH_CLIP', message: 'brief.speech.use=true だが hasSpeech のクリップが無い'});
  for (let i = 0; i < take; i++) {
    const pc = speech[i];
    const slot = candidates[i];
    const dur = pc.clip.probe.durationSec;
    const ranges = (pc.clip.speech ?? []).filter((r) => r.endSec > r.startSec).sort((a, b) => a.startSec - b.startSec);
    let inSec: number;
    let outSec: number;
    let used = ranges;
    if (ranges.length) {
      inSec = Math.max(0, ranges[0].startSec - 0.15);
      // 10 秒を超えないよう、収まる最後の発話までで切る
      used = ranges.filter((r) => r.endSec + 0.2 - inSec <= 10);
      if (!used.length) used = [ranges[0]];
      outSec = Math.min(dur, used[used.length - 1].endSec + 0.2);
    } else {
      inSec = 0;
      outSec = Math.min(dur, 10);
      used = [{startSec: inSec, endSec: outSec}];
    }
    const pick: Pick = {inSec: snapSec(inSec, fps), outSec: snapSec(outSec, fps)};
    const conv: SlotDef = {...slot, role: 'conversation', rules: {...slot.rules, defaultOrientation: 'horizontal'}};
    // slot 定義を差し替える（順序は維持）
    const idx = slots.indexOf(slot);
    slots[idx] = conv;
    assigned.set(conv.key, assignPick(ctx, conv, pc, pick, {subs: used.map((r) => ({startSec: Math.max(pick.inSec, r.startSec), endSec: Math.min(pick.outSec, r.endSec)}))}));
    pc.ranges = []; // 会話クリップは分割・再利用しない
  }
};

const greedyFill = (ctx: Ctx, slots: SlotDef[], assigned: Map<string, Assignment>) => {
  const {spec, brief, pool, fps, warnings, allowReuse} = ctx;
  const order = brief.order.mode === 'hint';
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (assigned.has(slot.key)) continue;
    const prev = i > 0 ? assigned.get(slots[i - 1].key) : undefined;
    const prev2 = i > 1 ? assigned.get(slots[i - 2].key) : undefined;
    const rules = slot.rules;
    const unitSet = slot.unitClipIds && slot.unitClipIds.length ? new Set(slot.unitClipIds) : null;

    const eligible = (pc: PoolClip, reuse: boolean): boolean => {
      if (pc.reservedOnly) return false;
      if (!reuse && pc.usedCount > 0) return false;
      if (reuse && pc.usedCount === 0) return false;
      if (longestRange(pc) < 0.8) return false;
      if (rules.noSignage && pc.isSignage) return false;
      if (rules.requireSignage && !pc.isSignage && pool.some((q) => q.isSignage && !q.reservedOnly && longestRange(q) >= 0.8)) return false;
      if (pc.clip.tags && rules.avoidKinds.includes(pc.clip.tags.kind)) return false;
      if (pc.isSpeech && slot.role !== 'conversation' && brief.speech.use) return false; // 会話クリップは保護
      if (unitSet && !unitSet.has(pc.clip.id)) return false;
      // 同一被写体 3 連続禁止
      const subj = pc.clip.tags?.subject;
      if (subj && prev?.clip.tags?.subject === subj && prev2?.clip.tags?.subject === subj) return false;
      return true;
    };

    const score = (pc: PoolClip): number => {
      const t = pc.clip.tags;
      const kind = t?.kind;
      const sizzleRole = slot.role === 'sizzle' || slot.role === 'proof' || slot.role === 'hook';
      let s = 40 * kindFit(slot.role, kind);
      s += 15 * (sizzleRole ? (t?.sizzleScore ?? 3) / 5 : 0.5);
      s += 10 * ((t?.quality ?? 3) / 5);
      if (prev && t && prev.clip.tags) {
        s += 12 * (t.angle !== prev.clip.tags.angle ? 1 : 0);
        s += 8 * (t.subject !== prev.clip.tags.subject ? 1 : 0);
      }
      const longest = longestRange(pc);
      s += 8 * (longest >= slot.desiredSec ? 1 : remainingSec(pc) >= slot.desiredSec ? 0.7 : 0);
      if (kind && rules.preferKinds.includes(kind)) s += 6;
      if (rules.preferSignage && pc.isSignage) s += 6;
      if (slot.role === 'info') s += 5 * priorityScore(brief, pc.clip);
      if (order && prev) {
        const a = prev.clip.user.orderHint;
        const b = pc.clip.user.orderHint;
        if (a !== null && b !== null && b < a) s -= 6;
      }
      s -= 4 * pc.usedCount;
      return s;
    };

    const rank = (list: PoolClip[]): PoolClip[] =>
      list
        .map((pc) => ({pc, s: score(pc)}))
        .sort(
          (a, b) =>
            b.s - a.s ||
            (b.pc.clip.tags?.quality ?? 0) - (a.pc.clip.tags?.quality ?? 0) ||
            (b.pc.clip.tags?.sizzleScore ?? 0) - (a.pc.clip.tags?.sizzleScore ?? 0) ||
            b.pc.clip.probe.durationSec - a.pc.clip.probe.durationSec ||
            byId(a.pc.clip, b.pc.clip),
        )
        .map((x) => x.pc);

    let ranked = rank(pool.filter((pc) => eligible(pc, false)));
    if (!ranked.length && allowReuse) ranked = rank(pool.filter((pc) => eligible(pc, true)));
    if (!ranked.length) {
      warnings.push({code: 'SLOT_DROPPED', message: `${slot.segmentLabel}（${slot.role}）に割り当てる素材が無い。スロットを削除`, segment: slot.segment});
      slots.splice(i, 1);
      i--;
      continue;
    }
    // 角度交互の準強制：最高点が prev と同角度で、スコア差 ≤12 の別角度候補があればそちら
    let chosen = ranked[0];
    if (rules.alternateAngle && prev?.clip.tags && chosen.clip.tags && chosen.clip.tags.angle === prev.clip.tags.angle) {
      const top = score(chosen);
      const alt = ranked.find((pc) => pc.clip.tags && pc.clip.tags.angle !== prev.clip.tags!.angle && top - score(pc) <= 12);
      if (alt) chosen = alt;
    }
    let pick = chooseRange(chosen, slot.desiredSec, fps, spec.tempo.maxCutSec, spec.tempo.playbackRateRange);
    if (!pick) {
      // 次点で再試行
      const next = ranked.find((pc) => pc !== chosen && chooseRange(pc, slot.desiredSec, fps, spec.tempo.maxCutSec, spec.tempo.playbackRateRange));
      if (!next) {
        warnings.push({code: 'SLOT_DROPPED', message: `${slot.segmentLabel}（${slot.role}）に使える区間が無い。スロットを削除`, segment: slot.segment});
        slots.splice(i, 1);
        i--;
        continue;
      }
      chosen = next;
      pick = chooseRange(chosen, slot.desiredSec, fps, spec.tempo.maxCutSec, spec.tempo.playbackRateRange)!;
    }
    if (pick.rate && slot.role === 'conversation') pick = {inSec: pick.inSec, outSec: snapSec(Math.min(pick.outSec, pick.inSec + spec.tempo.maxCutSec), fps)};
    assigned.set(slot.key, assignPick(ctx, slot, chosen, pick));
  }
};

/** locked スロット（existing.meta.slots[].locked）を同じ区間・序数のスロットに固定する */
const applyLocked = (ctx: Ctx, slots: SlotDef[], assigned: Map<string, Assignment>, existing: ReelData | undefined) => {
  if (!existing?.meta?.slots) return;
  const cutsById = new Map(existing.cuts.map((c) => [c.id, c]));
  const ordinalOf = new Map<string, number>();
  for (const s of existing.meta.slots) {
    const k = ordinalOf.get(s.segment) ?? 0;
    ordinalOf.set(s.segment, k + 1);
    if (!s.locked) continue;
    const cut = cutsById.get(s.cutId);
    if (!cut) continue;
    const slot = slots.find((x) => x.segment === s.segment && x.ordinal === k && !assigned.has(x.key));
    const pc = ctx.poolById.get(s.clipId);
    if (!slot || !pc) {
      ctx.warnings.push({code: 'LOCK_UNMATCHED', message: `locked カット ${s.cutId}（${s.segment}）を今回のスロットに対応付けできない`});
      continue;
    }
    assigned.set(slot.key, assignPick(ctx, slot, pc, {inSec: cut.inSec, outSec: cut.outSec, rate: cut.playbackRate}, {locked: cut}));
  }
};

const planAuto = (ctx: Ctx, slots: SlotDef[], existing?: ReelData): Assignment[] => {
  const assigned = new Map<string, Assignment>();
  applyLocked(ctx, slots, assigned, existing);
  reserveHook(ctx, slots, assigned);
  reserveSignage(ctx, slots, assigned);
  reserveSpeech(ctx, slots, assigned);
  greedyFill(ctx, slots, assigned);
  return slots.map((s) => assigned.get(s.key)).filter((a): a is Assignment => !!a);
};

/** 区間の割り当て（固定順・precut 用）：累積時間の割合で spec.segments に写像する */
const segmentAtFraction = (spec: FormatSpec, frac: number) => {
  const t = frac * spec.nominalSec;
  return spec.segments.find((s) => t >= s.timeSec[0] && t < s.timeSec[1]) ?? spec.segments[spec.segments.length - 1];
};

const planFixed = (ctx: Ctx, targetSec: number): Assignment[] => {
  const {brief, poolById, spec, fps, warnings} = ctx;
  const ids = brief.order.fixed ?? [];
  if (!ids.length) throw new PlanError('ORDER_FIXED_EMPTY', 'order.mode=fixed だが brief.order.fixed が空');
  const clips: PoolClip[] = [];
  for (const id of ids) {
    const pc = poolById.get(id);
    if (!pc) {
      warnings.push({code: 'FIXED_CLIP_SKIPPED', message: `固定順の clip ${id} が catalog に無いか NG 指定。飛ばす`, clipId: id});
      continue;
    }
    clips.push(pc);
  }
  const n = clips.length;
  if (!n) throw new PlanError('ORDER_FIXED_EMPTY', '固定順に使えるクリップが無い');
  const base = targetSec / n;
  const out: Assignment[] = [];
  const ordinalOf = new Map<string, number>();
  clips.forEach((pc, i) => {
    const seg = segmentAtFraction(spec, i / n);
    const ordinal = ordinalOf.get(seg.id) ?? 0;
    ordinalOf.set(seg.id, ordinal + 1);
    let role = seg.rolePattern[ordinal % seg.rolePattern.length] as SlotRole;
    if (i === 0) role = 'hook';
    if (i === n - 1) role = 'cta';
    const w = i === 0 ? 0.8 : i === n - 1 ? 1.3 : 1;
    const desired = clamp(base * w, Math.min(seg.cutSec[0] * 0.8, 1.0), Math.min(spec.tempo.maxCutSec, seg.cutSec[1] * 1.2));
    const slot: SlotDef = {key: `fixed#${i}`, segment: seg.id, segmentLabel: seg.label, role, desiredSec: desired, cutSecMin: seg.cutSec[0], cutSecMax: seg.cutSec[1], rules: seg.rules, telopSpan: seg.telopSpanCuts, ordinal};
    let pick: Pick | null = null;
    if (i === 0 && brief.hook && brief.hook.clipId === pc.clip.id && brief.hook.inSec !== undefined && brief.hook.outSec !== undefined) {
      pick = {inSec: snapSec(brief.hook.inSec, fps), outSec: snapSec(Math.min(brief.hook.outSec, brief.hook.inSec + spec.tempo.maxCutSec, pc.clip.probe.durationSec), fps)};
    } else {
      pick = chooseRange(pc, desired, fps, spec.tempo.maxCutSec, spec.tempo.playbackRateRange);
      if (pick?.rate) pick = {inSec: pick.inSec, outSec: snapSec(Math.min(pick.outSec, pick.inSec + desired), fps)};
    }
    if (!pick) {
      warnings.push({code: 'FIXED_CLIP_SKIPPED', message: `固定順の clip ${pc.clip.id} に 0.8 秒以上使える区間が無い。飛ばす`, clipId: pc.clip.id});
      return;
    }
    out.push(assignPick(ctx, slot, pc, pick));
  });
  return out;
};

const planPrecut = (ctx: Ctx): Assignment[] => {
  const {pool, spec, fps, warnings} = ctx;
  const pc = pool[0];
  if (!pc) throw new PlanError('PRECUT_NO_CLIP', 'precut モードだが使えるクリップが無い');
  if (pool.length > 1) warnings.push({code: 'PRECUT_MULTI_CLIP', message: `precut モードは単一ファイル前提。先頭の ${pc.clip.id} だけを使う`});
  const dur = pc.clip.probe.durationSec;
  let bounds = [0, ...(pc.clip.scenes ?? []).filter((s) => s > 0.25 && s < dur - 0.25).sort((a, b) => a - b), dur];
  // 0.4 秒未満の境界は間引く
  bounds = bounds.filter((b, i, arr) => i === 0 || b - arr[i - 1] >= 0.4);
  if (bounds[bounds.length - 1] !== dur) bounds.push(dur);
  if (bounds.length <= 2) {
    warnings.push({code: 'PRECUT_NO_SCENES', message: 'シーン境界が無いので 2.0 秒刻みで分割（scenes を catalog に入れると実カット割りになる）'});
    bounds = [];
    for (let t = 0; t < dur; t += 2.0) bounds.push(round3(t));
    bounds.push(dur);
  }
  const n = bounds.length - 1;
  const out: Assignment[] = [];
  const ordinalOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const seg = segmentAtFraction(spec, bounds[i] / dur);
    const ordinal = ordinalOf.get(seg.id) ?? 0;
    ordinalOf.set(seg.id, ordinal + 1);
    let role = seg.rolePattern[ordinal % seg.rolePattern.length] as SlotRole;
    if (i === 0) role = 'hook';
    if (i === n - 1) role = 'cta';
    const slot: SlotDef = {key: `precut#${i}`, segment: seg.id, segmentLabel: seg.label, role, desiredSec: bounds[i + 1] - bounds[i], cutSecMin: seg.cutSec[0], cutSecMax: seg.cutSec[1], rules: seg.rules, telopSpan: seg.telopSpanCuts, ordinal};
    out.push({slot, clip: pc.clip, inSec: snapSec(bounds[i], fps), outSec: snapSec(bounds[i + 1], fps)});
  }
  pc.usedCount = n;
  return out;
};

// ───────────────────────── telop groups ─────────────────────────

type GroupDraft = {id: string; members: number[]; intent: string; text?: string; textStatus: TextStatus; minSec: number; orientation: Orientation};

const buildGroups = (ctx: Ctx, asg: Assignment[], brief: Brief): GroupDraft[] => {
  const {spec, persona} = ctx;
  const groups: GroupDraft[] = [];
  const singleton = new Set<SlotRole>(['tease', 'reveal', 'cta', 'badgeHead', 'conversation']);
  const [gLo] = spec.telop.groupSecTarget;
  let i = 0;
  const priorities = [...brief.savePriorities];
  let pIdx = 0;
  let bodyGroupOrdinal = 0; // sizzle/info 混在区間でのグループ序数（偶数=シズル、奇数=実用情報 と交互にする）
  const pushGroup = (members: number[]) => {
    const first = asg[members[0]];
    const role = first.slot.role;
    let intent: string = role;
    const roles = members.map((m) => asg[m].slot.role);
    if (role === 'sizzle' || role === 'info' || role === 'filler') {
      const hasInfo = roles.includes('info');
      const hasSizzle = roles.includes('sizzle');
      const useInfo = hasInfo && (!hasSizzle || bodyGroupOrdinal % 2 === 1);
      if (useInfo) {
        if (pIdx < priorities.length) intent = priorities[pIdx++];
        else {
          const m = members.find((k) => asg[k].slot.role === 'info') ?? members[0];
          intent = `info:${asg[m].clip.tags?.subject ?? asg[m].clip.slug}`;
        }
      } else {
        const m = members.find((k) => asg[k].slot.role === 'sizzle') ?? members[0];
        intent = `sizzle:${asg[m].clip.tags?.subject ?? asg[m].clip.slug}`;
      }
      bodyGroupOrdinal++;
    } else if (role === 'badgeHead') intent = `unit:${first.slot.unitLabel ?? ''}`;
    const id = `g${String(groups.length + 1).padStart(2, '0')}`;
    groups.push({id, members, intent, textStatus: 'placeholder', minSec: Math.max(spec.telop.floorSec, spec.telop.maxChars * spec.telop.secPerChar), orientation: first.slot.rules.defaultOrientation});
  };
  while (i < asg.length) {
    const a = asg[i];
    const seg = a.slot.segment;
    const role = a.slot.role;
    if (role === 'hook') {
      // 同じ区間の hook スロットは 1 グループ（同一フック文が複数カットまたぎ）
      const members = [i];
      let j = i + 1;
      while (j < asg.length && asg[j].slot.segment === seg && asg[j].slot.role === 'hook' && members.length < a.slot.telopSpan[1]) members.push(j++);
      pushGroup(members);
      i = j;
      continue;
    }
    if (singleton.has(role)) {
      pushGroup([i]);
      i++;
      continue;
    }
    const span = a.slot.telopSpan;
    const members: number[] = [];
    let dur = 0;
    let j = i;
    while (j < asg.length && asg[j].slot.segment === seg && !singleton.has(asg[j].slot.role) && asg[j].slot.role !== 'hook') {
      members.push(j);
      dur += cutDurationSec(asg[j]);
      j++;
      if ((dur >= gLo && members.length >= span[0]) || members.length >= span[1]) break;
    }
    // 端数（1.0 秒未満）は直前のグループに併合
    const last = groups[groups.length - 1];
    const nextIsSameSeg = j < asg.length && asg[j].slot.segment === seg;
    if (dur < 1.0 && members.length < span[0] && last && !nextIsSameSeg && asg[last.members[0]].slot.segment === seg && !singleton.has(asg[last.members[0]].slot.role)) {
      last.members.push(...members);
    } else pushGroup(members);
    i = j;
  }

  // テキスト・向き・minSec
  for (const g of groups) {
    const first = asg[g.members[0]];
    const role = first.slot.role;
    const kind = first.clip.tags?.kind;
    if (role === 'conversation' || kind === 'person' || kind === 'conversation') g.orientation = 'horizontal';
    if (role === 'hook' && brief.hook?.text) {
      g.text = brief.hook.text;
      g.textStatus = 'final';
    } else if (role === 'tease' && first.slot.teaseBeforeReveal) {
      g.text = 'その名も・・・';
      g.textStatus = 'draft';
    } else if (role === 'reveal') {
      if (persona.allowEmptyReveal) {
        g.text = '';
        g.textStatus = 'final';
      } else {
        g.text = brief.shop.name;
        g.textStatus = 'draft';
      }
    } else if (role === 'cta') {
      g.text = persona.cta[0];
      g.textStatus = 'draft';
    }
    if (g.text) g.minSec = minDisplaySec(g.text, {secPerChar: spec.telop.secPerChar, floorSec: spec.telop.floorSec});
  }

  // precut の確定テロップを時刻で流し込む
  if (brief.materialMode === 'precut' && brief.precut?.fixedTelops.length) {
    let t = 0;
    const starts = asg.map((a) => {
      const s = t;
      t += cutDurationSec(a);
      return s;
    });
    brief.precut.fixedTelops.forEach((ft, k) => {
      let g: GroupDraft | undefined;
      if (ft.atSec !== undefined) g = groups.find((gr) => starts[gr.members[0]] <= ft.atSec! && ft.atSec! < starts[gr.members[gr.members.length - 1]] + cutDurationSec(asg[gr.members[gr.members.length - 1]]));
      else g = groups[k];
      if (g) {
        g.text = ft.text;
        g.textStatus = 'final';
        g.minSec = minDisplaySec(ft.text, {secPerChar: spec.telop.secPerChar, floorSec: spec.telop.floorSec});
      }
    });
  }
  return groups;
};

// ───────────────────────── alias ─────────────────────────

const aliasName = (src: string, blockOrdinal: number): string => {
  const letter = String.fromCharCode('a'.charCodeAt(0) + blockOrdinal); // 2 回目 → b
  const m = /^(.*\/)?(\d+)_([^/]+)\.([^./]+)$/.exec(src);
  if (m) return `${m[1] ?? ''}${m[2]}${letter}_${m[3]}-seg${blockOrdinal + 1}.${m[4]}`;
  const m2 = /^(.*)\.([^./]+)$/.exec(src);
  if (m2) return `${m2[1]}-seg${blockOrdinal + 1}.${m2[2]}`;
  return `${src}-seg${blockOrdinal + 1}`;
};

export const applyAliasNames = (cuts: Cut[]): AliasOp[] => {
  const ops: AliasOp[] = [];
  const blocks = new Map<string, number>(); // src → これまでのブロック数
  let prevSrc: string | null = null;
  let currentAlias: string | null = null;
  for (const c of cuts) {
    const src = c.src;
    if (src === prevSrc) {
      if (currentAlias) c.src = currentAlias;
      continue;
    }
    prevSrc = src;
    const k = blocks.get(src) ?? 0;
    blocks.set(src, k + 1);
    if (k === 0) {
      currentAlias = null;
      continue;
    }
    currentAlias = aliasName(src, k);
    ops.push({from: src, to: currentAlias, applied: false});
    c.src = currentAlias;
  }
  return ops;
};

// ───────────────────────── 出力 ─────────────────────────

export const tableToMarkdown = (rows: CutTableRow[]): string => {
  const head = '| No | 区間 | 役割 | 種別 | clip | IN | OUT | 尺 | rate | テロップ | QC |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map((r) => `| ${r.no} | ${r.segment} | ${r.role} | ${r.kind} | ${r.clipId} ${r.clip} | ${r.inSec.toFixed(2)} | ${r.outSec.toFixed(2)} | ${r.durSec.toFixed(2)} | ${r.rate ?? ''} | ${r.telop} | ${r.qc.join(',')} |`);
  return [head, sep, ...lines].join('\n');
};

export function planCuts(input: PlanInput): PlanResult {
  const {catalog, brief, existing} = input;
  const persona = input.persona ?? getPersona(brief.persona);
  const spec = input.spec ?? FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const warnings: PlanWarning[] = [];
  const fps = existing?.fps ?? catalog.dominantFps;
  const theme = brief.theme ?? spec.theme;
  const allowReuse = input.options?.allowReuse ?? true;
  const pool = buildPool(catalog, brief);
  if (!pool.length) throw new PlanError('NO_CLIPS', '使えるクリップが無い（全て NG か catalog が空）');
  const poolById = new Map(pool.map((p) => [p.clip.id, p]));
  const ctx: Ctx = {spec, brief, persona, fps, pool, poolById, warnings, allowReuse};
  const targetSec = clamp(brief.targetSec ?? spec.targetSec[1], spec.targetSec[0], spec.maxSec);
  const scale = targetSec / spec.nominalSec;

  const untagged = catalog.clips.filter((c) => !c.tags && !c.user.ng).length;
  if (untagged && brief.materialMode === 'raw' && brief.order.mode !== 'fixed')
    warnings.push({code: 'UNTAGGED_CLIPS', message: `${untagged} 本のクリップが未タグ。Claude がサムネイルを見て tags を書くと割当精度が上がる`});

  let asg: Assignment[];
  if (brief.materialMode === 'precut') asg = planPrecut(ctx);
  else if (brief.order.mode === 'fixed') asg = planFixed(ctx, targetSec);
  else asg = planAuto(ctx, buildSlots(spec, scale, targetSec, brief, warnings), existing);

  if (!asg.length) throw new PlanError('EMPTY_PLAN', 'カットが 1 つも作れなかった');

  const groups = buildGroups(ctx, asg, brief);
  const groupOfIndex = new Map<number, GroupDraft>();
  for (const g of groups) for (const m of g.members) groupOfIndex.set(m, g);

  const cuts: Cut[] = [];
  const slots: Slot[] = [];
  const rows: CutTableRow[] = [];
  asg.forEach((a, i) => {
    const id = `c${String(i + 1).padStart(2, '0')}`;
    const g = groupOfIndex.get(i)!;
    const qc: string[] = [];
    const cut: Cut = {id, src: a.clip.src, inSec: a.inSec, outSec: a.outSec};
    // 素材側で決めた「ここを見せる」（切り出し）をカットに引き継ぐ。既定のままなら書かない
    if (!isDefaultCrop(a.clip.crop)) cut.crop = {...a.clip.crop!};
    if (a.rate && a.rate !== 1) cut.playbackRate = a.rate;
    let telop = '';
    let textStatus: TextStatus = g.textStatus;
    if (a.locked) {
      // locked カットは既存のテロップをそのまま
      if (a.locked.main) cut.main = {...a.locked.main};
      if (a.locked.subs) cut.subs = a.locked.subs.map((s) => ({...s}));
      if (a.locked.badge) cut.badge = a.locked.badge;
      telop = a.locked.main?.text ?? '';
      textStatus = 'final';
    } else if (a.slot.role === 'conversation' && a.subs) {
      cut.subs = a.subs.map((s, k) => ({text: `{{sub:${id}:${k + 1}}}`, orientation: 'horizontal', startSec: round3(s.startSec), endSec: round3(s.endSec)}));
      telop = `{{sub:${id}:1..${a.subs.length}}}`;
    } else if (a.slot.role === 'reveal' && g.text === '' && persona.allowEmptyReveal) {
      telop = '（無言：看板を見せる）';
    } else {
      const text = g.text ?? `{{${g.id}:${g.intent}}}`;
      cut.main = {text};
      if (g.orientation === 'horizontal') cut.main.orientation = 'horizontal';
      telop = text;
      if (a.slot.role === 'badgeHead') {
        cut.badge = `{{badge:${a.slot.unitBadge ?? ''}}}`;
        telop = `${cut.badge} ${text}`;
      }
    }
    const isSignage = a.clip.tags?.signage === true || a.clip.tags?.kind === 'signage';
    if (isSignage && cut.main && (cut.main.orientation ?? 'vertical') === 'vertical') qc.push('signage-collision');
    if (a.clip.scenes?.some((s) => s > a.inSec && s <= a.inSec + 0.15)) qc.push('head-scene-change');
    cuts.push(cut);
    slots.push({cutId: id, segment: a.slot.segment, role: a.slot.role, clipId: a.clip.id, telopGroupId: g.id, textStatus, locked: !!a.locked, qc});
    rows.push({
      no: i + 1,
      segment: a.slot.segmentLabel,
      role: a.slot.role,
      kind: a.clip.tags?.kind ?? '-',
      clipId: a.clip.id,
      clip: a.clip.slug,
      inSec: a.inSec,
      outSec: a.outSec,
      durSec: round3(cutDurationSec(a)),
      rate: a.rate,
      telop,
      qc,
    });
  });

  const aliases = applyAliasNames(cuts);
  // alias で src が変わった行を table にも反映
  rows.forEach((r, i) => {
    if (cuts[i].src !== asg[i].clip.src) r.qc.push(`alias:${cuts[i].src}`);
  });

  const telopGroups: TelopGroupMeta[] = groups.map((g) => ({
    id: g.id,
    cutIds: g.members.map((m) => cuts[m].id!),
    intent: g.intent,
    placeholder: `{{${g.id}:${g.intent}}}`,
    minSec: round3(g.minSec),
  }));

  const total = asg.reduce((s, a) => s + cutDurationSec(a), 0);
  if (total > spec.maxSec + 0.05) warnings.push({code: 'OVER_MAX_SEC', message: `合計 ${total.toFixed(1)} 秒が ${spec.id} の上限 ${spec.maxSec} 秒を超える。カットを削るか targetSec を下げる`});
  if (total < spec.targetSec[0] * 0.85) warnings.push({code: 'UNDER_TARGET', message: `合計 ${total.toFixed(1)} 秒が想定 ${spec.targetSec[0]} 秒より短い（素材不足）`});

  const freeMeta: Record<string, unknown> = {};
  if (existing?.meta) {
    for (const [k, v] of Object.entries(existing.meta)) {
      if (['slots', 'telopGroups', 'aliases', 'generated'].includes(k)) continue;
      freeMeta[k] = v;
    }
  }
  const data: ReelData = {
    fps,
    theme,
    meta: {
      shop: brief.shop.name,
      format: `${spec.id} ${spec.name}`,
      selectedHook: brief.hook?.text ?? (freeMeta.selectedHook as string | undefined),
      ...freeMeta,
      slots,
      telopGroups,
      aliases,
      generated: {
        tool: 'reel-studio/plan',
        at: input.options?.now ?? new Date().toISOString(),
        briefHash: stableHash(brief),
        catalogHash: stableHash(catalog),
        specId: spec.id,
      },
    },
    cuts,
  };
  return {cuts: data, aliases, table: rows, warnings, markdown: tableToMarkdown(rows)};
}
