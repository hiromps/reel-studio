import {z} from 'zod';
import bundledConfig from './config/oc-eat.json';
import {ReelCutsSchema, ReelSlotSchema, ReelSpeechSchema, type ReelCut, type ReelCuts} from './schema/reel-cuts';
import {CutSchema, ThemeSchema, type ReelData} from './schema/cuts';
import {NarrationSchema, type Narration} from './schema/narration';
import {stableHash} from './hash';
import {defaultEmotionTags, fishEmotionTag, type EmotionTags} from './emotion-tags';

const tag = z.string().refine((v) => v === '' || /^\[[^\[\]\r\n]+\]$/.test(v));
export const ReelCutsConfigSchema = z.object({
  version: z.literal(1),
  render: z.object({fps: z.number().finite().positive(), theme: ThemeSchema}).strict(),
  defaults: ReelSpeechSchema.extend({slot: ReelSlotSchema, duration: z.number().finite().positive()}).strict(),
  fish: z.object({
    supported_models: z.array(z.enum(['s2-pro', 's2.1-pro', 's2.1-pro-free'])).min(1),
    intensity_tags: z.object({'1': tag, '2': tag, '3': tag, '4': tag, '5': tag}).strict(),
    emphasis_tag: tag.refine(Boolean),
    chunk_length: z.number().int().min(100).max(300), normalize: z.boolean(), volume: z.number().finite(),
  }).strict(),
}).strict().refine((c) => c.defaults.pause_after < c.defaults.duration, 'Default pause must be shorter than duration');
export type ReelCutsConfig = z.infer<typeof ReelCutsConfigSchema>;
export const defaultReelCutsConfig = (): ReelCutsConfig => ReelCutsConfigSchema.parse(bundledConfig);
export const createReelCut = (clip_path: string, config = defaultReelCutsConfig(), values: Partial<ReelCut> = {}): ReelCut =>
  ReelCutsSchema.parse([{...config.defaults, clip_path, start: 0, ...values}])[0];

/** Local application metadata, never a made-up Fish request parameter. */
export const reelSpeechFingerprint = (cut: ReelCut): string => stableHash({line: cut.line, intensity: cut.intensity, emotion_tag: cut.emotion_tag, speed: cut.speed, emphasis: cut.emphasis});
const framesOf = (cut: ReelCut, fps: number) => {
  const rate = cut.editor?.playbackRate ?? 1;
  // Match the renderer's subtraction and rounding, including floating-point ties.
  return Math.max(1, Math.round((((cut.start + cut.duration * rate) - cut.start) / rate) * fps));
};

export const reelCutsToEditor = (cuts: ReelCuts, base: ReelData | null, config: ReelCutsConfig, resolve: (clip: string) => string = (v) => v): ReelData => ({
  ...base, fps: base?.fps ?? config.render.fps, theme: base?.theme ?? config.render.theme,
  cuts: cuts.map((c) => ({...c.editor, id: c.id, emotion_tag: c.emotion_tag, src: resolve(c.clip_path), inSec: c.start, outSec: c.start + c.duration * (c.editor?.playbackRate ?? 1)})),
});

export const editorToReelCuts = (editor: ReelData, previous: ReelCuts, config: ReelCutsConfig, resolve: (clip: string) => string = (v) => v): ReelCuts => ReelCutsSchema.parse(editor.cuts.map((c) => {
  const old = previous.find((r) => r.id === c.id);
  const {id, src, inSec, outSec, emotion_tag, ...style} = c;
  return {...(old ?? createReelCut(src, config)), id, clip_path: old && src === resolve(old.clip_path) ? old.clip_path : src,
    start: inSec, duration: (outSec - inSec) / (c.playbackRate ?? 1), emotion_tag: emotion_tag === undefined ? old?.emotion_tag ?? null : emotion_tag, editor: CutSchema.omit({id: true, src: true, inSec: true, outSec: true, emotion_tag: true}).strip().parse(style)};
}));

export const reelCutsToNarration = (cuts: ReelCuts, base: Narration | null, fps = defaultReelCutsConfig().render.fps): Narration => {
  let frame = 0;
  const segments: Narration['segments'] = [];
  for (const cut of cuts) {
    if (!cut.id) throw new Error('Save reel-cuts.json before generating narration (missing cut id)');
    const old = base?.segments.find((s) => s.id === `oc_${cut.id}`);
    const fingerprint = reelSpeechFingerprint(cut);
    if (cut.line.trim()) {
      const unchanged = old?.reelFingerprint === fingerprint;
      const budget = framesOf(cut, fps) / fps - cut.pause_after;
      if (budget <= 0) throw new Error(`${cut.id}: フレーム丸め後のカット尺に発話枠がありません。duration または pause_after を調整してください`);
      segments.push({...old, id: `oc_${cut.id}`, label: cut.slot, at: frame / fps, text: cut.line,
        intensity: cut.intensity, emotion_tag: cut.emotion_tag, speed: cut.speed, pause_after: cut.pause_after, emphasis: cut.emphasis,
        reelFingerprint: fingerprint, needsTts: !unchanged || old?.needsTts === true,
        durSec: unchanged ? old?.durSec : undefined, trimSec: budget});
    }
    frame += framesOf(cut, fps);
  }
  // Disk, HTTP and DB hashes must see the same JSON (no undefined properties).
  return NarrationSchema.parse(JSON.parse(JSON.stringify({...base, voice: base?.voice ?? '', videoSec: frame / fps, segments})));
};

