// cuts.json の検証。E（レンダー不可）と W（警告）を返す。catalog / brief / spec / persona が無いルールは skip に列挙する。
// 原典: edit-pipeline.md（テンポ規則・保護規則）、telop-style.md（13文字・最低表示時間）、format-patterns.md（尺上限・F7）。
import {ReelDataSchema, type Cut, type ReelData, type Slot} from './schema/cuts';
import type {Catalog, Clip} from './schema/catalog';
import type {Brief} from './schema/brief';
import type {FormatSpec} from './schema/format-spec';
import type {Persona} from './personas';
import {cutDurationSec, cutRanges, telopGroupsOf, totalSec as totalSecOf, calcTotalFrames} from './timeline';
import {
  countChars,
  ellipsisCount,
  forbiddenChars,
  hasExactPrice,
  hasTrailingPeriod,
  isPlaceholder,
  leadingArea,
  looksLikeAreaDigitHook,
  minDisplaySec,
} from './telop-text';

export type Severity = 'E' | 'W';

export type Fix =
  | {type: 'trimTo'; payload: {outSec: number}}
  | {type: 'alias'; payload: {src: string}}
  | {type: 'setRate'; payload: {playbackRate: number | null}}
  | {type: 'orientation'; payload: {orientation: 'vertical' | 'horizontal'}}
  | {type: 'removeKey'; payload: {key: string}};

export type Issue = {
  code: string;
  severity: Severity;
  cutId?: string;
  cutIndex?: number;
  groupId?: string;
  message: string;
  fix?: Fix;
};

export type ValidationSummary = {
  totalSec: number;
  totalFrames: number;
  cutCount: number;
  avgCutSec: number;
  groupCount: number;
  revealPct?: number;
  placeholders: number;
};

export type ValidationResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  summary: ValidationSummary;
  skipped: string[];
};

export type ValidateContext = {
  catalog?: Catalog;
  brief?: Brief;
  spec?: FormatSpec;
  persona?: Persona;
  /** src の実在確認（CLI/server が渡す）。無ければ SRC_MISSING を skip */
  srcExists?: (src: string) => boolean;
  /** PROXY_RECOMMENDED を E に格上げ */
  strictProxy?: boolean;
  /** 案件の src/*.tsx がマスターと差分（CLI/server が渡す） */
  engineStale?: boolean;
};

const CUT_TOO_SHORT_SEC = 0.6;
const HOOK_TOO_SHORT_SEC = 0.8;
const CONVERSATION_MAX_SEC = 10;
const SUB_MAX_CHARS = 20;

const cutLabel = (c: Cut, i: number): string => c.id ?? `#${i + 1}`;

/** 素材ファイル名の連番部分を除いた slug で catalog を引く（alias 名 "08b_x-seg2.mp4" → "08_x.mp4"） */
export const resolveClip = (catalog: Catalog | undefined, src: string, aliases: Map<string, string>): Clip | undefined => {
  if (!catalog) return undefined;
  const real = aliases.get(src) ?? src;
  return catalog.clips.find((c) => c.src === real || c.proxyOf === real);
};

/** 区間 → allowPrice 判定用 */
const segmentRules = (spec: FormatSpec | undefined, segmentId: string | undefined) => {
  if (!spec || !segmentId) return undefined;
  const seg = spec.segments.find((s) => s.id === segmentId);
  if (seg) return seg.rules;
  // "unit:1:head" など repeat 展開の区間は repeat 元の segment 規則を使う
  if (segmentId.startsWith('unit:') && spec.repeat) return spec.segments.find((s) => s.id === spec.repeat!.segmentId)?.rules;
  return undefined;
};

