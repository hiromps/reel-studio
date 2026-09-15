// テスト用の合成 catalog / brief ビルダー
import fs from 'node:fs';
import path from 'node:path';
import {BriefSchema, CatalogSchema, type Brief, type Catalog, type Clip, type ClipKind, type ClipTags} from '@shared/schema';
import {BUILTIN_PERSONAS, PersonaSchema, type Persona} from '@shared/personas';

export const fixtures = path.resolve(__dirname, 'fixtures');
export const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

type ClipSpec = {
  id: string;
  slug: string;
  dur: number;
  kind: ClipKind;
  angle?: ClipTags['angle'];
  signage?: boolean;
  sizzle?: number;
  quality?: number;
  subject?: string;
  speech?: boolean;
  fps?: number;
  ext?: string;
  ranges?: Clip['usableRanges'];
  scenes?: number[];
  speechRanges?: Clip['speech'];
};

export const makeClip = (s: ClipSpec): Clip => ({
  id: s.id,
  original: `IMG_${s.id}.MOV`,
  slug: s.slug,
  src: `uploads/${s.id}_${s.slug}.${s.ext ?? 'mov'}`,
  probe: {codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: s.fps ?? 60, durationSec: s.dur, hasAudio: true, pixFmt: 'yuv420p'},
  thumbs: {sheet: `thumbs/${s.id}.jpg`, strip: []},
  tags: {
    kind: s.kind,
    signage: s.signage ?? s.kind === 'signage',
    signageSize: s.signage || s.kind === 'signage' ? 'large' : 'none',
    angle: s.angle ?? 'mid',
    motion: 'handheld',
    sizzleScore: s.sizzle ?? 3,
    quality: s.quality ?? 4,
    hasSpeech: s.speech ?? false,
    subject: s.subject ?? s.slug,
    description: s.slug,
    source: 'user',
    taggedAt: '2026-09-09T00:00:00.000Z',
  },
  usableRanges: s.ranges ?? [],
  speech: s.speechRanges,
  scenes: s.scenes,
  user: {hook: false, ng: false, orderHint: null, lock: false},
});

export const makeCatalog = (slug: string, clips: Clip[], fps = 60): Catalog =>
  CatalogSchema.parse({
    version: 1,
    slug,
    materialsDir: `uploads/${slug}`,
    dominantFps: fps,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    facts: [],
    clips,
  });

export const makeBrief = (over: Partial<Brief> & Pick<Brief, 'persona'>): Brief =>
  BriefSchema.parse({
    version: 1,
    shop: {name: 'テスト食堂', area: '東大阪', genre: '定食', pr: false},
    materialMode: 'raw',
    core: '東大阪にある、看板の一皿が異常にうまい店',
    ...over,
  });

/** 汎用の素材セット：外観・看板・店内・調理・提供・実食・シズル・小物・人物 */
export const richClips = (): Clip[] => [
  makeClip({id: '01', slug: 'gaikan', dur: 2.9, kind: 'exterior', angle: 'wide', sizzle: 2, subject: '外観'}),
  makeClip({id: '02', slug: 'naikan-wide', dur: 2.6, kind: 'interior', angle: 'wide', sizzle: 2, subject: '店内'}),
  makeClip({id: '03', slug: 'customer-enter', dur: 1.6, kind: 'person', angle: 'mid', sizzle: 2, subject: '客'}),
  makeClip({id: '04', slug: 'door-knob', dur: 1.6, kind: 'detail', angle: 'close', sizzle: 2, subject: 'ノブ'}),
  makeClip({id: '05', slug: 'vip-plate', dur: 2.0, kind: 'detail', angle: 'close', sizzle: 2, subject: 'プレート'}),
  makeClip({id: '06', slug: 'clock', dur: 1.4, kind: 'detail', angle: 'close', sizzle: 1, subject: '時計'}),
  makeClip({id: '08', slug: 'teapots-shelf', dur: 6.1, kind: 'interior', angle: 'mid', sizzle: 3, subject: 'ポット棚'}),
  makeClip({id: '09', slug: 'cup-strainer', dur: 2.3, kind: 'detail', angle: 'close', sizzle: 3, subject: 'カップ'}),
  makeClip({id: '10', slug: 'teapot-closeup', dur: 2.0, kind: 'detail', angle: 'close', sizzle: 3, subject: 'ポット'}),
  makeClip({id: '11', slug: 'tea-pour', dur: 9.9, kind: 'sizzle', angle: 'close', sizzle: 5, subject: '紅茶', ranges: [{inSec: 2.0, outSec: 4.5, label: 'best'}, {inSec: 5.0, outSec: 9.5, label: 'ok'}]}),
  makeClip({id: '12', slug: 'tea-cup-wide', dur: 5.5, kind: 'serving', angle: 'mid', sizzle: 4, subject: '紅茶'}),
  makeClip({id: '13', slug: 'eggbenedict-plate', dur: 1.75, kind: 'serving', angle: 'close', sizzle: 4, subject: 'エッグベネディクト'}),
  makeClip({id: '14', slug: 'table-wide', dur: 2.75, kind: 'serving', angle: 'wide', sizzle: 3, subject: 'テーブル'}),
  makeClip({id: '15', slug: 'bangers-plate', dur: 2.4, kind: 'serving', angle: 'close', sizzle: 4, subject: 'ソーセージ'}),
  makeClip({id: '16', slug: 'yolk-cut', dur: 6.0, kind: 'eating', angle: 'close', sizzle: 5, subject: '黄身'}),
  makeClip({id: '17', slug: 'scone-hold', dur: 3.4, kind: 'eating', angle: 'mid', sizzle: 4, subject: 'スコーン'}),
  makeClip({id: '18', slug: 'yolk-macro', dur: 2.6, kind: 'sizzle', angle: 'close', sizzle: 5, subject: '黄身'}),
  makeClip({id: '19', slug: 'signboard', dur: 2.3, kind: 'signage', angle: 'mid', sizzle: 2, signage: true, subject: '看板'}),
  makeClip({id: '20', slug: 'tea-tins', dur: 1.6, kind: 'detail', angle: 'mid', sizzle: 3, subject: '紅茶缶'}),
  makeClip({id: '21', slug: 'milk-pour', dur: 2.0, kind: 'sizzle', angle: 'close', sizzle: 4, subject: 'ミルク'}),
  makeClip({id: '22', slug: 'table-hand', dur: 2.9, kind: 'serving', angle: 'wide', sizzle: 3, subject: 'テーブル'}),
];

// ── 人格 ──
// 同梱のサンプル人格をベースに、テスト用にボイス id を入れたもの。id は 'standard' / 'discovery' / 'casual'
export const makePersona = (over: Partial<Persona> & {id: string}): Persona => PersonaSchema.parse({...BUILTIN_PERSONAS[0], ...over});
const builtin = (id: string): Persona => BUILTIN_PERSONAS.find((p) => p.id === id)!;
export const TEST_PERSONAS = {
  standard: makePersona({...builtin('standard'), narration: {...builtin('standard').narration, voiceId: '0'.repeat(32), voiceTitle: 'テスト男性'}}),
  discovery: makePersona({...builtin('discovery'), narration: {...builtin('discovery').narration, voiceId: '1'.repeat(32), voiceTitle: 'テスト落ち着き'}}),
  casual: makePersona({...builtin('casual'), narration: {...builtin('casual').narration, voiceId: '2'.repeat(32), voiceTitle: 'テスト女性'}, caption: {hashtags: 5, repostAccount: 'example_account', maxChars: 0}}),
};
