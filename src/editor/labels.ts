// 画面に出す日本語ラベル（Materials と編集画面で共用）。
import type {ClipKind, SlotRole} from '@shared/schema';

export const KIND_LABEL: Record<ClipKind, string> = {
  exterior: '外観',
  signage: '看板・店名',
  interior: '店内',
  menu: 'メニュー',
  cooking: '調理',
  serving: '提供・登場',
  eating: '実食',
  sizzle: 'シズル',
  person: '人物',
  conversation: '会話',
  detail: '小物',
  other: 'その他',
};

export const ROLE_LABEL: Record<SlotRole, string> = {
  hook: 'フック',
  proof: '証拠',
  tease: '焦らし',
  reveal: 'リビール',
  sizzle: 'シズル',
  info: '情報',
  conversation: '会話',
  badgeHead: '見出し',
  cta: 'CTA',
  filler: 'つなぎ',
};

/** テロップグループの色（絵コンテ・テロップ段・カット行で共通） */
export const GROUP_COLORS = ['#6bb0ff', '#ffd966', '#4cc38a', '#f0a941', '#c77dff', '#ff6b6b', '#5ad1d1', '#a3e635'];

/** バッジ下地の濃さの既定値。エンジン（telops.tsx の LAYOUT.badgeBgAlpha）と揃える */
export const BADGE_OPACITY_DEFAULT = 0.6;
