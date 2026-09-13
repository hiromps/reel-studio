// 人格（persona）ごとの既定値。単一ソース。スキル文書の数値と食い違ったらこちらを正とする。
import type {FormatId, PersonaId} from './schema/brief';
import type {ThemeName} from './schema/cuts';

export type Persona = {
  id: PersonaId;
  label: string;
  defaultFormat: FormatId;
  theme: ThemeName;
  /** 締めテロップの既定文（先頭が draft に使われる） */
  cta: string[];
  /** 締めテロップとして認める語族（validate の CTA_TEXT 判定） */
  ctaPatterns: string[];
  narration: {
    voiceId: string;
    voiceTitle: string;
    speed: number;
    /** 文字数設計に使う値（ブロック秒数 × charsPerSec が上限） */
    charsPerSec: number;
    /** 参考：実測話速 */
    charsPerSecMeasured: number;
  };
  tone: string;
  skillDir: string;
  /** キャプション（SKILL.md Step 4）の、コード側で機械的に点検できる部分だけ */
  caption: {
    /** ハッシュタグの本数（ちょうどこの数） */
    hashtags: number;
    /** 「他の投稿はコチラ」で誘導する自分のアカウント。無ければその行を書かない */
    repostAccount?: string;
    /** 長さの目安（文字）。0 = 上限なし */
    maxChars: number;
  };
  /** F7 の店名リビールグループを空テロップにしてよい（凪：店名を文字で書かない） */
  allowEmptyReveal: boolean;
};

export const PERSONAS: Record<PersonaId, Persona> = {
  hiro: {
    id: 'hiro',
    label: 'hiro（oc.eat）',
    defaultFormat: 'F0',
    theme: 'pop',
    cta: ['ぜひ行ってみて'],
    ctaPatterns: ['行ってみて', '詳細はキャプションへ'],
    narration: {
      voiceId: '29796a4f8d0948de9e7f0afcf6dc42ca',
      voiceTitle: 'hiro音声',
      speed: 1.6,
      charsPerSec: 11.0,
      charsPerSecMeasured: 11.3,
    },
    tone: '関西弁控えめの男性口調。「〜わ」「〜んや。」言い切り禁止',
    skillDir: '.claude/skills/hiro-daihon',
    caption: {hashtags: 3, maxChars: 600},
    allowEmptyReveal: false,
  },
  nagi: {
    id: 'nagi',
    label: '凪（発見型）',
    defaultFormat: 'F7',
    theme: 'human',
    cta: ['これは布教したい'],
    ctaPatterns: ['布教', '教えたくない', '通いたい', '行くしかない', '行ってみて'],
    narration: {
      voiceId: '45c5d3723c9c42f598e4776dcfd5f02d',
      voiceTitle: '落ち着いた男性',
      speed: 1.6,
      charsPerSec: 7.5,
      charsPerSecMeasured: 8.4,
    },
    tone: '標準語・体言止めの短文。オタク語彙は1台本2〜3語まで',
    skillDir: '.claude/skills/nagi-daihon',
    caption: {hashtags: 3, maxChars: 600},
    allowEmptyReveal: true,
  },
  sayuri: {
    id: 'sayuri',
    label: 'さゆり',
    defaultFormat: 'F0',
    theme: 'pop',
    cta: ['行ってみてな'],
    ctaPatterns: ['行ってみて', '詳細はキャプションへ'],
    narration: {
      // 「さいちゃん」（8656b0cad5cc429bb01c7f01fee0160c）は 2026-09-12 に Fish Audio から消えた（API が 404）。
      // ユーザー判断で **sayuri は当面使わない**ので空のままにしてある。
      // 空だと音声生成が「ボイスが未設定です」で止まる＝黙って別の声で作ってしまう事故が起きない。
      // 再開するときは新しい reference_id をここに入れる（話速の実測もやり直すこと）
      voiceId: '',
      voiceTitle: '（未設定・当面使わない）',
      speed: 1.5,
      charsPerSec: 9.0,
      charsPerSecMeasured: 9.0,
    },
    tone: '砕けた関西弁・女性。テロップの「〜わ」はOK、ナレーションでは使わない',
    skillDir: '.claude/skills/sayuri-daihon',
    caption: {hashtags: 5, repostAccount: 'gurupo_chan_', maxChars: 0},
    allowEmptyReveal: false,
  },
  bonjiri: {
    id: 'bonjiri',
    label: 'ぼんじり（bonjiri_gourmet）',
    defaultFormat: 'F0',
    theme: 'pop',
    cta: ['これは布教したい'],
    ctaPatterns: ['布教', '行ってみて'],
    narration: {
      voiceId: 'a0b4c6375b4c4ebc85f807d01efd0075',
      voiceTitle: 'んーちゃん',
      speed: 1.6,
      charsPerSec: 8.2,
      charsPerSecMeasured: 8.2,
    },
    tone: 'コミカル／オタク寄り。「〜わ」「〜んや。」言い切りは使わない',
    skillDir: '.claude/skills/bonjiri-daihon',
    caption: {hashtags: 3, maxChars: 600},
    allowEmptyReveal: false,
  },
};

export const getPersona = (id: PersonaId): Persona => PERSONAS[id];