export function validateCuts(input: unknown, ctx: ValidateContext = {}): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const skipped: string[] = [];
  const E = (i: Omit<Issue, 'severity'>) => errors.push({...i, severity: 'E'});
  const W = (i: Omit<Issue, 'severity'>) => warnings.push({...i, severity: 'W'});

  const parsed = ReelDataSchema.safeParse(input);
  if (!parsed.success) {
    for (const iss of parsed.error.issues.slice(0, 20)) {
      E({code: 'SCHEMA', message: `${iss.path.join('.') || '(root)'}: ${iss.message}`});
    }
    return {
      ok: false,
      errors,
      warnings,
      summary: {totalSec: 0, totalFrames: 0, cutCount: 0, avgCutSec: 0, groupCount: 0, placeholders: 0},
      skipped,
    };
  }
  const data: ReelData = parsed.data;
  const {catalog, brief, spec, persona} = ctx;
  const cuts = data.cuts;
  const n = cuts.length;
  const ranges = cutRanges(data);
  const total = totalSecOf(data);
  const groups = telopGroupsOf(data);
  const maxCutSec = spec?.tempo.maxCutSec ?? 3.0;
  const telopRule = spec?.telop ?? {maxChars: 13, secPerChar: 0.25, floorSec: 1.2, groupSecTarget: [1.8, 2.0] as [number, number], maxEllipsis: 3};

  const aliases = new Map<string, string>();
  for (const a of data.meta?.aliases ?? []) aliases.set(a.to, a.from);
  const slotsByCut = new Map<string, Slot>();
  for (const s of data.meta?.slots ?? []) slotsByCut.set(s.cutId, s);
  const slotOf = (c: Cut): Slot | undefined => (c.id ? slotsByCut.get(c.id) : undefined);
  const roleOf = (c: Cut, i: number): string => {
    const s = slotOf(c);
    if (s) return s.role;
    if (c.subs && c.subs.length) return 'conversation';
    if (i === 0) return 'hook';
    if (i === n - 1) return 'cta';
    return 'body';
  };

  if (!catalog) skipped.push('OUT_BEYOND_DURATION', 'NG_CLIP_USED', 'SAME_ANGLE_RUN', 'SAME_SUBJECT_RUN3', 'HEAD_SCENE_CHANGE', 'FPS_MISMATCH', 'HOOK_SIGNAGE', 'F7_SIGNAGE_EARLY', 'REVEAL_MISSING', 'PROXY_RECOMMENDED', 'SRC_NOT_IN_CATALOG');
  if (!brief) skipped.push('HOOK_NOT_USER', 'ORDER_FIXED_VIOLATION', 'HOOK_AREA_IN_TELOP');
  if (!spec) skipped.push('TOTAL_OVER_MAX', 'TOTAL_UNDER_TARGET', 'CUT_COUNT_OUT_OF_RANGE', 'F7_REVEAL_POSITION', 'F7_TEASE_MISSING', 'BADGE_MISSING', 'THEME_MISMATCH', 'PRICE_DEPRECATED');
  if (!persona) skipped.push('CTA_TEXT', 'HOOK_TEXT_PATTERN');
  if (!ctx.srcExists) skipped.push('SRC_MISSING');
  if (ctx.engineStale === undefined) skipped.push('ENGINE_STALE');

  // ── 構造 ────────────────────────────────────────────────
  const lastIndexOfSrc = new Map<string, number>();
  let placeholders = 0;
  const clipOfCut: (Clip | undefined)[] = [];

  cuts.forEach((c, i) => {
    const id = cutLabel(c, i);
    const role = roleOf(c, i);
    const rate = c.playbackRate;
    const clip = resolveClip(catalog, c.src, aliases);
    clipOfCut.push(clip);

    if (c.inSec < 0 || c.inSec >= c.outSec) E({code: 'RANGE_INVALID', cutId: id, cutIndex: i, message: `inSec(${c.inSec}) >= outSec(${c.outSec})`});
    if (catalog) {
      if (!clip) W({code: 'SRC_NOT_IN_CATALOG', cutId: id, cutIndex: i, message: `catalog に無い src: ${c.src}`});
      else {
        if (c.outSec > clip.probe.durationSec + 0.01)
          E({code: 'OUT_BEYOND_DURATION', cutId: id, cutIndex: i, message: `outSec ${c.outSec} > 素材尺 ${clip.probe.durationSec.toFixed(3)}（${c.src}）`, fix: {type: 'trimTo', payload: {outSec: Math.floor(clip.probe.durationSec * 1000) / 1000}}});
        if (clip.user.ng || brief?.ngClipIds.includes(clip.id)) E({code: 'NG_CLIP_USED', cutId: id, cutIndex: i, message: `NG 指定のクリップ ${clip.id}（${c.src}）を使用`});
        if (clip.scenes?.some((s) => s > c.inSec && s <= c.inSec + 0.15))
          W({code: 'HEAD_SCENE_CHANGE', cutId: id, cutIndex: i, message: `IN 点の直後 0.15 秒以内にシーン境界がある（${c.src}）`});
        const codec = clip.probe.codec.toLowerCase();
        if (codec === 'hevc' || codec === 'h265' || Math.max(clip.probe.width, clip.probe.height) > 1920) {
          const iss = {code: 'PROXY_RECOMMENDED', cutId: id, cutIndex: i, message: `${c.src} は ${clip.probe.codec} ${clip.probe.width}x${clip.probe.height}。H.264 1080x1920 プロキシを推奨`};
          if (ctx.strictProxy) E(iss);
          else W(iss);
        }
      }
    }
    if (ctx.srcExists && !ctx.srcExists(c.src)) E({code: 'SRC_MISSING', cutId: id, cutIndex: i, message: `ファイルが無い: ${c.src}`});

    if (c.subs && c.subs.length && c.main) E({code: 'SUBS_AND_MAIN', cutId: id, cutIndex: i, message: 'subs と main は併用しない'});
    if (c.subs && c.subs.length) {
      const sorted = [...c.subs].sort((a, b) => a.startSec - b.startSec);
      sorted.forEach((s, j) => {
        if (s.startSec < c.inSec - 0.001 || s.endSec > c.outSec + 0.001 || s.startSec >= s.endSec)
          E({code: 'SUBS_RANGE', cutId: id, cutIndex: i, message: `subs[${j}] ${s.startSec}〜${s.endSec} が [inSec, outSec] の外か逆転`});
        if (j > 0 && s.startSec < sorted[j - 1].endSec - 0.001) E({code: 'SUBS_RANGE', cutId: id, cutIndex: i, message: `subs[${j}] が前の字幕と重なる`});
        if (countChars(s.text) > SUB_MAX_CHARS) W({code: 'SUBS_TOO_LONG', cutId: id, cutIndex: i, message: `subs[${j}] が ${countChars(s.text)} 文字（上限 ${SUB_MAX_CHARS}）`});
        if ((s.orientation ?? 'vertical') !== 'horizontal') W({code: 'SUBS_ORIENTATION', cutId: id, cutIndex: i, message: `subs[${j}] は横書き（上部）が原則`, fix: {type: 'orientation', payload: {orientation: 'horizontal'}}});
        if (isPlaceholder(s.text)) placeholders++;
      });
    }

    if (rate !== undefined) {
      if (rate <= 0.5 || rate > 2) E({code: 'PLAYBACK_RATE_RANGE', cutId: id, cutIndex: i, message: `playbackRate ${rate} は (0.5, 2] の外`});
      if ((role === 'conversation' || (c.subs && c.subs.length)) && rate !== 1)
        E({code: 'CONVERSATION_RATE', cutId: id, cutIndex: i, message: '会話クリップは倍速禁止（声のピッチが変わる）', fix: {type: 'setRate', payload: {playbackRate: null}}});
      else if (![1, 1.25, 1.5].includes(rate)) W({code: 'PLAYBACK_RATE_UNUSUAL', cutId: id, cutIndex: i, message: `playbackRate ${rate} は 1 / 1.25 / 1.5 以外`});
    }

    const prevIdx = lastIndexOfSrc.get(c.src);
    if (prevIdx !== undefined && prevIdx !== i - 1)
      E({code: 'SAME_SRC_NONCONSECUTIVE', cutId: id, cutIndex: i, message: `同一 src を非連続で再参照（前回 #${prevIdx + 1}）。Windows でレンダーが不安定になるため別名コピーにする`, fix: {type: 'alias', payload: {src: c.src}}});
    lastIndexOfSrc.set(c.src, i);

    // ── テンポ ──
    const dur = cutDurationSec(c);
    if (role === 'conversation') {
      if (dur > CONVERSATION_MAX_SEC) W({code: 'CONVERSATION_TOO_LONG', cutId: id, cutIndex: i, message: `会話クリップが ${dur.toFixed(2)} 秒（目安 ${CONVERSATION_MAX_SEC} 秒以内）`});
    } else if (dur > maxCutSec + 0.001) {
      E({code: 'CUT_TOO_LONG', cutId: id, cutIndex: i, message: `${dur.toFixed(2)} 秒（上限 ${maxCutSec} 秒。倍速か分割）`, fix: {type: 'trimTo', payload: {outSec: Math.round((c.inSec + maxCutSec * (rate ?? 1)) * 1000) / 1000}}});
    }
    const shortLimit = role === 'hook' ? HOOK_TOO_SHORT_SEC : CUT_TOO_SHORT_SEC;
    if (dur < shortLimit) W({code: 'CUT_TOO_SHORT', cutId: id, cutIndex: i, message: `${dur.toFixed(2)} 秒（目安 ${shortLimit} 秒以上）`});

    // ── テロップ（カット単位） ──
    if (c.main) {
      const t = c.main.text;
      if (isPlaceholder(t)) {
        placeholders++;
        E({code: 'TELOP_PLACEHOLDER', cutId: id, cutIndex: i, message: `未記入のプレースホルダ: ${t}`});
      } else if (t.trim().length > 0) {
        const len = countChars(t);
        if (len > telopRule.maxChars + 5) E({code: 'TELOP_TOO_LONG', cutId: id, cutIndex: i, message: `${len} 文字（${telopRule.maxChars} 文字以内。自動縮小の限界も超える）: ${t}`});
        else if (len > telopRule.maxChars) W({code: 'TELOP_OVER_MAX_CHARS', cutId: id, cutIndex: i, message: `${len} 文字（目安 ${telopRule.maxChars} 文字以内。自動縮小される）: ${t}`});
        if (hasTrailingPeriod(t)) E({code: 'TELOP_PERIOD', cutId: id, cutIndex: i, message: `末尾に句点: ${t}`});
        const fb = forbiddenChars(t);
        if (fb.length) E({code: 'TELOP_FORBIDDEN_CHARS', cutId: id, cutIndex: i, message: `禁則文字 ${fb.join('')}（半角括弧・絵文字）: ${t}`});
        const rules = segmentRules(spec, slotOf(c)?.segment);
        if (hasExactPrice(t) && !rules?.allowPrice) W({code: 'TELOP_EXACT_PRICE', cutId: id, cutIndex: i, message: `価格の明示（原則キャプションのみ）: ${t}`});
      }
    } else if (!(c.subs && c.subs.length)) {
      if (role !== 'reveal') W({code: 'TELOP_MISSING', cutId: id, cutIndex: i, message: 'main も subs も無いカット（意図的な無言カットなら無視してよい）'});
    }
    if (c.badge) {
      if (isPlaceholder(c.badge)) {
        placeholders++;
        E({code: 'TELOP_PLACEHOLDER', cutId: id, cutIndex: i, message: `badge が未記入: ${c.badge}`});
      }
      // badge は型を問わず使ってよい。F2（順位）と F6（店名）だけは**構造として要る**ので、
      // 無いときに BADGE_MISSING で催促する。それ以外の型では単なる演出（エリア名バッジ等）で、
      // 2026-09-12 にユーザーが F0・F3 で使いたいと明示したため型による禁止はやめた
    }
    if (c.price) {
      const rules = segmentRules(spec, slotOf(c)?.segment);
      if (spec && !rules?.allowPrice) W({code: 'PRICE_DEPRECATED', cutId: id, cutIndex: i, message: 'price テロップは廃止（F3 の残金カウンター等の例外のみ）', fix: {type: 'removeKey', payload: {key: 'price'}}});
    }

    // 連続カットで同文言なのに orientation が違う（telopGroups が分断されてチラつく）
    if (i > 0 && c.main && cuts[i - 1].main && cuts[i - 1].main!.text === c.main.text && (cuts[i - 1].main!.orientation ?? 'vertical') !== (c.main.orientation ?? 'vertical'))
      W({code: 'TELOP_GROUP_SPLIT', cutId: id, cutIndex: i, message: '前カットと同文言だが orientation が違う（フェードインが2回になる）', fix: {type: 'orientation', payload: {orientation: cuts[i - 1].main!.orientation ?? 'vertical'}}});
  });

  // ── テロップ（グループ単位：最低表示時間） ──
  groups.forEach((g, gi) => {
    const t = g.def.text;
    if (!t || isPlaceholder(t)) return;
    const shown = g.dur / data.fps;
    const need = minDisplaySec(t, {secPerChar: telopRule.secPerChar, floorSec: telopRule.floorSec});
    const firstCut = cuts[g.cutIndices[0]];
    const base = {groupId: `g${String(gi + 1).padStart(2, '0')}`, cutId: cutLabel(firstCut, g.cutIndices[0]), cutIndex: g.cutIndices[0]};
    if (shown + 0.001 < need) {
      const msg = `「${t}」の表示 ${shown.toFixed(2)} 秒 < 目安 ${need.toFixed(2)} 秒（${countChars(t)} 文字）。次カットにまたがらせるか文を短く`;
      // 0.8 秒未満は物理的に読めないので E。それ以上は目安違反として W（納品実績に 1.0 秒×10 文字が存在するため）
      if (shown < 0.8) E({code: 'TELOP_MIN_DISPLAY', ...base, message: msg});
      else W({code: 'TELOP_MIN_DISPLAY', ...base, message: msg});
    }
  });
  const ellipsisTotal = groups.reduce((s, g) => s + ellipsisCount(g.def.text), 0);
  if (ellipsisTotal > telopRule.maxEllipsis) W({code: 'TELOP_ELLIPSIS_OVERUSE', message: `「・・・」が ${ellipsisTotal} 回（目安 ${telopRule.maxEllipsis} 回以内。焦らしは山場直前に絞る）`});
  {
    const lo = Math.floor(total / telopRule.groupSecTarget[1]) - 1;
    const hi = Math.ceil(total / telopRule.groupSecTarget[0]) + 1;
    if (groups.length < lo || groups.length > hi)
      W({code: 'TELOP_GROUP_COUNT', message: `テロップ ${groups.length} グループ（尺 ${total.toFixed(1)} 秒なら目安 ${Math.max(lo, 1)}〜${hi}）`});
  }

  // ── 全体の尺・カット数 ──
  if (spec) {
    if (total > spec.maxSec + 0.05) E({code: 'TOTAL_OVER_MAX', message: `合計 ${total.toFixed(2)} 秒 > ${spec.id} の上限 ${spec.maxSec} 秒`});
    if (total < spec.targetSec[0] * 0.85) W({code: 'TOTAL_UNDER_TARGET', message: `合計 ${total.toFixed(2)} 秒 < 想定 ${spec.targetSec[0]} 秒の 85%`});
    const k = total / spec.nominalSec;
    const lo = Math.floor(spec.tempo.totalCuts[0] * k);
    const hi = Math.ceil(spec.tempo.totalCuts[1] * k);
    if (n < lo || n > hi) W({code: 'CUT_COUNT_OUT_OF_RANGE', message: `${n} カット（尺 ${total.toFixed(1)} 秒なら目安 ${lo}〜${hi}）`});
    if (data.theme && data.theme !== spec.theme) W({code: 'THEME_MISMATCH', message: `theme ${data.theme}（${spec.id} の推奨は ${spec.theme}）`});
    // rank / shop はブロックの見出しなので無いと構造が崩れる。area は任意なので催促しない
    if ((spec.badge === 'rank' || spec.badge === 'shop') && !cuts.some((c) => c.badge)) W({code: 'BADGE_MISSING', message: `${spec.id} は各ブロック頭に badge を出す`});
  }
  if (data.tate) W({code: 'TATE_PRESENT', message: '常駐縦書き（tate）は基本使わない', fix: {type: 'removeKey', payload: {key: 'tate'}}});
  if (catalog && catalog.dominantFps !== data.fps) W({code: 'FPS_MISMATCH', message: `cuts.fps ${data.fps} ≠ 主力素材の fps ${catalog.dominantFps}`});
  if (ctx.engineStale) W({code: 'ENGINE_STALE', message: '案件の src/*.tsx がマスターテンプレートと差分あり（reel sync）'});

  // ── 画角・被写体の連続 ──────────────────────────────────────
  // **どちらも W（止めない）。** 画角の切り替えは編集の好みで、意図してわざと寄りを続けることがある。
  // 以前は 3 連続以上を E にしていたが、自分で並べた構成でレンダーが止まって邪魔になったため
  // 2026-09-13 に W へ落とした（気づかせるのは続ける／止めるのはやめる）。
  //
  // また **1 つの連続につき 1 件**にまとめる。以前はカットごとに出していたので、
  // 寄りが 13 連続すると同じ内容が 11 件並んで、本当に直すべき指摘が埋もれていた。
  if (catalog) {
    const runs = (pick: (t: NonNullable<Clip['tags']>) => string | undefined) => {
      const out: {from: number; to: number; value: string}[] = [];
      let start = 0;
      for (let i = 1; i <= n; i++) {
        const prevTag = clipOfCut[i - 1]?.tags;
        const curTag = i < n ? clipOfCut[i]?.tags : undefined;
        const prev = prevTag && pick(prevTag);
        const cur = curTag && pick(curTag);
        // 同一素材の連続は「同じ画が続いている」ので別の指摘（SAME_CLIP_*）の担当
        const sameClip = i < n && clipOfCut[i - 1]?.id === clipOfCut[i]?.id;
        const continues = !!prev && !!cur && prev === cur && !sameClip;
        if (continues) continue;
        if (prev && i - start >= 2) out.push({from: start, to: i - 1, value: prev});
        start = i;
      }
      return out;
    };

    for (const r of runs((t) => t.angle)) {
      const len = r.to - r.from + 1;
      W({
        code: 'SAME_ANGLE_RUN',
        cutId: cutLabel(cuts[r.from], r.from),
        cutIndex: r.from,
        message: `同じ画角（${r.value}）が ${len} カット連続（${cutLabel(cuts[r.from], r.from)}〜${cutLabel(cuts[r.to], r.to)}）。引き→寄りで交互にすると見やすい`,
      });
    }
    for (const r of runs((t) => t.subject || undefined)) {
      const len = r.to - r.from + 1;
      if (len < 3) continue;
      W({
        code: 'SAME_SUBJECT_RUN3',
        cutId: cutLabel(cuts[r.from], r.from),
        cutIndex: r.from,
        message: `同一被写体「${r.value}」が ${len} カット連続（${cutLabel(cuts[r.from], r.from)}〜${cutLabel(cuts[r.to], r.to)}）`,
      });
    }
  }

  // ── 構成（フック・リビール・順序） ──
  const firstClip = clipOfCut[0];
  if (brief && brief.materialMode === 'raw' && brief.hook && firstClip && firstClip.id !== brief.hook.clipId)
    E({code: 'HOOK_NOT_USER', cutId: cutLabel(cuts[0], 0), cutIndex: 0, message: `先頭カットが brief.hook（${brief.hook.clipId}）ではなく ${firstClip.id}`});
  if (firstClip?.tags?.signage) E({code: 'HOOK_SIGNAGE', cutId: cutLabel(cuts[0], 0), cutIndex: 0, message: '冒頭フックに店名・看板が映るクリップ（店名は出さない規則）'});
  // エリア名は縦書きの本文ではなく**バッジ**に出す。本文はエリアが無くても意味が通る言い回しにする
  // （「生野区、9割が知らない」→ バッジ「生野区」＋本文「地元の9割が知らない」など）
  const area = brief?.shop.area?.trim() ?? '';
  const hookCut = cuts[0];
  const hookText = groups[0]?.def.text ?? '';
  const hookVertical = (hookCut?.main?.orientation ?? 'vertical') === 'vertical';
  const areaInBadge = !!area && !!hookCut?.badge && hookCut.badge.includes(area);
  if (area && hookVertical && !isPlaceholder(hookText)) {
    const lead = leadingArea(hookText, area);
    if (lead.matched)
      W({
        code: 'HOOK_AREA_IN_TELOP',
        cutId: cutLabel(cuts[0], 0),
        groupId: 'g01',
        cutIndex: 0,
        message: `フックの縦書き本文が「${area}」で始まっています。エリア名はバッジに出し、本文は「${area}」が無くても通る言い回しに（例「地元の${lead.rest}」）`,
      });
  }
  if (persona && (persona.id === 'hiro' || persona.id === 'nagi') && groups.length && !looksLikeAreaDigitHook(hookText, areaInBadge))
    W({code: 'HOOK_TEXT_PATTERN', groupId: 'g01', cutIndex: 0, message: `フックが「エリア名＋一桁数字」型でない: ${hookText}`});
  if (persona && groups.length) {
    const last = groups[groups.length - 1].def.text;
    if (!persona.ctaPatterns.some((p) => last.includes(p))) W({code: 'CTA_TEXT', groupId: `g${String(groups.length).padStart(2, '0')}`, message: `締めテロップが ${persona.label} の語族（${persona.ctaPatterns.join('／')}）でない: ${last}`});
  }

  let revealPct: number | undefined;
  if (spec) {
    // reveal カット: slot role=reveal → 無ければ catalog の signage クリップの最初の出現（末尾2カット内）
    let revealIdx = cuts.findIndex((c) => slotOf(c)?.role === 'reveal');
    if (revealIdx < 0 && catalog) revealIdx = cuts.findIndex((c, i) => i >= n - 2 && clipOfCut[i]?.tags?.signage);
    if (revealIdx >= 0 && total > 0) revealPct = ranges[revealIdx].startSec / total;

    if (spec.reveal === 'late') {
      if (catalog) {
        cuts.forEach((c, i) => {
          if (i < n - 2 && clipOfCut[i]?.tags?.signage)
            E({code: 'F7_SIGNAGE_EARLY', cutId: cutLabel(c, i), cutIndex: i, message: `店名・看板が映るクリップ ${clipOfCut[i]!.id} が最後の2カット以外にある（F7 は終盤に温存）`});
        });
      }
      if (revealPct !== undefined && spec.revealPct) {
        const [lo, hi] = spec.revealPct;
        if (revealPct < 0.6) E({code: 'F7_REVEAL_POSITION', cutIndex: revealIdx, message: `店名リビールが ${(revealPct * 100).toFixed(0)}% 地点（F7 は ${lo * 100}〜${hi * 100}%）`});
        else if (revealPct < lo || revealPct > hi) W({code: 'F7_REVEAL_POSITION', cutIndex: revealIdx, message: `店名リビールが ${(revealPct * 100).toFixed(0)}% 地点（F7 の目安 ${lo * 100}〜${hi * 100}%）`});
      }
      if (revealIdx > 0) {
        const before = cuts[revealIdx - 1];
        const isTease = slotOf(before)?.role === 'tease' || /その名|・・・|…/.test(before.main?.text ?? '');
        if (!isTease) W({code: 'F7_TEASE_MISSING', cutIndex: revealIdx - 1, message: 'リビール直前に焦らしカット（「その名も・・・」等）が無い'});
      }
    } else if (spec.reveal === 'afterProof' && catalog) {
      const hasSignage = catalog.clips.some((c) => c.tags?.signage && !c.user.ng);
      const early = cuts.slice(1, 5).some((_, k) => clipOfCut[k + 1]?.tags?.signage);
      if (hasSignage && !early) W({code: 'REVEAL_MISSING', message: '店名・看板クリップがあるのにカット 2〜5 に無い（②直後に店名リビール）'});
    }
  }

  if (brief?.order.mode === 'fixed' && brief.order.fixed && catalog) {
    // 同じ素材を離れた位置で 2 回使う構成は普通にある（別名コピーで回避したクリップも
    // alias で同じ id に解決される）。id → 位置の Map にすると後勝ちで 1 個に潰れ、
    // 2 回目の位置が基準になって**それ以降が全部「順序違反」に見える**ので、
    // 固定リストを先頭から消化していく方式にする。
    const fixed = brief.order.fixed;
    let cursor = 0;
    cuts.forEach((c, i) => {
      const clip = clipOfCut[i];
      if (!clip) return;
      if (!fixed.includes(clip.id)) return; // 固定リストに無い素材は自由に置ける
      const at = fixed.indexOf(clip.id, cursor);
      // **W（止めない）。** brief.order.fixed は `reel plan` が cuts.json を組み立てるときの
      // *入力*であって、出来上がった構成の正解ではない。自分でタイムラインを並べ替えたあとは
      // ここが食い違うのが当たり前で、E にすると本人の構成でレンダーできなくなる
      // （2026-09-14 に E から落とした。cuts を保存すると固定順は追従して更新される）。
      if (at === -1) W({code: 'ORDER_FIXED_VIOLATION', cutId: cutLabel(c, i), cutIndex: i, message: `並びが brief.order.fixed（AI が決めた順）と違う: ${clip.id}。自分で並べ替えたならこのままでよい`});
      else cursor = at + 1;
    });
  }

  const summary: ValidationSummary = {
    totalSec: Math.round(total * 1000) / 1000,
    totalFrames: calcTotalFrames(data),
    cutCount: n,
    avgCutSec: n ? Math.round((total / n) * 1000) / 1000 : 0,
    groupCount: groups.length,
    revealPct: revealPct === undefined ? undefined : Math.round(revealPct * 1000) / 1000,
    placeholders,
  };
  return {ok: errors.length === 0, errors, warnings, summary, skipped};
}

/** validate 結果を人が読む形に整形（CLI / チャット貼り付け用） */
export const formatValidation = (r: ValidationResult): string => {
  const lines: string[] = [];
  const s = r.summary;
  lines.push(`${r.ok ? 'OK' : 'NG'}  ${s.cutCount} カット / ${s.totalSec}s (${s.totalFrames}f, 平均 ${s.avgCutSec}s) / テロップ ${s.groupCount} グループ${s.revealPct !== undefined ? ` / リビール ${(s.revealPct * 100).toFixed(0)}%` : ''}${s.placeholders ? ` / 未記入 ${s.placeholders}` : ''}`);
  for (const i of r.errors) lines.push(`  E ${i.code}${i.cutId ? ` [${i.cutId}]` : ''} ${i.message}`);
  for (const i of r.warnings) lines.push(`  W ${i.code}${i.cutId ? ` [${i.cutId}]` : ''} ${i.message}`);
  if (r.skipped.length) lines.push(`  (skip: ${r.skipped.join(', ')})`);
  return lines.join('\n');
};
