import {ReelCutsSchema, type ReelCuts} from './schema/reel-cuts';
import {ReelDataSchema, type ReelData} from './schema/cuts';
import {NarrationSchema, type Narration} from './schema/narration';
import {defaultReelCutsConfig, editorToReelCuts, narrationToReelCuts, reelCutsToEditor, reelCutsToNarration, reelCutsToScript, scriptToReelCuts} from './reel-cuts';

export const REEL_DOC_NAMES = ['reelCuts', 'cuts', 'narration', 'script'] as const;
export type ReelDocName = (typeof REEL_DOC_NAMES)[number];
export type ReelBundle = {reelCuts: ReelCuts; cuts: ReelData; narration: Narration; script: {text: string}};

/** Same source and projections in Postgres as on disk; contains metadata only. */
export const updateReelBundle = (name: ReelDocName, input: unknown, current: Partial<Record<ReelDocName, unknown>>, assignId: () => string = () => globalThis.crypto.randomUUID()): ReelBundle => {
  const cfg = defaultReelCutsConfig();
  let cuts = ReelCutsSchema.parse(name === 'reelCuts' ? input : current.reelCuts);
  const previousCuts = current.reelCuts ? ReelCutsSchema.parse(current.reelCuts) : [];
  let editor = current.cuts ? ReelDataSchema.parse(current.cuts) : null;
  let narration = current.narration ? NarrationSchema.parse(current.narration) : null;
  // An absolute original may already have a cached public alias on the PC.
  const source = (clip: string) => {
    const original = previousCuts.find((c) => c.clip_path === clip);
    return editor?.cuts.find((c) => c.id === original?.id)?.src ?? clip;
  };
  if (name === 'cuts') {
    const next = ReelDataSchema.parse(input);
    cuts = editorToReelCuts(next, cuts, cfg, source); editor = next;
  } else if (name === 'narration') {
    const next = NarrationSchema.parse(input);
    cuts = narrationToReelCuts(next, cuts, editor?.fps ?? cfg.render.fps);
    if (next.speed !== narration?.speed && next.speed !== undefined) cuts = ReelCutsSchema.parse(cuts.map((c) => ({...c, speed: next.speed})));
    const previous = narration;
    narration = {...next, segments: next.segments.map((s) => ({...s, reelFingerprint: previous?.segments.find((p) => p.id === s.id)?.reelFingerprint}))};
  } else if (name === 'script') {
    const text = (input as {text?: unknown})?.text;
    if (typeof text !== 'string') throw new Error('text is required');
    cuts = scriptToReelCuts(text, cuts, editor?.fps ?? cfg.render.fps);
  }
  cuts = cuts.map((c) => ({...c, id: c.id ?? assignId()}));
  const projection = reelCutsToEditor(cuts, editor, cfg, source);
  return {reelCuts: cuts, cuts: projection, narration: reelCutsToNarration(cuts, narration, projection.fps), script: {text: reelCutsToScript(cuts, projection.fps)}};
};