/** The speech editor updates the same array. Timing stays owned by video cuts. */
export const narrationToReelCuts = (narration: Narration, cuts: ReelCuts, fps = defaultReelCutsConfig().render.fps): ReelCuts => {
  const ids = new Set(cuts.map((c) => `oc_${c.id}`));
  if (narration.segments.some((s) => !ids.has(s.id))) throw new Error('共通カット案件では音声ブロックの追加は reel-cuts.json で行ってください');
  let frame = 0;
  for (const cut of cuts) {
    const seg = narration.segments.find((s) => s.id === `oc_${cut.id}`);
    if (seg && (Math.abs(seg.at - frame / fps) > 1e-6 || (seg.trimSec !== undefined && Math.abs(seg.trimSec - (framesOf(cut, fps) / fps - cut.pause_after)) > 1e-6))) {
      throw new Error('共通カット案件の音声配置・発話枠はカットの尺と pause_after で調整してください');
    }
    frame += framesOf(cut, fps);
  }
  return ReelCutsSchema.parse(cuts.map((c) => {
    const seg = narration.segments.find((s) => s.id === `oc_${c.id}`);
    if (!seg) return {...c, line: '', emphasis: []};
    const line = seg.text;
    return {...c, line,
      intensity: seg.intensity ?? c.intensity, emotion_tag: seg.emotion_tag === undefined ? c.emotion_tag : seg.emotion_tag,
      speed: seg.speed ?? c.speed, pause_after: seg.pause_after ?? c.pause_after,
      emphasis: (seg.emphasis as string[] | undefined ?? c.emphasis).filter((word) => line.includes(word))};
  }));
};

export const reelCutsToScript = (cuts: ReelCuts, fps = defaultReelCutsConfig().render.fps): string => {
  let frame = 0;
  return cuts.map((c) => {
    const head = `【${Number((frame / fps).toFixed(6))}〜${Number(((frame + framesOf(c, fps)) / fps).toFixed(6))}秒】${c.slot}`;
    frame += framesOf(c, fps);
    return `${head}\n<!-- reel-cut:${c.id} -->\nナレーションJSON: ${JSON.stringify(c.line)}`;
  }).join('\n\n') + '\n';
};

export const scriptToReelCuts = (text: string, cuts: ReelCuts, fps = defaultReelCutsConfig().render.fps): ReelCuts => {
  const blocks = [...text.matchAll(/<!-- reel-cut:([A-Za-z0-9_-]+) -->\s*\r?\nナレーションJSON: ([^\r\n]*)/g)];
  if (blocks.length !== cuts.length || blocks.some((b, i) => b[1] !== cuts[i].id)) throw new Error('共通台本のカットIDと順序は保持してください。構成は reel-cuts.json または編集画面で変更できます');
  const next = ReelCutsSchema.parse(cuts.map((c, i) => {
    const line: unknown = JSON.parse(blocks[i][2]);
    return {...c, line, emphasis: c.emphasis.filter((w) => typeof line === 'string' && line.includes(w))};
  }));
  // Do not silently discard edits to headings, duration or unrecognized text.
  if (text.replace(/\r\n/g, '\n').trim() !== reelCutsToScript(next, fps).trim()) throw new Error('共通台本ではナレーションJSONの文字列を編集してください。尺・スロットは共通JSONで変更します');
  return next;
};

/** S2 tags are text markers; pause is reserved locally, never sent as fake API fields. */
export const reelFishText = (cut: Pick<ReelCut, 'line' | 'intensity' | 'emotion_tag' | 'emphasis'>, config: ReelCutsConfig, emotions: EmotionTags = defaultEmotionTags()): string => {
  const words = [...new Set(cut.emphasis)].sort((a, b) => b.length - a.length);
  let text = '';
  for (let i = 0; i < cut.line.length;) {
    const word = words.find((w) => cut.line.startsWith(w, i));
    if (word) {text += config.fish.emphasis_tag + word; i += word.length;}
    else {text += cut.line[i]; i++;}
  }
  // Preserve legacy bracket combinations. Fixed IDs always take precedence over intensity.
  const legacy = typeof cut.emotion_tag === 'string' && cut.emotion_tag.startsWith('[');
  const prefix = (legacy ? config.fish.intensity_tags[String(cut.intensity) as '1'] : '') + fishEmotionTag(cut.emotion_tag, emotions);
  return prefix + (prefix && !legacy ? ' ' : '') + text;
};
