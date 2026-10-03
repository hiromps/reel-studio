// 人格を AI で磨く：プロンプト・AI の案の重ね方（shared/persona-refine.ts）と、フックの方針の書き出し（shared/personas.ts）。
// claude には繋がない。
import {describe, expect, it} from 'vitest';
import {
  applyPersonaRefine,
  buildPersonaRefinePrompt,
  PERSONA_REFINE_SCHEMA,
  PersonaRefineDraftSchema,
  REFINABLE_KEYS,
  refinedKeys,
  type PersonaRefineDraft,
} from '@shared/persona-refine';
import {hookRuleLines, PersonaSchema} from '@shared/personas';
import {JOB_TYPES, PROJECTLESS_JOBS, isHeavyJob} from '@shared/jobs';
import {makePersona} from './helpers';

const base = makePersona({
  id: 'hiro',
  label: 'hiro（oc.eat）',
  tone: '関西弁控えめの男性口調',
  hookStyle: 'areaDigit',
  narrationRules: ['語尾に「〜わ」を使わない'],
  cta: ['ぜひ行ってみて'],
  ctaPatterns: ['行ってみて'],
  narration: {voiceId: 'a'.repeat(32), voiceTitle: 'hiro音声', speed: 1.2, charsPerSec: 8.2, charsPerSecMeasured: 8.5},
  caption: {hashtags: 3, maxChars: 600, repostAccount: 'oc.eat'},
});

/** 今の人格をそのまま返した案（ここから一部だけ変える） */
const sameAs = (p = base, over: Partial<PersonaRefineDraft> = {}): PersonaRefineDraft => ({
  tone: p.tone,
  hookStyle: p.hookStyle,
  hookRules: p.hookRules,
  narrationRules: p.narrationRules,
  cta: p.cta,
  ctaPatterns: p.ctaPatterns,
  captionGuide: p.captionGuide,
  hashtagBank: p.hashtagBank,
  changes: [],
  samples: [],
  ...over,
});

describe('人格のフックの方針', () => {
  it('古い personas.json（hookRules が無い）も読める', () => {
    const {hookRules: _drop, ...old} = base;
    expect(PersonaSchema.parse(old).hookRules).toEqual([]);
  });

  it('方針が無ければプロンプトに行を足さない', () => {
    expect(hookRuleLines(base)).toEqual([]);
  });

  it('方針は見出し＋1 行 1 条で入る。対象と行頭は呼び出し側で変えられる', () => {
    const p = {...base, hookRules: ['ターゲットを狭めない', '専門用語を使わない']};
    expect(hookRuleLines(p)).toEqual(['- フック（冒頭）の書き方の方針（人格の設定・優先して守る）:', '  - ターゲットを狭めない', '  - 専門用語を使わない']);
    expect(hookRuleLines(p, 'フックのナレーション', '')[0]).toBe('フックのナレーションの書き方の方針（人格の設定・優先して守る）:');
  });
});

describe('人格を AI で磨く', () => {
  it('claude に渡す形と読む形の項目が一致する', () => {
    const keys = Object.keys(PersonaRefineDraftSchema.shape).sort();
    expect([...PERSONA_REFINE_SCHEMA.required].sort()).toEqual(keys);
    expect(Object.keys(PERSONA_REFINE_SCHEMA.properties).sort()).toEqual(keys);
  });

  it('プロンプトに指示と今の値が入る', () => {
    const prompt = buildPersonaRefinePrompt({persona: {...base, hookRules: ['数字で始める']}, instruction: 'フックはターゲットを広く'});
    expect(prompt).toContain('フックはターゲットを広く');
    expect(prompt).toContain('- 数字で始める');
    expect(prompt).toContain('areaDigit');
    expect(prompt).toContain('関西弁控えめの男性口調');
    expect(prompt).toContain('指示に関係する項目だけ変える');
  });

  it('スキルフォルダのある人格は、投稿文の型を渡さず「そのまま返す」と伝える', () => {
    const prompt = buildPersonaRefinePrompt({persona: {...base, skillDir: 'C:/skills/hiro', captionGuide: '秘密の型'}, instruction: 'x'});
    expect(prompt).not.toContain('秘密の型');
    expect(prompt).toContain('外部のスキルフォルダ');
  });

  it('書き直してよい項目だけ差し替え、ボイス・話速・id・誘導アカウントは元のまま', () => {
    const after = applyPersonaRefine(base, sameAs(base, {hookStyle: 'free', hookRules: [' ターゲットを狭めない ', 'ターゲットを狭めない', ''], changes: ['フックの方針を足した']}));
    expect(after.hookStyle).toBe('free');
    expect(after.hookRules).toEqual(['ターゲットを狭めない']);
    expect(after.id).toBe('hiro');
    expect(after.label).toBe(base.label);
    expect(after.narration).toEqual(base.narration);
    expect(after.caption).toEqual(base.caption);
    expect(after.defaultFormat).toBe(base.defaultFormat);
    expect(refinedKeys(base, after)).toEqual(['hookStyle', 'hookRules']);
  });

  it('締めが空で返ってきたら元の締めを残す', () => {
    const after = applyPersonaRefine(base, sameAs(base, {cta: [], ctaPatterns: ['  ']}));
    expect(after.cta).toEqual(base.cta);
    expect(after.ctaPatterns).toEqual(base.ctaPatterns);
  });

  it('スキルフォルダのある人格は、AI が投稿文の型を返しても元の値を残す', () => {
    const p = {...base, skillDir: 'C:/skills/hiro', captionGuide: '', hashtagBank: ''};
    const after = applyPersonaRefine(p, sameAs(p, {captionGuide: '勝手に書いた型', hashtagBank: '勝手なタグ'}));
    expect(after.captionGuide).toBe('');
    expect(after.hashtagBank).toBe('');
    expect(after.skillDir).toBe('C:/skills/hiro');
  });

  it('何も変えない案なら、変わった項目は空', () => {
    expect(refinedKeys(base, applyPersonaRefine(base, sameAs()))).toEqual([]);
    expect(REFINABLE_KEYS).toContain('hookRules');
  });

  it('ai-persona-refine は案件に属さない軽いジョブ', () => {
    expect(JOB_TYPES).toContain('ai-persona-refine');
    expect(PROJECTLESS_JOBS.has('ai-persona-refine')).toBe(true);
    expect(isHeavyJob('ai-persona-refine')).toBe(false);
  });
});
