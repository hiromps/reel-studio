import type {Clip, Cut, MainTelopDef, Narration, NarrationSegment, Sfx} from '@shared/schema';

export type EditorClipboard =
  | {version: 1; kind: 'cuts'; project: string; cuts: Cut[]; clips: Clip[]}
  | {version: 1; kind: 'telops'; telops: MainTelopDef[]}
  | {version: 1; kind: 'narr'; project: string; segments: NarrationSegment[]; settings: Narration}
  | {version: 1; kind: 'sfx'; sounds: Sfx[]};

const KEY = 'reel-studio.timeline-clipboard';

export const writeEditorClipboard = (value: EditorClipboard): void => localStorage.setItem(KEY, JSON.stringify(value));

export const readEditorClipboard = (): EditorClipboard | null => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as EditorClipboard | null;
    if (!value || value.version !== 1) return null;
    const items = value.kind === 'cuts' ? value.cuts : value.kind === 'telops' ? value.telops : value.kind === 'narr' ? value.segments : value.kind === 'sfx' ? value.sounds : null;
    if (!Array.isArray(items) || !items.length) return null;
    return value;
  } catch {
    return null;
  }
};
